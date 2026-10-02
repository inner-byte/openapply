/**
 * Central orchestrator (Slice 13).
 *
 * Modeled on how a parent agent works: it dispatches one specialist
 * subagent per run (the docs/agents "one role per run" law), watches run
 * states (queued -> running -> done/failed), and emits state updates as
 * runs progress.
 *
 * It owns the application state machine and advances work: ranked ->
 * build pack (shortlisted -> pack_drafting -> HR review -> pack_review)
 * -> notify. The hunter scheduler is one of its ticks; the document
 * pipeline is an orchestrated workflow, not a route-triggered function.
 *
 * Hard gates (by construction, not by promise):
 * - The orchestrator has no submit path. Submitting stays user-driven via
 *   the supervised-apply routes, which require a stored
 *   Approval(target=submit).
 * - Ticks never open logged-in browser sessions; sessions are user-started.
 * - Cost caps per cycle are enforced by the gateway (BUDGET_EXCEEDED).
 */

import {
  type Application,
  type ApplicationState,
  domainKinds,
  type StoredPreferences,
} from "../../../../packages/domain/src/openapply.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import {
  type BuildPackOptions,
  type BuildPackResult,
  buildApplicationPack,
} from "../docs/pipeline.ts";
import type { CompleteFn } from "../docs/runner.ts";
import type { DomainService } from "../domain.ts";
import { AppError } from "../errors.ts";
import { TEMPLATES } from "../foundry/model.ts";
import type { HunterScheduler } from "../hunter/scheduler.ts";
import { backgroundFailure } from "../log.ts";
import { notifyOwner } from "../notifier.ts";
import type { ProfileStore } from "../profile.ts";
import {
  type AgentRun,
  type AgentRunState,
  type CreateRunSpec,
  createRun,
  getRun,
  listRuns,
  transitionRun,
} from "./runs.ts";

const TICK_MS = 15 * 60 * 1000;
const DEFAULT_TEMPLATE = TEMPLATES[0].id;
/** Owner namespace for orchestrator-global records (not per-user). */
const SYSTEM_OWNER = "system";

export interface OrchestratorDeps {
  db: Store;
  domain: DomainService;
  config: Config;
  profileStore: ProfileStore;
  dataDir: string;
  complete: CompleteFn;
  hunter: HunterScheduler;
}

export interface AdvanceResult {
  advanced: boolean;
  state: ApplicationState;
  pack_status?: BuildPackResult["status"];
}

