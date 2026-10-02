import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import { chat, maxIterations, type SchemaInput, toolDefinition } from "@tanstack/ai";
import {
  type AnthropicChatModel,
  anthropicText,
  createAnthropicChat,
} from "@tanstack/ai-anthropic";
import { type GeminiTextModel, geminiText } from "@tanstack/ai-gemini";
import { createOpenaiChat, type OpenAIChatModel, openaiText } from "@tanstack/ai-openai";
import { map, mergeMap, Observable } from "rxjs";
import { z } from "zod";
import { MODEL_MAX_RETRIES } from "../config.ts";
import { defineTool, type ToolDefinition } from "./tools.ts";

/** Agent-context description the mobile chat panel uses to carry the user's
 *  per-session provider selection (Slice 15). The value is
 *  `{ provider: string; model?: string } | null`; null means "app default".
 *  It is read by ConversationAgent before the model is built and is never
 *  injected into the prompt or persisted as a tier setting. */
export const CHAT_PROVIDER_CONTEXT = "openapply.chat_provider_override";

/** Vault-backed credentials for one chat run. The key is resolved server-side
 *  from the encrypted vault and never reaches the client. */
export interface ChatModelAuth {
  apiKey: string;
  baseURL?: string;
}

/** A tool call the agent will not execute until a human approves it. */
export interface ApprovalRequest {
  runId: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
}

// Same "provider/model" strings, env vars and base URL formats as before.
// Each provider SDK retries transient failures up to MODEL_MAX_RETRIES
// times. The explicit-credential path (user-selected chat provider, Slice 15) gets the same
// bound: retries only replay the failed model call, never committed tool work, and non-2xx
// auth errors fail fast, so a bad key cannot burn quota on retries.
function adapter(spec: string, auth?: ChatModelAuth) {
  const [, provider = "", model = ""] = spec.trim().match(/^([^/:]*)[/:](.*)$/) ?? [];
  if (!provider || !model.trim())
    throw new Error(
      `Invalid model string "${spec}". Use "openai/gpt-5", "anthropic/claude-sonnet-4.5", or "google/gemini-2.5-pro".`,
    );
  const id = model.trim();
  // Slice 15: when the chat run carries vault credentials (user-selected
  // provider), use the explicit-key adapter factories so the key never has to
  // live in process env. Custom providers are OpenAI-compatible, so they ride
  // the OpenAI adapter with their own base URL.
  if (auth) {
    switch (provider.toLowerCase()) {
      case "openai":
        return createOpenaiChat(id as OpenAIChatModel, auth.apiKey, {
          baseURL: auth.baseURL ?? process.env.OPENAI_BASE_URL,
          maxRetries: MODEL_MAX_RETRIES,
        });
      case "anthropic":
        return createAnthropicChat(id as AnthropicChatModel, auth.apiKey, {
          baseURL: auth.baseURL,
          maxRetries: MODEL_MAX_RETRIES,
        });
      default:
        throw new Error(`Provider "${provider}" cannot be used with explicit chat credentials.`);
    }
  }
  switch (provider.toLowerCase()) {
    case "openai":
      return openaiText(id as OpenAIChatModel, {
        baseURL: process.env.OPENAI_BASE_URL,
        maxRetries: MODEL_MAX_RETRIES,
      });
    case "anthropic":
      // The AI SDK base URL ends in /v1; the Anthropic SDK adds /v1 itself.
      return anthropicText(id as AnthropicChatModel, {
        baseURL: process.env.ANTHROPIC_BASE_URL?.replace(/\/v1\/?$/, ""),
        maxRetries: MODEL_MAX_RETRIES,
      });
    case "google":
    case "gemini":
    case "google-gemini":
      // The AI SDK base URL ends in /v1beta; @google/genai adds the API version itself.
      return geminiText(id as GeminiTextModel, {
        httpOptions: {
          baseUrl: process.env.GOOGLE_GENERATIVE_AI_BASE_URL?.replace(/\/v1beta\/?$/, ""),
          // @google/genai counts the first call in `attempts`.
          retryOptions: { attempts: MODEL_MAX_RETRIES + 1 },
        },
      });
    default:
      throw unknownProvider(provider, spec);
  }
}

