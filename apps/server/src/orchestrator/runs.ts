/**
 * Agent run registry (Slice 13 — Orchestrator).
 *
 * Every specialist the orchestrator dispatches is recorded as one run:
 * queued -> running -> done | failed. The orchestrator watches these
 * states and emits `agent.run_*` events as they change — the same way a
 * parent agent reports subagent progress.
 */
import { randomUUID } from "node:crypto";
import type { Store } from "../db.ts";

export type AgentRunState = "queued" | "running" | "done" | "failed";

export interface AgentRun {
  id: string;
  owner: string;
  /** Specialist role, e.g. "resume_specialist". One role per run. */
  role: string;
  /** Exactly one instructions_ref per run, e.g. "resume.ats_optimize.v2". */
  instructions_ref: string;
  application_id?: string;
  job_id?: string;
  state: AgentRunState;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  error_class?: string;
  model_id?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface CreateRunSpec {
  role: string;
  instructions_ref: string;
  application_id?: string;
  job_id?: string;
}

const KIND = "agent_runs";

/** Legal transitions: queued -> running -> done | failed. Nothing else. */
const TRANSITIONS: Record<AgentRunState, AgentRunState[]> = {
  queued: ["running"],
  running: ["done", "failed"],
  done: [],
  failed: [],
};

export async function createRun(db: Store, owner: string, spec: CreateRunSpec): Promise<AgentRun> {
  const run: AgentRun = {
    id: randomUUID(),
    owner,
    role: spec.role,
    instructions_ref: spec.instructions_ref,
    application_id: spec.application_id,
    job_id: spec.job_id,
    state: "queued",
    created_at: new Date().toISOString(),
  };
  await db.put(owner, KIND, run);
  return run;
}

export async function getRun(db: Store, owner: string, id: string): Promise<AgentRun | null> {
  return db.get<AgentRun>(owner, KIND, id);
}

export async function transitionRun(
  db: Store,
  owner: string,
  id: string,
  to: AgentRunState,
  patch: Partial<Pick<AgentRun, "error" | "error_class" | "model_id" | "usage">> = {},
): Promise<AgentRun> {
  const run = await getRun(db, owner, id);
  if (!run) throw new Error(`Agent run not found: ${id}`);
  if (!TRANSITIONS[run.state].includes(to))
    throw new Error(`Illegal run transition: ${run.state} -> ${to}`);
  const now = new Date().toISOString();
  const updated: AgentRun = {
    ...run,
    ...patch,
    state: to,
    started_at: to === "running" ? now : run.started_at,
    finished_at: to === "done" || to === "failed" ? now : run.finished_at,
  };
  await db.put(owner, KIND, updated);
  return updated;
}

export async function listRuns(
  db: Store,
  owner: string,
  opts: { application_id?: string; state?: AgentRunState; limit?: number } = {},
): Promise<AgentRun[]> {
  const all = await db.list<AgentRun>(owner, KIND);
  const filtered = all.filter(
    (r) =>
      (!opts.application_id || r.application_id === opts.application_id) &&
      (!opts.state || r.state === opts.state),
  );
  filtered.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return filtered.slice(0, opts.limit ?? 50);
}
