/**
 * Browser adapter for the apply flow (Slice 9). The apply module talks to
 * this interface; tests inject a fake. The real implementation wraps
 * BrowserService and the Playwright worker.
 *
 * Worker extensions required by docs/BROWSER.md that may not exist yet:
 * - named profiles per origin (the worker receives `profile_key`)
 * - file chooser from pack paths (`POST /sessions/:id/file-chooser`)
 * - configurable idle timeout per session class (`idle_minutes`)
 * - submit click (`POST /sessions/:id/submit`)
 * Calls to a missing extension surface the worker's error; they never
 * silently pretend the action happened.
 */

import type { BrowserService } from "../browser.ts";
import { workerRoleToken } from "../browser.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { APPLY_IDLE_MINUTES, type WarmBrowserSession } from "./session.ts";

export interface FillField {
  field: string;
  value: string;
}

export interface ApplyBrowser {
  getSession(owner: string, sessionId: string): Promise<WarmBrowserSession | null>;
  findSessionByOrigin(owner: string, origin: string): Promise<WarmBrowserSession | null>;
  readPage(owner: string, sessionId: string): Promise<{ url: string; text: string }>;
  fillField(owner: string, sessionId: string, field: FillField): Promise<void>;
  attachFiles(owner: string, sessionId: string, paths: string[]): Promise<void>;
  clickSubmit(owner: string, sessionId: string): Promise<void>;
  closeSession(owner: string, sessionId: string): Promise<void>;
}

export class WorkerApplyBrowser implements ApplyBrowser {
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly browser: BrowserService,
  ) {}

  private async workerRequest(path: string, body?: unknown): Promise<Response> {
    if (!this.config.workerUrl || !this.config.workerToken)
      throw new AppError("Browser worker is not configured. Start it using the setup guide.", 503);
    return fetch(`${this.config.workerUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        // Parallel computer isolation: the apply role uses its own derived
        // credential, never the shared master token.
        Authorization: `Bearer ${workerRoleToken(this.config.workerToken, "apply")}`,
        "x-worker-role": "apply",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
  }

  async getSession(owner: string, sessionId: string): Promise<WarmBrowserSession | null> {
    try {
      const s = await this.browser.get(owner, sessionId);
      return { id: s.id, url: s.url, status: s.status };
    } catch {
      return null;
    }
  }

  async findSessionByOrigin(owner: string, origin: string): Promise<WarmBrowserSession | null> {
    const sessions = await this.db.list<{ id: string; url: string; status: string }>(
      owner,
      "browsers",
    );
    const match = sessions.find((s) => {
      try {
        return new URL(s.url).origin === origin && (s.status === "active" || s.status === "idle");
      } catch {
        return false;
      }
    });
    return match ? { id: match.id, url: match.url, status: match.status } : null;
  }

  async readPage(owner: string, sessionId: string): Promise<{ url: string; text: string }> {
    const s = await this.browser.get(owner, sessionId);
    const read = await this.workerRequest(`/sessions/${sessionId}/read`);
    const body = (await read.json()) as { url?: string; text?: string };
    return { url: body.url ?? s.url, text: body.text ?? "" };
  }

  async fillField(owner: string, sessionId: string, field: FillField): Promise<void> {
    // Snapshot-before-action (OpenDots discipline): the user may have taken
    // over the browser since the last read; refresh the page snapshot before
    // acting so coordinates and selectors are never stale.
    await this.readPage(owner, sessionId);
    await this.browser.input(owner, sessionId, { action: "fill", ...field });
  }

  async attachFiles(_owner: string, sessionId: string, paths: string[]): Promise<void> {
    const response = await this.workerRequest(`/sessions/${sessionId}/file-chooser`, { paths });
    if (!response.ok)
      throw new AppError(
        `Worker file-chooser failed (${response.status}); attach the pack files manually in the browser.`,
        502,
      );
  }

  async clickSubmit(owner: string, sessionId: string): Promise<void> {
    // Snapshot-before-action: refresh the page snapshot before the final
    // submit click, in case the user took over the browser mid-flow.
    await this.readPage(owner, sessionId);
    const response = await this.workerRequest(`/sessions/${sessionId}/submit`, {});
    if (!response.ok) throw new AppError(`Worker submit click failed (${response.status}).`, 502);
  }

  async closeSession(owner: string, sessionId: string): Promise<void> {
    await this.browser.close(owner, sessionId);
  }
}

export function applyIdleMinutes(): number {
  return APPLY_IDLE_MINUTES;
}