/** With OPENAI_BASE_URL set, a gateway model ID most likely needs the openai/ prefix. */
export function unknownProvider(
  provider: string,
  spec: string,
  baseUrl = process.env.OPENAI_BASE_URL,
) {
  const hint = baseUrl?.trim()
    ? ` For a model on your OPENAI_BASE_URL gateway, use "openai/${spec.trim()}".`
    : "";
  return new Error(
    `Unknown provider "${provider}" in "${spec}". Supported: openai, anthropic, google (gemini).${hint}`,
  );
}

// Converts AG-UI user message content to the TanStack message format.
// Handles plain strings, multimodal parts (image/audio/video/document),
// and legacy BinaryInputContent for backward compatibility.
// biome-ignore lint/suspicious/noExplicitAny: provider content parts are untyped by design.
function convertUserContent(content: unknown): string | null | any[] {
  if (!content) return null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  if (content.length === 0) return "";
  const parts: Record<string, unknown>[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || !("type" in part)) continue;
    const typed = part as { type: string; text?: string; source?: unknown; mimeType?: string };
    switch (typed.type) {
      case "text": {
        if (typed.text != null) parts.push({ type: "text", content: typed.text });
        break;
      }
      case "image":
      case "audio":
      case "video":
      case "document": {
        const source = typed.source as
          | { type: "data"; value: unknown; mimeType?: string }
          | { type: "url"; value: unknown; mimeType?: string }
          | undefined;
        if (!source) break;
        if (source.type === "data")
          parts.push({
            type: typed.type,
            source: { type: "data", value: source.value, mimeType: source.mimeType },
          });
        else if (source.type === "url")
          parts.push({
            type: typed.type,
            source: {
              type: "url",
              value: source.value,
              ...(source.mimeType ? { mimeType: source.mimeType } : {}),
            },
          });
        break;
      }
      case "binary": {
        const legacy = part as { mimeType?: string; data?: unknown; url?: string };
        const mimeType = legacy.mimeType ?? "application/octet-stream";
        const partType = mimeType.startsWith("image/") ? "image" : "document";
        if (legacy.data)
          parts.push({ type: partType, source: { type: "data", value: legacy.data, mimeType } });
        else if (legacy.url)
          parts.push({ type: partType, source: { type: "url", value: legacy.url, mimeType } });
        break;
      }
    }
  }
  return parts.length > 0 ? parts : "";
}

// Recursively closes open objects in a frontend tool's JSON Schema so OpenAI
// accepts it as a function-tool schema (strict mode requires
// additionalProperties: false and rejects empty {} sub-schemas).
function sanitizeClientToolSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeClientToolSchema);
  if (!schema || typeof schema !== "object") return schema;
  const node = { ...(schema as Record<string, unknown>) };
  if ("additionalProperties" in node) node.additionalProperties = false;
  if (node.properties && typeof node.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.properties as Record<string, unknown>))
      props[key] = sanitizeClientToolSchema(value);
    node.properties = props;
  }
  if ("items" in node) node.items = sanitizeClientToolSchema(node.items);
  for (const combinator of ["anyOf", "allOf", "oneOf"])
    if (Array.isArray(node[combinator]))
      node[combinator] = (node[combinator] as unknown[]).map(sanitizeClientToolSchema);
  return node;
}

/**
 * Converts a RunAgentInput into the format expected by TanStack AI's `chat()`.
 *
 * - Keeps only user/assistant/tool messages
 * - Extracts system/developer messages into `systemPrompts`
 * - Appends context entries and application state to `systemPrompts`
 * - Preserves tool calls on assistant messages and toolCallId on tool messages
 */
