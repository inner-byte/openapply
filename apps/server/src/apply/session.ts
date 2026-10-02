/**
 * Apply sessions (Slice 9). An apply session binds one application to a
 * named Chromium profile for the apply origin, tracks the live browser
 * session, and enforces the 120-minute idle limit from docs/BROWSER.md:
 * a session that idles past its deadline in `prefilled` or `submit_ready`
 * is dead — the user takes over the browser again.
 */
import { randomUUID } from "node:crypto";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

/** Default idle limit for apply sessions, per docs/BROWSER.md. */
export const APPLY_IDLE_MINUTES = 120;

export type ApplySessionState = "session_needed" | "ready" | "prefilled" | "submit_ready";

export interface ApplySession {
  id: string;
  application_id: string;
  browser_profile_key: string;
  /** Worker browser session id; empty until a warm session is bound. */
  session_id: string;
  origin: string;
  state: ApplySessionState;
  /** ISO timestamp: last activity + APPLY_IDLE_MINUTES. */
  idle_deadline: string;
  created_at: string;
  updated_at: string;
}

export interface WarmBrowserSession {
  id: string;
  url: string;
  status: string;
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  const m172 = /^172\.(\d+)\./.exec(h);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  return false;
}

/**
 * The https origin applications are submitted through. Rejects non-https
 * and private-network addresses — the usher never navigates to them.
 */
export function applyOrigin(applyUrl: string): string {
  let url: URL;
  try {
    url = new URL(applyUrl);
  } catch {
    throw new AppError("This job has no usable apply URL.", 422);
  }
  if (isPrivateHost(url.hostname))
    throw new AppError("Apply origin is a private-network address; refusing.", 422);
  if (url.protocol !== "https:") throw new AppError("Apply URLs must be https.", 422);
  return url.origin;
}

/** Named Chromium profile per apply origin, per docs/BROWSER.md. */
export function profileKeyForOrigin(origin: string): string {
  return `apply:${new URL(origin).hostname}`;
}

export function idleDeadlineFrom(now: Date = new Date()): string {
  return new Date(now.getTime() + APPLY_IDLE_MINUTES * 60 * 1000).toISOString();
}

export async function getApplySession(
  db: Store,
  owner: string,
  application_id: string,
): Promise<ApplySession | null> {
  const sessions = await db.list<ApplySession>(owner, "apply_sessions");
  return sessions.find((s) => s.application_id === application_id) ?? null;
}

export async function putApplySession(
  db: Store,
  owner: string,
  session: ApplySession,
): Promise<ApplySession> {
  session.updated_at = new Date().toISOString();
  return db.put(owner, "apply_sessions", session);
}

export function newApplySession(
  application_id: string,
  browser_profile_key: string,
  origin: string,
): ApplySession {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    application_id,
    browser_profile_key,
    session_id: "",
    origin,
    state: "session_needed",
    idle_deadline: idleDeadlineFrom(),
    created_at: now,
    updated_at: now,
  };
}

/** A session is warm when the browser session is live and the idle deadline holds. */
export function isWarm(
  session: ApplySession,
  browser: WarmBrowserSession | null,
  now: Date = new Date(),
): boolean {
  if (!browser || !session.session_id) return false;
  if (browser.id !== session.session_id) return false;
  if (browser.status !== "active" && browser.status !== "idle") return false;
  return new Date(session.idle_deadline).getTime() > now.getTime();
}

export function refreshIdle(session: ApplySession, now: Date = new Date()): ApplySession {
  session.idle_deadline = idleDeadlineFrom(now);
  return session;
}
