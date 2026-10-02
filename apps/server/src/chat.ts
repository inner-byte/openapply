/**
 * Chat threads and streaming over the app's own store.
 *
 * Replaces the former runtime agent endpoint and cloud thread storage:
 * threads and messages live in
 * the app's own database, and `POST /api/chat/stream` streams AG-UI events as
 * Server-Sent Events from the selected agent.
 *
 * Wire contract (the mobile client builds against this):
 * - SSE `data:` lines are JSON AG-UI events per `@ag-ui/core`.
 * - Tool calls that need a human emit `{ type: "CUSTOM",
 *   name: "approval-request", value: { runId, toolCallId, toolName, args } }`
 *   and pause the run until `POST /api/chat/approve` decides them.
 */
import { randomUUID } from "node:crypto";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import type { Hono } from "hono";
import { z } from "zod";
import { type ApprovalGate, agentConfigured, selectAgent } from "./agent.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import type { DomainService } from "./domain.ts";
import type { AgentService } from "./engine/service.ts";
import { type ApprovalRequest, CHAT_PROVIDER_CONTEXT } from "./engine/tanstack-agent.ts";
import { AppError } from "./errors.ts";
import type { ModelAccounts } from "./models.ts";

const THREAD_KIND = "chat-thread";
const MESSAGE_KIND = "chat-message";
const APPROVAL_KIND = "chat-approval";

const DEFAULT_THREAD_NAME = "New chat";
const THREAD_LIST_LIMIT = 50;
const THREAD_LIST_MAX = 200;
/** A run left waiting for approval is denied after this long so waiters cannot leak. */
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;