export interface TanStackChatMessage {
  role: "user" | "assistant" | "tool";
  // biome-ignore lint/suspicious/noExplicitAny: provider content parts are untyped by design.
  content: string | null | any[];
  toolCalls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  toolCallId?: string;
}

function convertInputToTanStackAI(input: RunAgentInput) {
  const chatRoles = new Set(["user", "assistant", "tool"]);
  const messages: TanStackChatMessage[] = input.messages
    .filter((m) => chatRoles.has(m.role))
    .map((m) => {
      const msg: TanStackChatMessage = {
        role: m.role as "user" | "assistant" | "tool",
        content:
          m.role === "user"
            ? convertUserContent(m.content)
            : typeof m.content === "string"
              ? m.content
              : null,
      };
      if (m.role === "assistant" && "toolCalls" in m && m.toolCalls)
        msg.toolCalls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }));
      if (m.role === "tool" && "toolCallId" in m) msg.toolCallId = m.toolCallId as string;
      return msg;
    });
  const systemPrompts: string[] = [];
  for (const m of input.messages)
    if ((m.role === "system" || m.role === "developer") && m.content)
      systemPrompts.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  if (input.context?.length)
    for (const ctx of input.context) systemPrompts.push(`${ctx.description}:\n${ctx.value}`);
  if (
    input.state !== undefined &&
    input.state !== null &&
    typeof input.state === "object" &&
    Object.keys(input.state).length > 0
  )
    systemPrompts.push(
      `Application State:\n\`\`\`json\n${JSON.stringify(input.state, null, 2)}\n\`\`\``,
    );
  return {
    messages,
    systemPrompts,
    tools: (input.tools ?? []).map((t) => ({
      __toolSide: "client",
      name: t.name,
      description: t.description,
      inputSchema: sanitizeClientToolSchema(t.parameters),
    })),
  };
}

// The classic agent always offers these two state tools. Their results turn
// into STATE_SNAPSHOT / STATE_DELTA events.
const stateTools = [
  defineTool({
    name: "AGUISendStateSnapshot",
    description: "Replace the entire application state with a new snapshot",
    parameters: z.object({ snapshot: z.any().describe("The complete new state object") }),
    execute: async ({ snapshot }) => ({ success: true, snapshot }),
  }),
  defineTool({
    name: "AGUISendStateDelta",
    description: "Apply incremental updates to application state using JSON Patch operations",
    parameters: z.object({
      delta: z
        .array(
          z.object({
            op: z.enum(["add", "replace", "remove"]).describe("The operation to perform"),
            path: z.string().describe("JSON Pointer path (e.g., '/foo/bar')"),
            value: z
              .any()
              .optional()
              .describe(
                "The value to set. Required for 'add' and 'replace' operations, ignored for 'remove'.",
              ),
          }),
        )
        .describe("Array of JSON Patch operations"),
    }),
    execute: async ({ delta }) => ({ success: true, delta }),
  }),
];

