import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserSession } from "../../../packages/domain/src/index.ts";
import type { Auth } from "./auth.ts";
import { browserConsole } from "./browser-console.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";

/**
 * Parallel computer isolation (OpenDots-inspired): every actor that talks to
 * the browser worker uses its own derived credential instead of the shared
 * master token, and every role gets its own Chromium profile namespace so
 * the hunter, supervised-apply, and chat never share browser state.
 */
export type WorkerRole = "hunter" | "apply" | "chat" | "system";

/** Derive a per-role worker credential from the master WORKER_TOKEN. The
 *  worker validates it against the `x-worker-role` header; the master token
 *  itself never leaves the server config. */
export function workerRoleToken(masterToken: string, role: WorkerRole): string {
  return createHmac("sha256", masterToken).update(`openapply-worker:${role}`).digest("hex");
}

const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.enum(["idle", "active", "closed", "error"]),
  updatedAt: z.string(),
  profileKey: z.string().max(120).optional(),
  sessionClass: z.string().max(32).optional(),
  idleMinutes: z.number().int().min(5).max(720).optional(),
  role: z.enum(["hunter", "apply", "chat", "system"]).optional(),
});
type BrowserSessionRecord = z.infer<typeof sessionSchema>;

export interface BrowserCreateOptions {
  profileKey?: string;
  sessionClass?: string;
  idleMinutes?: number;
  role?: WorkerRole;
}
const readSchema = z.object({
  url: z.string(),
  title: z.string().max(300),
  text: z.string().max(100_000),
  truncated: z.boolean(),
});
const failureSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  message: z.string(),
  createdAt: z.string(),
});
type ChatBrowser = { id: string; sessionId: string };

