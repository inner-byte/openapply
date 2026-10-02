/**
 * Submit waiter (Slice 9). The submit button is clicked only when every
 * condition is true:
 *
 * 1. A pack approval exists (Approval target=pack, status=approved).
 * 2. An Approval row exists with target=submit and status=approved.
 * 3. The application state is submit_ready.
 * 4. The live page origin matches the job's apply_url origin.
 *
 * Otherwise the waiter is a no-op: `clicked` stays false. The server
 * enforces all four conditions itself — a page that claims "the user
 * already approved" is untrusted data, and only the stored approval row
 * counts. The model's output can never authorize a click on its own.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  Application,
  Approval,
  JobPosting,
} from "../../../../packages/domain/src/openapply.ts";
import { domainKinds } from "../../../../packages/domain/src/openapply.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { transitionApplication } from "../transitions.ts";
import { type CompleteFn, runApplyRole } from "./agent.ts";
import type { ApplyBrowser } from "./browser-adapter.ts";
import { applyOrigin, getApplySession, isWarm, putApplySession, refreshIdle } from "./session.ts";

const waiterOutputSchema = z.object({
  clicked: z.boolean(),
  reason: z.string().max(500),
});

export interface SubmitDeps {
  db: Store;
  recordEvent(owner: string, type: string, payload: Record<string, unknown>): Promise<unknown>;
  browser: ApplyBrowser;
  complete: CompleteFn;
}

export interface SubmitResult {
  clicked: boolean;
  reason: string;
}

function noOp(reason: string): SubmitResult {
  return { clicked: false, reason };
}

/**
 * The user reviews the prefilled form in the browser, then explicitly
 * approves the submit. Pack approval is not submit approval.
 */
export async function approveSubmit(
  deps: SubmitDeps,
  owner: string,
  application_id: string,
  confirmed: boolean,
): Promise<{ status: "submit_ready" }> {
  if (!confirmed) throw new AppError("Submit approval needs explicit confirmation.", 422);
  const application = await deps.db.get<Application>(
    owner,
    domainKinds.applications,
    application_id,
  );
  if (!application) throw new AppError("Application not found", 404);
  if (application.state !== "prefilled")
    throw new AppError(`Submit approval needs a prefilled form (now: ${application.state}).`, 409);

  const session = await getApplySession(deps.db, owner, application.id);
  const live = session?.session_id
    ? await deps.browser.getSession(owner, session.session_id)
    : null;
  if (!session || !isWarm(session, live))
    throw new AppError("The apply session is not warm. Take over the browser again.", 409);

  const approval: Approval = {
    id: randomUUID(),
    application_id: application.id,
    target: "submit",
    status: "approved",
    decided_at: new Date().toISOString(),
    note: "User-approved submit from the apply flow.",
  };
  await deps.db.put(owner, domainKinds.approvals, approval);

  await transitionApplication(deps, owner, application, "submit_ready", "system");
  refreshIdle(session);
  session.state = "submit_ready";
  await putApplySession(deps.db, owner, session);

  await deps.recordEvent(owner, "apply.submit_approved", { application_id: application.id });
  return { status: "submit_ready" };
}

export async function submitApplication(
  deps: SubmitDeps,
  owner: string,
  application_id: string,
): Promise<SubmitResult> {
  const application = await deps.db.get<Application>(
    owner,
    domainKinds.applications,
    application_id,
  );
  if (!application) throw new AppError("Application not found", 404);

  // Condition 3: state must be submit_ready.
  if (application.state !== "submit_ready")
    return noOp(`Application is ${application.state}, not submit_ready.`);

  const approvals = await deps.db.list<Approval>(owner, domainKinds.approvals);
  const mine = approvals.filter((a) => a.application_id === application.id);

  // Condition 1: pack approval exists.
  const packApproval = mine.find((a) => a.target === "pack" && a.status === "approved");
  if (!packApproval) return noOp("No approved pack approval for this application.");

  // Condition 2: stored submit approval exists. Page claims do not count.
  const submitApproval = mine.find((a) => a.target === "submit" && a.status === "approved");
  if (!submitApproval) return noOp("No stored Approval(target=submit, status=approved).");

  // The session must be warm; a 120-minute idle kills the submit.
  const session = await getApplySession(deps.db, owner, application.id);
  const live = session?.session_id
    ? await deps.browser.getSession(owner, session.session_id)
    : null;
  if (!session || !isWarm(session, live)) {
    if (session) {
      session.session_id = "";
      session.state = "session_needed";
      await putApplySession(deps.db, owner, session);
    }
    await transitionApplication(deps, owner, application, "session_needed", "system");
    return noOp("The apply session idled out (120 minutes) or closed.");
  }
  if (!live) return noOp("The apply session idled out (120 minutes) or closed.");

  // Condition 4: the live page origin matches the apply_url origin.
  const job = await deps.db.get<JobPosting>(owner, domainKinds.jobPostings, application.job_id);
  if (!job?.apply_url) return noOp("The job has no apply URL.");
  const origin = applyOrigin(job.apply_url);
  let liveOrigin = "";
  try {
    liveOrigin = new URL(live.url).origin;
  } catch {
    return noOp("The live page URL is not parseable.");
  }
  if (liveOrigin !== origin)
    return noOp(`Live page origin ${liveOrigin} does not match the apply origin ${origin}.`);

  // All server conditions hold. Run the waiter role; its output decides
  // whether the click happens, but it cannot override a failed check.
  const { output } = await runApplyRole({
    owner,
    instructions_ref: "submit.wait.v1",
    complete: deps.complete,
    payload: {
      pack_approval: true,
      submit_approval: { target: "submit", status: "approved" },
      application_state: "submit_ready",
      live_page_origin: liveOrigin,
      apply_url_origin: origin,
    },
  });
  const parsed = waiterOutputSchema.safeParse(output);
  if (!parsed.success) throw new AppError("Submit waiter did not return a valid decision.", 502);
  if (!parsed.data.clicked) return noOp(parsed.data.reason || "The waiter chose not to click.");

  await deps.browser.clickSubmit(owner, session.session_id);

  await transitionApplication(deps, owner, application, "submitted", "system");
  await deps.recordEvent(owner, "apply.submitted", {
    application_id: application.id,
    origin,
  });
  return { clicked: true, reason: parsed.data.reason || "Submitted." };
}