function cloneJson<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function parseJsonPointer(pointer: string): string[] | undefined {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return undefined;
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

type PatchOp = { op: "add" | "replace" | "remove"; path: string; value?: unknown };

/** Minimal JSON Patch (add/replace/remove) applicator over plain JSON values. */
function applyJsonPatch(ops: PatchOp[], state: unknown): { delta: PatchOp[]; state: unknown } {
  let root = cloneJson(state);
  const applied: PatchOp[] = [];
  for (const op of ops) {
    const segments = parseJsonPointer(op.path);
    if (!segments) continue;
    if (segments.length === 0) {
      if (op.op === "remove") continue;
      root = cloneJson(op.value);
      applied.push(op);
      continue;
    }
    let parent: unknown = root;
    let ok = true;
    for (const segment of segments.slice(0, -1)) {
      if (parent === null || typeof parent !== "object") {
        ok = false;
        break;
      }
      parent = (parent as Record<string, unknown>)[segment];
    }
    if (!ok || parent === null || typeof parent !== "object") continue;
    const last = segments[segments.length - 1];
    const holder = parent as Record<string, unknown>;
    if (Array.isArray(holder)) {
      const index = last === "-" ? holder.length : Number(last);
      if (!Number.isInteger(index) || index < 0 || index > holder.length) continue;
      if (op.op === "remove") {
        if (index >= holder.length) continue;
        holder.splice(index, 1);
      } else if (op.op === "add") holder.splice(index, 0, cloneJson(op.value));
      else {
        if (index >= holder.length) continue;
        holder[index] = cloneJson(op.value);
      }
    } else {
      if (op.op === "remove") {
        if (!(last in holder)) continue;
        delete holder[last];
      } else holder[last] = cloneJson(op.value);
    }
    applied.push(op);
  }
  return { delta: applied, state: root };
}

/**
 * Normalizes STATE_SNAPSHOT / STATE_DELTA events against the tracked state:
 * a delta that arrives before any snapshot is preceded by the initial state,
 * and each delta is applied so the tracker stays current.
 */
function createStateEventNormalizer(initialState: unknown) {
  let state = cloneJson(initialState);
  let hasEmittedState = false;
  return (event: { type: string; snapshot?: unknown; delta?: unknown }): BaseEvent[] => {
    if (event.type === EventType.STATE_SNAPSHOT) {
      state = cloneJson(event.snapshot);
      hasEmittedState = true;
      return [event as BaseEvent];
    }
    if (event.type !== EventType.STATE_DELTA) return [event as BaseEvent];
    const initialSnapshot: BaseEvent[] =
      !hasEmittedState && initialState !== undefined
        ? [{ type: EventType.STATE_SNAPSHOT, snapshot: cloneJson(state) } as BaseEvent]
        : [];
    const delta = event.delta as unknown as PatchOp[] | undefined;
    const normalized = Array.isArray(delta)
      ? applyJsonPatch(delta, state)
      : { delta: delta as unknown as PatchOp[], state };
    state = normalized.state;
    hasEmittedState = true;
    return [
      ...initialSnapshot,
      { ...(event as Record<string, unknown>), delta: normalized.delta } as unknown as BaseEvent,
    ];
  };
}

const tokenCountKeys = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
] as const;
type TokenCountKey = (typeof tokenCountKeys)[number];

function getTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type UsageEntry = {
  provider?: string;
  model?: string;
} & Partial<Record<TokenCountKey, number>>;

/** Adds usage entries to a run, grouping and summing matching identities. */
function aggregateRunUsage(details: Record<string, unknown>, entries: UsageEntry[]) {
  for (const entry of entries) {
    if (!tokenCountKeys.some((key) => entry[key] !== undefined)) continue;
    if (!Array.isArray(details.usage)) details.usage = [];
    const usage = details.usage as UsageEntry[];
    const existing = usage.find(
      (candidate) => candidate.provider === entry.provider && candidate.model === entry.model,
    );
    if (!existing) {
      usage.push({ ...entry });
      continue;
    }
    for (const key of tokenCountKeys) {
      const value = entry[key];
      if (value === undefined) continue;
      const sum = (existing[key] ?? 0) + value;
      if (Number.isSafeInteger(sum)) existing[key] = sum;
    }
  }
}