export class BrowserService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private health?: { checkedAt: number; reachable: Promise<boolean> };
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly auth: Auth,
    private readonly files: Files,
    private readonly now: () => number = Date.now,
  ) {}
  /** Whether the configured worker answers its health check, cached briefly for snapshots. */
  reachable(): Promise<boolean> {
    if (!this.config.workerUrl || !this.config.workerToken) return Promise.resolve(false);
    const now = this.now();
    if (this.health && now - this.health.checkedAt < 15_000) return this.health.reachable;
    const reachable = fetch(`${this.config.workerUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    }).then(
      (response) => response.ok,
      () => false,
    );
    this.health = { checkedAt: now, reachable };
    return reachable;
  }
  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(id, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }
  private async request(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    role: WorkerRole = "system",
  ) {
    signal?.throwIfAborted();
    if (!this.config.workerUrl || !this.config.workerToken)
      throw new AppError("Browser worker is not configured. Start it using the setup guide.", 503);
    let response: Response;
    try {
      response = await fetch(`${this.config.workerUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          // Per-role derived credential (parallel computer isolation): the
          // worker validates it against the x-worker-role header.
          Authorization: `Bearer ${workerRoleToken(this.config.workerToken, role)}`,
          "x-worker-role": role,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
          : AbortSignal.timeout(45000),
      });
    } catch {
      signal?.throwIfAborted();
      throw new AppError(
        "Browser worker is unavailable. Check that its container is running.",
        503,
      );
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new AppError(
        typeof payload?.error?.message === "string"
          ? payload.error.message
          : "Browser request failed",
        502,
      );
    }
    return response;
  }
  async get(owner: string, id: string) {
    const value = await this.db.get<BrowserSessionRecord>(owner, "browsers", id);
    if (!value) throw new AppError("Browser session not found", 404);
    return value;
  }
  decorate(owner: string, session: BrowserSession) {
    return {
      ...session,
      consoleUrl: this.auth.sign(owner, `/api/browsers/${session.id}/console`),
      previewUrl: this.auth.sign(owner, `/api/browsers/${session.id}/preview`),
    };
  }
  private async save(owner: string, payload: unknown, expectedId: string) {
    const session = sessionSchema.parse(payload);
    if (session.id !== expectedId)
      throw new AppError("Browser worker returned a different session", 502);
    // Role and profile namespace are server-side isolation concerns; the
    // worker never knows them, so a worker response must not clobber them.
    const prev = await this.db.get<BrowserSessionRecord>(owner, "browsers", expectedId);
    const merged: BrowserSessionRecord = { ...session };
    if (merged.role === undefined) merged.role = prev?.role;
    if (merged.profileKey === undefined) merged.profileKey = prev?.profileKey;
    await this.db.put(owner, "browsers", merged);
    return this.decorate(owner, merged);
  }
  async create(owner: string, url: string, options: BrowserCreateOptions = {}) {
    const id = randomUUID();
    // Parallel computer isolation: each role gets its own Chromium profile
    // namespace so the hunter, apply, and chat never share cookies, logins,
    // or storage. An explicit profile key (e.g. apply's `apply:<host>`) is
    // kept verbatim; otherwise the role itself becomes the profile.
    const role = options.role ?? "chat";
    const profileKey = options.profileKey ?? role;
    const record: BrowserSessionRecord = {
      id,
      url,
      title: "New browser session",
      status: "idle",
      updatedAt: new Date().toISOString(),
      role,
      profileKey,
    };
    if (options.sessionClass !== undefined) record.sessionClass = options.sessionClass;
    if (options.idleMinutes !== undefined) record.idleMinutes = options.idleMinutes;
    // Record ownership before calling the worker, including when its response is lost.
    await this.db.put(owner, "browsers", record);
    return this.reopen(owner, id, url);
  }
  private async openOwned(owner: string, id: string, url?: string, signal?: AbortSignal) {
    const value = await this.get(owner, id);
    const target = url ?? value.url;
    const body: Record<string, unknown> = { id, url: target };
    if (value.profileKey !== undefined) body.profile_key = value.profileKey;
    if (value.sessionClass !== undefined) body.session_class = value.sessionClass;
    if (value.idleMinutes !== undefined) body.idle_minutes = value.idleMinutes;
    try {
      const response = await this.request("/sessions", body, signal, value.role ?? "system");
      return await this.save(owner, await response.json(), id);
    } catch (error) {
      await this.save(
        owner,
        { ...value, url: target, status: "error", updatedAt: new Date().toISOString() },
        id,
      );
      throw error;
    }
  }
  reopen(owner: string, id: string, url?: string) {
    return this.serial(id, () => this.openOwned(owner, id, url));
  }
  navigate(owner: string, id: string, url: string) {
    return this.reopen(owner, id, url);
  }
  private async readOwned(owner: string, id: string, signal?: AbortSignal) {
    const session = await this.get(owner, id);
    const result = readSchema.parse(
      await (
        await this.request(`/sessions/${id}/read`, undefined, signal, session.role ?? "system")
      ).json(),
    );
    await this.save(
      owner,
      {
        ...session,
        url: result.url,
        title: result.title,
        status: "active",
        updatedAt: new Date().toISOString(),
      },
      id,
    );
    return result;
  }
  read(owner: string, id: string) {
    return this.serial(id, () => this.readOwned(owner, id));
  }
  async observe(owner: string, url: string, existingId?: string) {
    const id = existingId ?? (await this.create(owner, url)).id;
    return this.serial(id, async () => {
      if (existingId) await this.openOwned(owner, id, url);
      return { sessionId: id, ...(await this.readOwned(owner, id)) };
    });
  }
  async observeForThread(owner: string, threadId: string, url: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    // Persist the association before contacting the worker so failed/lost responses
    // and later chat turns keep using the same profile instead of exhausting its limit.
    const association =
      (await this.db.get<ChatBrowser>(owner, "chat-browsers", threadId)) ??
      (await this.db.insertIfAbsent(owner, "chat-browsers", {
        id: threadId,
        sessionId: randomUUID(),
      })) ??
      (await this.db.get<ChatBrowser>(owner, "chat-browsers", threadId));
    if (!association) throw new AppError("Could not reserve the chat browser session", 500);
    const id = association.sessionId;
    await this.db.insertIfAbsent(owner, "browsers", {
      id,
      url,
      title: "New browser session",
      status: "idle",
      updatedAt: new Date().toISOString(),
      role: "chat",
      profileKey: "chat",
    });
    return this.serial(id, async () => {
      signal?.throwIfAborted();
      await this.openOwned(owner, id, url, signal);
      signal?.throwIfAborted();
      const page = await this.readOwned(owner, id, signal);
      signal?.throwIfAborted();
      return {
        sessionId: id,
        ...page,
        text: page.text.slice(0, 30_000),
        truncated: page.truncated || page.text.length > 30_000,
      };
    });
  }
  async close(owner: string, id: string) {
    return this.serial(id, async () => {
      const session = await this.get(owner, id);
      return this.save(
        owner,
        await (
          await this.request(`/sessions/${id}/close`, {}, undefined, session.role ?? "system")
        ).json(),
        id,
      );
    });
  }
  async preview(owner: string, id: string) {
    const session = await this.get(owner, id);
    return this.request(
      `/sessions/${id}/screenshot`,
      undefined,
      undefined,
      session.role ?? "system",
    );
  }
  async input(owner: string, id: string, value: unknown) {
    return this.serial(id, async () => {
      const session = await this.get(owner, id);
      return this.save(
        owner,
        await (
          await this.request(`/sessions/${id}/input`, value, undefined, session.role ?? "system")
        ).json(),
        id,
      );
    });
  }
  async imports(owner: string, id: string) {
    const session = await this.get(owner, id);
    const role = session.role ?? "system";
    const { downloads, failures } = z
      .object({
        downloads: z.array(
          z.object({ id: z.string(), name: z.string(), size: z.number(), mimeType: z.string() }),
        ),
        failures: z.array(failureSchema),
      })
      .parse(
        await (await this.request(`/sessions/${id}/downloads`, undefined, undefined, role)).json(),
      );
    const saved = [];
    for (const download of downloads) {
      const existing = await this.db.get<{ fileId: string }>(
        owner,
        "browser-downloads",
        download.id,
      );
      if (existing) {
        saved.push(this.files.signed(owner, await this.files.get(owner, existing.fileId)));
        continue;
      }
      const response = await this.request(
        `/sessions/${id}/downloads/${encodeURIComponent(download.id)}`,
        undefined,
        undefined,
        role,
      );
      const file = await this.files.import(
        owner,
        download.name,
        new Uint8Array(await response.arrayBuffer()),
        `Browser · ${id}`,
      );
      await this.db.put(owner, "browser-downloads", { id: download.id, fileId: file.id });
      saved.push(file);
    }
    return { files: saved, failures };
  }
  console(owner: string, id: string) {
    return browserConsole(this.auth.sign(owner, `/api/browsers/${id}/preview`));
  }
}
