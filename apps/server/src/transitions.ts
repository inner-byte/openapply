/**
 * Application state transitions (dashboard slice).
 *
 * The one migration the dashboard debate demanded: every application state
 * change goes through `transitionApplication`. It stamps `state_entered_at`
 * (powers days-in-state and stall detection) and appends an
 * `application.state_changed` domain event with the actor — the append-only
 * transition log the dashboard timeline reads.
 *
 * Actor vocabulary: "user" (owner marked it by hand), "system" (pipeline),
 * "tracker" (Gmail mapping). Tracker transitions are flagged `inferred` so
 * the dashboard can visually separate inferred from confirmed states.
 */
import type { Application, ApplicationState } from "../../../packages/domain/src/openapply.ts";
import { domainKinds } from "../../../packages/domain/src/openapply.ts";
import type { Store } from "./db.ts";

export type TransitionActor = "user" | "system" | "tracker";

export interface TransitionDeps {
  db: Store;
  recordEvent(owner: string, type: string, payload: Record<string, unknown>): Promise<unknown>;
}

/**
 * States that end the application's story. The choke point refuses to leave
 * them — a late employer reply moves to `ghosted`-aware handling via the
 * tracker, never by resurrecting a closed row. (ghosted is deliberately NOT
 * terminal: an employer can still reply after silence.)
 */
export const TERMINAL_STATES: ReadonlySet<ApplicationState> = new Set([
  "closed_won",
  "closed_lost",
  "withdrawn",
]);

export class TerminalTransitionError extends Error {
  constructor(from: ApplicationState, to: ApplicationState) {
    super(`Cannot move application from terminal state "${from}" to "${to}"`);
    this.name = "TerminalTransitionError";
  }
}

export async function transitionApplication(
  deps: TransitionDeps,
  owner: string,
  application: Application,
  to: ApplicationState,
  actor: TransitionActor,
  note?: string,
  extra?: Record<string, unknown>,
): Promise<Application> {
  const from = application.state;
  // The choke point chokes: no caller can resurrect a closed application by
  // forgetting a call-site guard.
  if (TERMINAL_STATES.has(from) && from !== to) {
    throw new TerminalTransitionError(from, to);
  }
  const now = new Date().toISOString();
  // Mutate in place (the codebase treats Application as mutable) and return it.
  application.state = to;
  application.state_entered_at = now;
  if (to === "submitted" && !application.submitted_at) application.submitted_at = now;
  await deps.db.put<Application>(owner, domainKinds.applications, application);
  if (from !== to) {
    await deps.recordEvent(owner, "application.state_changed", {
      application_id: application.id,
      job_id: application.job_id,
      previous_state: from,
      new_state: to,
      actor,
      inferred: actor === "tracker",
      note: note || undefined,
      ...extra,
    });
  }
  return application;
}