/** Normalizes TanStack terminal usage into AG-UI token usage on the run details. */
function collectTanStackRunFinishedDetails(
  raw: Record<string, unknown>,
  details: Record<string, unknown>,
) {
  if (typeof raw.finishReason === "string") details.finishReason = raw.finishReason;
  const fallbackProvider = getNonEmptyString(raw.provider);
  const fallbackModel = getNonEmptyString(raw.model);
  const usage = raw.usage;
  if (Array.isArray(usage)) {
    aggregateRunUsage(
      details,
      usage.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const normalized: UsageEntry = {
          provider: getNonEmptyString(entry.provider) ?? fallbackProvider,
          model: getNonEmptyString(entry.model) ?? fallbackModel,
        };
        for (const key of tokenCountKeys) normalized[key] = getTokenCount(entry[key]);
        return [normalized];
      }),
    );
    return;
  }
  if (!isRecord(usage)) return;
  const promptDetails = isRecord(usage.promptTokensDetails) ? usage.promptTokensDetails : {};
  const completionDetails = isRecord(usage.completionTokensDetails)
    ? usage.completionTokensDetails
    : {};
  aggregateRunUsage(details, [
    {
      provider: fallbackProvider,
      model: fallbackModel,
      inputTokens: getTokenCount(usage.promptTokens),
      outputTokens: getTokenCount(usage.completionTokens),
      totalTokens: getTokenCount(usage.totalTokens),
      reasoningTokens: getTokenCount(completionDetails.reasoningTokens),
      cachedInputTokens: getTokenCount(promptDetails.cachedTokens),
    },
  ]);
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Converts a TanStack AI chat stream into AG-UI `BaseEvent` objects.
 *
 * This is a pure converter — it does NOT emit lifecycle events
 * (RUN_STARTED / RUN_FINISHED / RUN_ERROR). The caller is responsible for those.
 */
