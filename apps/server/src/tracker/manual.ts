/**
 * Slice 11 — Tracker: manual state transitions.
 *
 * Deterministic, user-driven. The owner marks where an application stands
 * (e.g. after hearing back from an employer outside the system). No model
 * involved.
 *
 * Guards (server-enforced):
 * - the target must be a manual-trackable state: submitted, awaiting_reply,
 *   interviewing, closed_won, closed_lost, withdrawn. Early pipeline states
 *   (discovered … submit_ready) are system-driven and cannot be set manually.
 * - terminal states (closed_won, closed_lost, withdrawn) cannot be left.
 * - marking `submitted` manually is an explicit user mark, which per the
 *   tracker contract counts as evidence of submission.
 * - every transition records an `application.state_changed` event.
 */
import { z } from "zod";
import {
  type Application,
  type ApplicationState,
  applicationStateSchema,
  domainKinds,
} from "../../../../packages/domain/src/openapply.ts";
import type { Store } from "../db.ts";
import type { DomainService } from "../domain.ts";
import { AppError } from "../errors.ts";
import { transitionApplication } from "../transitions.ts";

/** States the owner may set by hand. Everything earlier is system-driven. */
export const manualStates: ReadonlySet<ApplicationState> = new Set([
  "submitted",
  "awaiting_reply",
  "interviewing",
  "ghosted",
  "closed_won",
  "closed_lost",
  "withdrawn",
]);

const terminalStates: ReadonlySet<ApplicationState> = new Set([
  "closed_won",
  "closed_lost",
  "withdrawn",
]);

export const manualStateSchema = z.object({
  state: applicationStateSchema.refine((s) => manualStates.has(s), {
    message: "State cannot be set manually",
  }),
  note: z.string().trim().max(500).default(""),
});

export interface ManualTrackDeps {
  db: Store;
  domain: DomainService;
}

export interface ManualTrackResult {
  application: Application;
  previous_state: ApplicationState;
}

export async function markApplicationState(
  deps: ManualTrackDeps,
  owner: string,
  applicationId: string,
  input: { state: string; note?: string },
): Promise<ManualTrackResult> {
  const parsed = manualStateSchema.parse(input);
  const application = await deps.db.get<Application>(
    owner,
    domainKinds.applications,
    applicationId,
  );
  if (!application) throw new AppError("Application not found", 404);
  if (terminalStates.has(application.state))
    throw new AppError(`Application is ${application.state}; terminal states cannot change.`, 409);
  if (application.state === parsed.state) return { application, previous_state: application.state };

  const previous_state = application.state;
  // Record why it closed — the "why it closed" data lives here, not just the state.
  if (terminalStates.has(parsed.state) && parsed.note) {
    application.close_reason = parsed.note;
  }
  await transitionApplication(
    { db: deps.db, recordEvent: (o, t, p) => deps.domain.recordEvent(o, t, p) },
    owner,
    application,
    parsed.state,
    "user",
    parsed.note,
  );
  return { application, previous_state };
}