export class Orchestrator {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly deps: OrchestratorDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => backgroundFailure("orchestrator tick", error));
    }, TICK_MS);
    // Boot: run whatever is already due.
    void this.tick().catch((error) => backgroundFailure("orchestrator boot tick", error));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Dispatch one specialist as a tracked subagent run. Exactly one role
   * and one instructions_ref per run; the run record moves
   * queued -> running -> done | failed and each transition emits an
   * `agent.run_*` event. The specialist's error is recorded AND rethrown
   * so callers see the real failure.
   */
  async runSpecialist<T>(owner: string, spec: CreateRunSpec, fn: () => Promise<T>): Promise<T> {
    const run = await createRun(this.deps.db, owner, spec);
    await this.deps.domain.recordEvent(owner, "agent.run_started", {
      run_id: run.id,
      role: run.role,
      instructions_ref: run.instructions_ref,
      application_id: run.application_id,
    });
    await transitionRun(this.deps.db, owner, run.id, "running");
    try {
      const result = await fn();
      const modelId =
        result && typeof result === "object" && "model_id" in result
          ? String((result as { model_id: unknown }).model_id)
          : undefined;
      await transitionRun(this.deps.db, owner, run.id, "done", { model_id: modelId });
      await this.deps.domain.recordEvent(owner, "agent.run_completed", {
        run_id: run.id,
        role: run.role,
        instructions_ref: run.instructions_ref,
        application_id: run.application_id,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorClass =
        error && typeof error === "object" && "errorClass" in error
          ? String((error as { errorClass: unknown }).errorClass)
          : "RUN_FAILED";
      await transitionRun(this.deps.db, owner, run.id, "failed", {
        error: message,
        error_class: errorClass,
      });
      await this.deps.domain.recordEvent(owner, "agent.run_failed", {
        run_id: run.id,
        role: run.role,
        instructions_ref: run.instructions_ref,
        application_id: run.application_id,
        error: message,
        error_class: errorClass,
      });
      throw error;
    }
  }

  /** One tick: hunter scan tick, then the application pipeline tick. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.hunterTick();
      await this.pipelineTick();
      await this.deps.db.put(SYSTEM_OWNER, "orchestrator_state", {
        id: "default",
        last_tick_at: new Date().toISOString(),
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * The hunter scheduler as an orchestrator tick: each due owner gets one
   * tracked `hunter_ats` run. Budget exhaustion stops the tick quietly —
   * the gateway records it, the run is marked failed, and the next tick
   * retries in the next window.
   */
  private async hunterTick(): Promise<void> {
    const { db, domain, hunter } = this.deps;
    const rows = await db.scan<StoredPreferences>(domainKinds.preferences);
    for (const { owner, value } of rows) {
      const prefs = { ...(await domain.getPreferences(owner)), ...value };
      const intervalMs = (prefs.scan_interval_hours || 12) * 3600_000;
      const state = await hunter.getState(owner);
      const last = state?.last_scan_at ? Date.parse(state.last_scan_at) : 0;
      if (Date.now() - last < intervalMs) continue;
      await this.runSpecialist(
        owner,
        { role: "hunter_ats", instructions_ref: "hunter.ats.v1" },
        () => hunter.scanOwner(owner),
      ).catch((error) => backgroundFailure(`hunter tick for ${owner}`, error));
    }
  }

  /**
   * The pipeline tick: advance every application sitting in `ranked`.
   * Each advance is its own orchestrated workflow of tracked specialist
   * runs. A budget failure marks that application's runs failed and stops
   * this tick; nothing half-built is left unmarked because every state
   * change is persisted as it happens.
   */
  private async pipelineTick(): Promise<void> {
    const { db } = this.deps;
    const rows = await db.scan<StoredPreferences>(domainKinds.preferences);
    for (const { owner } of rows) {
      const apps = await db.list<Application>(owner, domainKinds.applications);
      for (const app of apps) {
        if (app.state !== "ranked") continue;
        const advanced = await this.advanceApplication(owner, app.id).catch((error) => {
          backgroundFailure(`pipeline tick for application ${app.id}`, error);
          return null;
        });
        // Stop the tick on budget exhaustion; the next window retries.
        if (advanced === null) {
          const failed = await listRuns(db, owner, {
            application_id: app.id,
            state: "failed",
            limit: 1,
          });
          if (failed.some((r) => r.error_class === "BUDGET_EXCEEDED")) return;
        }
      }
    }
  }

  /**
   * Advance one application one step through the orchestrator-owned state
   * machine. `ranked` -> pack workflow -> `pack_review` + notify.
   * Every other state is left alone: pack approval, prefill, and submit
   * are user-driven and never advanced autonomously.
   *
   * The orchestrator reports back on its own: pack ready, HR blockers, and
   * build failures each produce an owner notification so the user gets a
   * review update without polling.
   */
  async advanceApplication(owner: string, application_id: string): Promise<AdvanceResult> {
    const { db } = this.deps;
    const app = await db.get<Application>(owner, domainKinds.applications, application_id);
    if (!app) throw new AppError("Application not found", 404);
    if (app.state !== "ranked") return { advanced: false, state: app.state };

    const job = await db.get<{ title?: string; company?: string; company_name?: string }>(
      owner,
      domainKinds.jobPostings,
      app.job_id,
    );
    const title = job?.title ?? "a job";
    const company = job?.company ?? job?.company_name ?? "";
    const jobLabel = `${title}${company ? ` at ${company}` : ""}`;

    let result: BuildPackResult;
    try {
      result = await this.buildPackWorkflow(owner, application_id, {
        template_id: DEFAULT_TEMPLATE,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await notifyOwner(db, this.deps.config, owner, {
        taskId: `pack-failed:${application_id}`,
        title: "Pack build failed",
        body: `${jobLabel}: ${message} — the application is back to shortlisted; you can rebuild it by hand.`,
      });
      throw error;
    }
    if (result.status === "pack_review") {
      await notifyOwner(db, this.deps.config, owner, {
        taskId: `pack-ready:${result.application.id}`,
        title: "Application pack ready for review",
        body: `${jobLabel} — open the pack to review it before approving.`,
      });
    } else if (result.status === "hr_blocked") {
      const blockerCount = result.findings.filter((f) => f.severity === "blocker").length;
      const first = result.findings[0];
      await notifyOwner(db, this.deps.config, owner, {
        taskId: `hr-blocked:${result.application.id}`,
        title: "Pack needs your input",
        body:
          `${jobLabel}: HR review found ${result.findings.length} finding(s)` +
          (blockerCount > 0 ? ` (${blockerCount} blocker(s))` : "") +
          (first ? ` — first: ${first.issue}` : "") +
          `. Add evidence and rebuild the pack.`,
      });
    }
    return {
      advanced: true,
      state: result.application.state,
      pack_status: result.status,
    };
  }

  /**
   * The document pipeline as an orchestrated workflow: every specialist
   * (resume, cover, statement, HR review, packer) runs
   * as its own tracked subagent run — one role per run, watched states,
   * state updates as they run.
   */
  async buildPackWorkflow(
    owner: string,
    application_id: string,
    opts: { template_id: string; resume_ref?: string; statement_required?: boolean },
  ): Promise<BuildPackResult> {
    const { db, domain, profileStore, dataDir, complete } = this.deps;
    const runRole = <T>(spec: CreateRunSpec, fn: () => Promise<T>): Promise<T> =>
      this.runSpecialist(owner, { ...spec, application_id }, fn);

    const packOpts: BuildPackOptions = {
      application_id,
      template_id: opts.template_id,
      resume_ref: opts.resume_ref,
      statement_required: opts.statement_required,
      complete,
      runRole,
    };
    return buildApplicationPack(
      {
        db,
        dataDir,
        recordEvent: (o, type, payload) => domain.recordEvent(o, type, payload),
        profileStore,
      },
      owner,
      packOpts,
    );
  }

  /** Manual hunter scan, tracked as one `hunter_ats` run. */
  async scanHunter(owner: string): Promise<unknown> {
    return this.runSpecialist(
      owner,
      { role: "hunter_ats", instructions_ref: "hunter.ats.v1" },
      () => this.deps.hunter.scanOwner(owner),
    );
  }

  async getRun(owner: string, id: string): Promise<AgentRun | null> {
    return getRun(this.deps.db, owner, id);
  }

  async listRuns(
    owner: string,
    opts: { application_id?: string; state?: AgentRunState; limit?: number } = {},
  ): Promise<AgentRun[]> {
    return listRuns(this.deps.db, owner, opts);
  }

  async getState(): Promise<{ last_tick_at?: string }> {
    const state = await this.deps.db.get<{ id: string; last_tick_at?: string }>(
      SYSTEM_OWNER,
      "orchestrator_state",
      "default",
    );
    return { last_tick_at: state?.last_tick_at };
  }
}