export async function* convertTanStackStream(
  stream: AsyncIterable<unknown>,
  abortSignal: AbortSignal,
  runId: string,
  initialState: unknown,
  runFinishedDetails: Record<string, unknown>,
): AsyncGenerator<BaseEvent> {
  const messageId = randomUUID();
  const toolNamesById = new Map<string, string>();
  let reasoningRunOpen = false;
  let reasoningMessageOpen = false;
  let reasoningMessageId: string = randomUUID();
  const normalizeStateEvent = createStateEventNormalizer(initialState);
  function* closeReasoningIfOpen(): Generator<BaseEvent> {
    if (reasoningMessageOpen) {
      reasoningMessageOpen = false;
      yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningMessageId } as BaseEvent;
    }
    if (reasoningRunOpen) {
      reasoningRunOpen = false;
      yield { type: EventType.REASONING_END, messageId: reasoningMessageId } as BaseEvent;
    }
  }
  const startedToolCalls = new Set<string>();
  const endedToolCalls = new Set<string>();
  for await (const chunk of stream) {
    if (abortSignal.aborted) break;
    const raw = chunk as Record<string, unknown>;
    const type = raw.type as string;
    if (type === "CUSTOM") {
      // Tool executors emit "approval-request" through emitCustomEvent while
      // they wait for the client's decision; it becomes the wire event the
      // chat panel approves on POST /api/chat/approve.
      if (raw.name === "approval-request") {
        const value = (raw.value ?? {}) as Record<string, unknown>;
        yield {
          type: EventType.CUSTOM,
          name: "approval-request",
          value: {
            runId,
            toolCallId: value.toolCallId,
            toolName: value.toolName,
            args: value.input,
          },
        } as BaseEvent;
        continue;
      }
      yield raw as BaseEvent;
      continue;
    }
    if (type === "RUN_FINISHED") {
      collectTanStackRunFinishedDetails(raw, runFinishedDetails);
      continue;
    }
    if (type === "RUN_STARTED") continue;
    if (type === "RUN_ERROR")
      throw new Error(typeof raw.message === "string" ? raw.message : "TanStack AI run error");
    if (type === "TEXT_MESSAGE_CONTENT" && raw.delta != null) {
      yield* closeReasoningIfOpen();
      yield {
        type: EventType.TEXT_MESSAGE_CHUNK,
        role: "assistant",
        messageId,
        delta: raw.delta,
      } as BaseEvent;
    } else if (type === "TOOL_CALL_START") {
      const toolCallId = raw.toolCallId as string;
      if (startedToolCalls.has(toolCallId)) continue;
      startedToolCalls.add(toolCallId);
      yield* closeReasoningIfOpen();
      toolNamesById.set(toolCallId, raw.toolCallName as string);
      yield {
        type: EventType.TOOL_CALL_START,
        parentMessageId: messageId,
        toolCallId,
        toolCallName: raw.toolCallName,
      } as BaseEvent;
    } else if (type === "TOOL_CALL_ARGS") {
      if (endedToolCalls.has(raw.toolCallId as string)) continue;
      yield* closeReasoningIfOpen();
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: raw.toolCallId,
        delta: raw.delta,
      } as BaseEvent;
    } else if (type === "TOOL_CALL_END") {
      const toolCallId = raw.toolCallId as string;
      if (endedToolCalls.has(toolCallId)) continue;
      endedToolCalls.add(toolCallId);
      yield* closeReasoningIfOpen();
      yield { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent;
    } else if (type === "TOOL_CALL_RESULT") {
      yield* closeReasoningIfOpen();
      const toolCallId = raw.toolCallId as string;
      const toolName = toolNamesById.get(toolCallId);
      const rawPayload = (raw.content ?? raw.result) as unknown;
      const parsedContent = typeof rawPayload === "string" ? safeParse(rawPayload) : rawPayload;
      if (
        toolName === "AGUISendStateSnapshot" &&
        isRecord(parsedContent) &&
        "snapshot" in parsedContent
      ) {
        for (const event of normalizeStateEvent({
          type: EventType.STATE_SNAPSHOT,
          snapshot: parsedContent.snapshot,
        }))
          yield event;
      }
      if (
        toolName === "AGUISendStateDelta" &&
        isRecord(parsedContent) &&
        "delta" in parsedContent
      ) {
        for (const event of normalizeStateEvent({
          type: EventType.STATE_DELTA,
          delta: parsedContent.delta,
        }))
          yield event;
      }
      let serializedContent: string;
      if (typeof rawPayload === "string") serializedContent = rawPayload;
      else
        try {
          serializedContent = JSON.stringify(rawPayload ?? null);
        } catch {
          serializedContent = "[Unserializable tool result]";
        }
      yield {
        type: EventType.TOOL_CALL_RESULT,
        role: "tool",
        messageId: randomUUID(),
        toolCallId,
        content: serializedContent,
      } as BaseEvent;
      toolNamesById.delete(toolCallId);
    } else if (type === "REASONING_START") {
      yield* closeReasoningIfOpen();
      reasoningRunOpen = true;
      reasoningMessageId = (raw.messageId as string) ?? randomUUID();
      yield { type: EventType.REASONING_START, messageId: reasoningMessageId } as BaseEvent;
    } else if (type === "REASONING_MESSAGE_START") {
      reasoningMessageOpen = true;
      yield {
        type: EventType.REASONING_MESSAGE_START,
        messageId: reasoningMessageId,
        role: "reasoning",
      } as BaseEvent;
    } else if (type === "REASONING_MESSAGE_CONTENT")
      yield {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: reasoningMessageId,
        delta: raw.delta,
      } as BaseEvent;
    else if (type === "REASONING_MESSAGE_END") {
      reasoningMessageOpen = false;
      yield {
        type: EventType.REASONING_MESSAGE_END,
        messageId: reasoningMessageId,
      } as BaseEvent;
    } else if (type === "REASONING_END") {
      if (reasoningMessageOpen) {
        reasoningMessageOpen = false;
        yield {
          type: EventType.REASONING_MESSAGE_END,
          messageId: reasoningMessageId,
        } as BaseEvent;
      }
      reasoningRunOpen = false;
      yield { type: EventType.REASONING_END, messageId: reasoningMessageId } as BaseEvent;
    }
  }
  yield* closeReasoningIfOpen();
}

export interface TanStackAgent {
  run(input: RunAgentInput): Observable<BaseEvent>;
  abortRun(): void;
}