export interface ChatThread {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface ChatApprovalRecord {
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  threadId: string;
  status: "pending" | "decided";
  decision?: boolean;
  createdAt: string;
  decidedAt?: string;
}

export interface PendingApproval {
  runId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  threadId: string;
  createdAt: string;
}

const publicThread = (thread: ChatThread) => ({
  id: thread.id,
  name: thread.name,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  archived: thread.archived,
});

const publicMessage = (message: ChatMessage) => ({
  id: message.id,
  role: message.role,
  content: message.content,
  createdAt: message.createdAt,
});

/** Get-or-create a thread record. Safe under concurrent creation. */
export async function ensureThread(
  db: Store,
  owner: string,
  threadId: string,
  name: string = DEFAULT_THREAD_NAME,
): Promise<ChatThread> {
  const existing = await db.get<ChatThread>(owner, THREAD_KIND, threadId);
  if (existing) return existing;
  const now = new Date().toISOString();
  await db.insertIfAbsent(owner, THREAD_KIND, {
    id: threadId,
    name,
    createdAt: now,
    updatedAt: now,
    archived: false,
  });
  return (
    (await db.get<ChatThread>(owner, THREAD_KIND, threadId)) ?? {
      id: threadId,
      name,
      createdAt: now,
      updatedAt: now,
      archived: false,
    }
  );
}

async function touchThread(db: Store, owner: string, thread: ChatThread): Promise<void> {
  await db.put(owner, THREAD_KIND, { ...thread, updatedAt: new Date().toISOString() });
}

async function listMessages(db: Store, owner: string, threadId: string): Promise<ChatMessage[]> {
  const all = await db.list<ChatMessage>(owner, MESSAGE_KIND);
  return all
    .filter((message) => message.threadId === threadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * Durable human-approval gate for chat tool calls.
 *
 * `requestApproval` persists the pending approval, then parks the tool
 * executor until `decide` resolves it (or the run aborts, or the timeout
 * denies it). Approvals decided after a server restart — where the parked
 * executor no longer exists — report as stale so the client gets a 410.
 */
export class ChatApprovals implements ApprovalGate {
  private readonly waiters = new Map<
    string,
    { owner: string; resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(private readonly db: Store) {}

  private key(runId: string, toolCallId: string) {
    return `${runId}:${toolCallId}`;
  }

  async requestApproval(
    owner: string,
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<boolean> {
    const key = this.key(request.runId, request.toolCallId);
    const now = new Date().toISOString();
    await this.db.put(owner, APPROVAL_KIND, {
      id: key,
      runId: request.runId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      args: request.args,
      threadId: request.threadId,
      status: "pending",
      createdAt: now,
    } satisfies ChatApprovalRecord);
    return new Promise<boolean>((resolve) => {
      const done = (approved: boolean) => {
        const waiter = this.waiters.get(key);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.waiters.delete(key);
        }
        resolve(approved);
      };
      const timer = setTimeout(() => {
        void this.db
          .put(owner, APPROVAL_KIND, {
            id: key,
            runId: request.runId,
            toolCallId: request.toolCallId,
            toolName: request.toolName,
            args: request.args,
            threadId: request.threadId,
            status: "decided",
            decision: false,
            createdAt: now,
            decidedAt: new Date().toISOString(),
          } satisfies ChatApprovalRecord)
          .catch(() => {});
        done(false);
      }, APPROVAL_TIMEOUT_MS);
      // A parked approval must never keep the process alive on its own.
      timer.unref?.();
      this.waiters.set(key, { owner, resolve: done, timer });
      if (signal.aborted) done(false);
      else signal.addEventListener("abort", () => done(false), { once: true });
    });
  }

  /** Resolve a parked approval. Returns false when no live run is waiting. */
  async decide(
    owner: string,
    runId: string,
    toolCallId: string,
    approved: boolean,
  ): Promise<boolean> {
    const key = this.key(runId, toolCallId);
    const waiter = this.waiters.get(key);
    if (!waiter || waiter.owner !== owner) return false;
    const record = await this.db.get<ChatApprovalRecord>(owner, APPROVAL_KIND, key);
    const decidedAt = new Date().toISOString();
    await this.db.put(owner, APPROVAL_KIND, {
      id: key,
      runId,
      toolCallId,
      toolName: record?.toolName ?? "unknown",
      args: record?.args ?? null,
      threadId: record?.threadId ?? "",
      status: "decided",
      decision: approved,
      createdAt: record?.createdAt ?? decidedAt,
      decidedAt,
    } satisfies ChatApprovalRecord);
    waiter.resolve(approved);
    return true;
  }

  async pending(owner: string, threadId?: string): Promise<PendingApproval[]> {
    const all = await this.db.list<ChatApprovalRecord>(owner, APPROVAL_KIND);
    return all
      .filter(
        (record) => record.status === "pending" && (!threadId || record.threadId === threadId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((record) => ({
        runId: record.runId,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        args: record.args,
        threadId: record.threadId,
        createdAt: record.createdAt,
      }));
  }
}

export function registerChatRoutes(
  app: Hono<{ Variables: { owner: string } }>,
  db: Store,
  config: Config,
  service: AgentService,
  modelAccounts: ModelAccounts,
  domain: DomainService,
  approvals: ChatApprovals,
) {
  app.get("/api/threads", async (c) => {
    const owner = c.get("owner");
    const rawLimit = Number(c.req.query("limit"));
    const limit = Number.isInteger(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), THREAD_LIST_MAX)
      : THREAD_LIST_LIMIT;
    const includeArchived = c.req.query("includeArchived") === "true";
    const threads = (await db.list<ChatThread>(owner, THREAD_KIND))
      .filter((thread) => includeArchived || !thread.archived)
      .sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt),
      )
      .slice(0, limit);
    return c.json({ threads: threads.map(publicThread) });
  });

  app.post("/api/threads", async (c) => {
    const owner = c.get("owner");
    const raw = await c.req.json().catch(() => ({}));
    const body = z.object({ name: z.string().trim().min(1).max(120).optional() }).parse(raw);
    const thread = await ensureThread(db, owner, randomUUID(), body.name ?? DEFAULT_THREAD_NAME);
    return c.json({ thread: publicThread(thread) }, 201);
  });

  app.get("/api/threads/:id/messages", async (c) => {
    const owner = c.get("owner");
    const thread = await db.get<ChatThread>(owner, THREAD_KIND, c.req.param("id"));
    if (!thread) throw new AppError("Thread not found", 404);
    return c.json({ messages: (await listMessages(db, owner, thread.id)).map(publicMessage) });
  });

  app.patch("/api/threads/:id", async (c) => {
    const owner = c.get("owner");
    const thread = await db.get<ChatThread>(owner, THREAD_KIND, c.req.param("id"));
    if (!thread) throw new AppError("Thread not found", 404);
    const body = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        archived: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const updated: ChatThread = {
      ...thread,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.archived !== undefined ? { archived: body.archived } : {}),
      updatedAt: new Date().toISOString(),
    };
    await db.put(owner, THREAD_KIND, updated);
    return c.json({ thread: publicThread(updated) });
  });

  app.delete("/api/threads/:id", async (c) => {
    const owner = c.get("owner");
    const thread = await db.get<ChatThread>(owner, THREAD_KIND, c.req.param("id"));
    if (!thread) throw new AppError("Thread not found", 404);
    await db.remove(owner, THREAD_KIND, thread.id);
    for (const message of await listMessages(db, owner, thread.id))
      await db.remove(owner, MESSAGE_KIND, message.id);
    return c.body(null, 204);
  });

  app.post("/api/chat/stream", async (c) => {
    if (!agentConfigured(config))
      throw new AppError(
        "Configure a model and provider API key, or a valid AG-UI endpoint, to start chat",
        503,
      );
    const body = z
      .object({
        threadId: z.string().min(1).max(200),
        message: z.object({
          id: z.string().min(1).max(200),
          role: z.literal("user"),
          content: z.string().min(1).max(200000),
        }),
        provider: z
          .object({ provider: z.string().min(1).max(120), model: z.string().max(200).optional() })
          .nullable()
          .optional(),
      })
      .parse(await c.req.json());
    const owner = c.get("owner");
    const thread = await db.get<ChatThread>(owner, THREAD_KIND, body.threadId);
    if (!thread) throw new AppError("Thread not found", 404);

    const now = new Date().toISOString();
    await db.put(owner, MESSAGE_KIND, {
      id: randomUUID(),
      threadId: thread.id,
      role: "user",
      content: body.message.content,
      createdAt: now,
    } satisfies ChatMessage);
    // Name untitled threads from the first user message.
    const renamed =
      thread.name === DEFAULT_THREAD_NAME
        ? {
            ...thread,
            name:
              body.message.content.length > 60
                ? `${body.message.content.slice(0, 60).trimEnd()}…`
                : body.message.content,
          }
        : thread;
    await touchThread(db, owner, renamed);

    const history = await listMessages(db, owner, thread.id);
    const input: RunAgentInput = {
      threadId: thread.id,
      runId: randomUUID(),
      messages: [
        ...history.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
        })),
        { id: body.message.id, role: "user" as const, content: body.message.content },
      ],
      tools: [],
      // Slice 15: the panel's per-session provider selection rides as agent
      // context; ConversationAgent resolves it before the model is built.
      // The AG-UI context value is a string, so the selection is JSON-encoded.
      context: body.provider?.provider
        ? [
            {
              description: CHAT_PROVIDER_CONTEXT,
              value: JSON.stringify({
                provider: body.provider.provider,
                model: body.provider.model ?? null,
              }),
            },
          ]
        : [],
      state: {},
      forwardedProps: {},
    };
    const agent = selectAgent(
      config,
      service,
      owner,
      {
        modelAccounts,
        getPreferences: (ownerId: string) => domain.getPreferences(ownerId),
      },
      approvals,
    );

    // Accumulate assistant text per message id so completed replies persist
    // to the thread when the run ends.
    const textBuffers = new Map<string, string>();
    const textOrder: string[] = [];
    let persisted = false;
    let cleanup: (() => void) | undefined;
    const persistAssistant = async () => {
      if (persisted) return;
      persisted = true;
      const at = new Date().toISOString();
      for (const messageId of textOrder) {
        const content = (textBuffers.get(messageId) ?? "").trim();
        if (!content) continue;
        await db.put(owner, MESSAGE_KIND, {
          id: randomUUID(),
          threadId: thread.id,
          role: "assistant",
          content,
          createdAt: at,
        } satisfies ChatMessage);
      }
      await touchThread(db, owner, renamed);
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        const subscription = agent.run(input).subscribe({
          next: (event) => {
            send(event);
            const type = (event as { type?: unknown }).type;
            if (
              (type === EventType.TEXT_MESSAGE_CHUNK || type === EventType.TEXT_MESSAGE_CONTENT) &&
              "delta" in event &&
              typeof (event as unknown as { delta?: unknown }).delta === "string"
            ) {
              const messageId = String(
                (event as unknown as { messageId?: unknown }).messageId ?? "default",
              );
              if (!textBuffers.has(messageId)) {
                textBuffers.set(messageId, "");
                textOrder.push(messageId);
              }
              textBuffers.set(
                messageId,
                (textBuffers.get(messageId) ?? "") + (event as unknown as { delta: string }).delta,
              );
            }
          },
          error: (error: unknown) => {
            send({
              type: EventType.RUN_ERROR,
              message: error instanceof Error ? error.message : "Chat run failed",
              threadId: thread.id,
              runId: input.runId,
            });
            void persistAssistant().finally(() => controller.close());
          },
          complete: () => {
            void persistAssistant().finally(() => controller.close());
          },
        });
        cleanup = () => {
          subscription.unsubscribe();
          try {
            agent.abortRun();
          } catch {
            /* already torn down */
          }
        };
      },
      cancel() {
        cleanup?.();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  app.post("/api/chat/approve", async (c) => {
    const body = z
      .object({
        runId: z.string().min(1).max(200),
        toolCallId: z.string().min(1).max(200),
        approved: z.boolean(),
      })
      .parse(await c.req.json());
    const decided = await approvals.decide(
      c.get("owner"),
      body.runId,
      body.toolCallId,
      body.approved,
    );
    if (!decided)
      return c.json(
        {
          error:
            "No pending approval for this run. It may have already been decided, timed out, or the server restarted.",
        },
        410,
      );
    return c.json({ ok: true });
  });

  app.get("/api/chat/pending-approvals", async (c) => {
    const threadId = c.req.query("threadId") || undefined;
    return c.json({ approvals: await approvals.pending(c.get("owner"), threadId) });
  });
}
