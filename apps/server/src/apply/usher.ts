/**
 * Session usher (Slice 9). Binds an application to a named Chromium profile
 * for the apply origin.
 *
 * Deterministic: a warm browser session at the apply origin means `ready`;
 * otherwise the application goes to `session_needed` and the user takes
 * over the browser (signs in themselves — the usher never types passwords).
 * Never navigates to a private-network address.
 */
import type { Application, JobPosting } from "../../../../packages/domain/src/openapply.ts";
import { domainKinds } from "../../../../packages/domain/src/openapply.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { transitionApplication } from "../transitions.ts";
import type { ApplyBrowser } from "./browser-adapter.ts";
import {
  type ApplySession,
  applyOrigin,
  getApplySession,
  isWarm,
  newApplySession,
  profileKeyForOrigin,
  putApplySession,
  refreshIdle,
} from "./session.ts";

export interface UsherDeps {
  db: Store;
  recordEvent(owner: string, type: string, payload: Record<string, unknown>): Promise<unknown>;
  browser: ApplyBrowser;
}

export interface UsherResult {
  browser_profile_key: string;
  state: "session_needed" | "ready";
  origin: string;
}

const USHER_FROM_STATES = new Set(["pack_approved", "session_needed"]);

async function loadApplicationAndJob(
  db: Store,
  owner: string,
  application_id: string,
): Promise<{ application: Application; job: JobPosting }> {
  const application = await db.get<Application>(owner, domainKinds.applications, application_id);
  if (!application) throw new AppError("Application not found", 404);
  if (!USHER_FROM_STATES.has(application.state))
    throw new AppError(
      `Apply can only start from a pack_approved application (now: ${application.state}).`,
      409,
    );
  const job = await db.get<JobPosting>(owner, domainKinds.jobPostings, application.job_id);
  if (!job) throw new AppError("Job not found", 404);
  if (!job.apply_url) throw new AppError("This job has no apply URL.", 422);
  return { application, job };
}

export async function usherApplication(
  deps: UsherDeps,
  owner: string,
  application_id: string,
): Promise<UsherResult> {
  const { application, job } = await loadApplicationAndJob(deps.db, owner, application_id);
  const origin = applyOrigin(job.apply_url as string);
  const browser_profile_key = profileKeyForOrigin(origin);

  // An existing warm apply session stays bound.
  let session: ApplySession | null = await getApplySession(deps.db, owner, application.id);
  if (session?.session_id) {
    const live = await deps.browser.getSession(owner, session.session_id);
    if (isWarm(session, live)) {
      refreshIdle(session);
      session.state = "ready";
      await putApplySession(deps.db, owner, session);
      return { browser_profile_key, state: "ready", origin };
    }
  }

  // The user may have taken over the browser themselves since the last
  // check: any live session at the apply origin warms the binding.
  const takenOver = await deps.browser.findSessionByOrigin(owner, origin);
  if (takenOver) {
    session = session ?? newApplySession(application.id, browser_profile_key, origin);
    session.session_id = takenOver.id;
    session.state = "ready";
    refreshIdle(session);
    await putApplySession(deps.db, owner, session);
    if (
      application.browser_profile_key !== browser_profile_key ||
      application.state !== "pack_approved"
    ) {
      application.browser_profile_key = browser_profile_key;
      await deps.db.put(owner, domainKinds.applications, application);
    }
    await deps.recordEvent(owner, "apply.session_ready", {
      application_id: application.id,
      origin,
    });
    return { browser_profile_key, state: "ready", origin };
  }

  // Cold: bind the profile and wait for the user to take over.
  session = session ?? newApplySession(application.id, browser_profile_key, origin);
  session.state = "session_needed";
  await putApplySession(deps.db, owner, session);
  application.browser_profile_key = browser_profile_key;
  await transitionApplication(deps, owner, application, "session_needed", "system");
  await deps.recordEvent(owner, "apply.session_needed", {
    application_id: application.id,
    origin,
    browser_profile_key,
  });
  return { browser_profile_key, state: "session_needed", origin };
}