/** A TanStack-AI agent with the options of the classic AI SDK mode. */
export function tanstackAgent(options: {
  model: string;
  /** Vault-backed credentials for this run (Slice 15 chat provider override). */
  modelAuth?: ChatModelAuth;
  maxSteps: number;
  tools: ToolDefinition[];
  prompt: string;
  /** Said when the step limit, not the model, ends a run; otherwise the reply just stops. */
  stepLimitNote?: string;
  /**
   * Called when a tool declared with `interrupt: true` is invoked. The run
   * pauses until the returned promise resolves: true executes the tool,
   * false reports the call as denied. An `approval-request` custom event is
   * emitted on the stream before waiting.
   */
  onApprovalRequest?: (request: ApprovalRequest, signal: AbortSignal) => Promise<boolean>;
}): TanStackAgent {
  let active: AbortController | undefined;
  const run = (input: RunAgentInput): Observable<BaseEvent> =>
    new Observable<BaseEvent>((subscriber) => {
      if (active)
        throw new Error(
          "Agent is already running. Call abortRun() first or create a new instance.",
        );
      const abortController = new AbortController();
      active = abortController;
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      void (async () => {
        const runFinishedDetails: Record<string, unknown> = {};
        try {
          // Resume entries (approved tool calls from a paused run) arrive as
          // tool messages so the model continues from the human decision.
          const answeredToolCallIds = new Set(
            input.messages
              .filter((m) => m.role === "tool")
              .map((m) => (m as { toolCallId?: unknown }).toolCallId)
              .filter((id): id is string => typeof id === "string"),
          );
          const resumeToolMessages = (input.resume ?? [])
            .filter((entry) => !answeredToolCallIds.has(entry.interruptId))
            .map((entry) => ({
              id: randomUUID(),
              role: "tool" as const,
              toolCallId: entry.interruptId,
              content: JSON.stringify(
                entry.status === "cancelled"
                  ? { status: "cancelled" }
                  : ((entry.payload ?? { status: "resolved" }) as unknown),
              ),
            }));
          const effectiveInput =
            resumeToolMessages.length > 0
              ? { ...input, messages: [...input.messages, ...resumeToolMessages] }
              : input;
          const converted = convertInputToTanStackAI(effectiveInput);
          // Build the system prompt like the classic mode. It does not forward system messages.
          let system = options.prompt;
          if (effectiveInput.context.length) {
            system += "\n## Context from the application\n";
            // The chat provider override is routing metadata, not prompt content.
            for (const ctx of effectiveInput.context.filter(
              (c) => c.description !== CHAT_PROVIDER_CONTEXT,
            ))
              system += `${ctx.description}:\n${ctx.value}\n`;
          }
          if (
            effectiveInput.state !== undefined &&
            effectiveInput.state !== null &&
            !(
              typeof effectiveInput.state === "object" &&
              Object.keys(effectiveInput.state).length === 0
            )
          )
            system += `\n## Application State\nThis is state from the application that you can edit by calling AGUISendStateSnapshot or AGUISendStateDelta.\n\`\`\`json\n${JSON.stringify(effectiveInput.state, null, 2)}\n\`\`\`\n`;
          const stream = chat({
            adapter: adapter(options.model, options.modelAuth),
            messages: converted.messages,
            systemPrompts: system ? [system] : [],
            tools: [
              ...converted.tools,
              ...[...options.tools, ...stateTools].map((tool) =>
                toolDefinition({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.parameters as SchemaInput,
                }).server(async (args, context) => {
                  if (tool.interrupt) {
                    const toolCallId = context?.toolCallId ?? randomUUID();
                    // Streamed to the client in real time while this executor
                    // waits below; the converter turns it into the wire
                    // `approval-request` event.
                    context?.emitCustomEvent("approval-request", {
                      toolName: tool.name,
                      input: args,
                      toolCallId,
                    });
                    const gate = options.onApprovalRequest;
                    if (!gate)
                      throw new Error(
                        `Tool "${tool.name}" requires human approval, which is not available in this run.`,
                      );
                    const approved = await gate(
                      {
                        runId: effectiveInput.runId,
                        threadId: effectiveInput.threadId,
                        toolCallId,
                        toolName: tool.name,
                        args,
                      },
                      abortController.signal,
                    );
                    if (!approved)
                      return {
                        status: "denied",
                        reason:
                          tool.interruptMessage ??
                          `The user did not approve the "${tool.name}" call.`,
                      };
                  }
                  if (!tool.execute) throw new Error(`Tool "${tool.name}" has no implementation.`);
                  return (tool.execute as (args: unknown) => Promise<unknown>)(args);
                }),
              ),
            ],
            agentLoopStrategy: maxIterations(options.maxSteps),
            abortController,
          });
          for await (const event of convertTanStackStream(
            stream,
            abortController.signal,
            effectiveInput.runId,
            effectiveInput.state,
            runFinishedDetails,
          ))
            subscriber.next(event);
          if (!abortController.signal.aborted) {
            subscriber.next({
              type: EventType.RUN_FINISHED,
              threadId: effectiveInput.threadId,
              runId: effectiveInput.runId,
              ...runFinishedDetails,
            });
          }
          subscriber.complete();
        } catch (error) {
          if (abortController.signal.aborted) subscriber.complete();
          else {
            subscriber.next({
              type: EventType.RUN_ERROR,
              message: error instanceof Error ? error.message : String(error),
              threadId: input.threadId,
              runId: input.runId,
            });
            subscriber.error(error);
          }
        } finally {
          if (active === abortController) active = undefined;
        }
      })();
      return () => {
        abortController.abort();
      };
    });
  const events = (input: RunAgentInput) => {
    const stream = splitTextAtToolCalls(run(input));
    return options.stepLimitNote
      ? reportStepLimit(stream, options.maxSteps, options.stepLimitNote)
      : stream;
  };
  return {
    run: events,
    abortRun: () => active?.abort(),
  };
}

/**
 * maxIterations ends the loop after the last allowed tool step without a final model reply.
 * When a run ends that way, add a short assistant message so it does not stop silently.
 */
export function reportStepLimit(events: Observable<BaseEvent>, maxSteps: number, note: string) {
  let steps = 0;
  let phase: "text" | "calling" | "results" = "text";
  return events.pipe(
    mergeMap((event): BaseEvent[] => {
      if (event.type === EventType.TOOL_CALL_START) {
        // Parallel calls of one model step arrive together; results end the step.
        if (phase !== "calling") steps++;
        phase = "calling";
      } else if (event.type === EventType.TOOL_CALL_RESULT) phase = "results";
      else if (event.type === EventType.TEXT_MESSAGE_CHUNK) phase = "text";
      else if (event.type === EventType.RUN_FINISHED && phase === "results" && steps >= maxSteps)
        return [
          {
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: randomUUID(),
            role: "assistant",
            delta: note,
          } as BaseEvent,
          event,
        ];
      return [event];
    }),
  );
}

// The TanStack converter uses one message ID for the whole run. Text after a
// tool call gets a new message ID, so each step's text is a separate message.
function splitTextAtToolCalls(events: Observable<BaseEvent>) {
  let messageId: string | undefined;
  let afterToolCall = false;
  return events.pipe(
    map((event) => {
      if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
        if (!messageId || afterToolCall) messageId = randomUUID();
        afterToolCall = false;
        return { ...event, messageId };
      }
      if (event.type === EventType.TOOL_CALL_START) {
        afterToolCall = true;
        return messageId ? { ...event, parentMessageId: messageId } : event;
      }
      if (event.type === EventType.TOOL_CALL_RESULT) afterToolCall = true;
      return event;
    }),
  );
}
