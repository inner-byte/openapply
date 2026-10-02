/**
 * Application routes (Slice 7): list applications and build the document
 * pack for one shortlisted application.
 */
import type { Hono } from "hono";
import { z } from "zod";
import type { Application } from "../../../packages/domain/src/openapply.ts";
import { domainKinds } from "../../../packages/domain/src/openapply.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { buildDashboard, findGhostingCandidates } from "./dashboard.ts";
import type { Store } from "./db.ts";
import { DocumentError } from "./docs/grounding.ts";
import { isBuilderRef } from "./docs/runner.ts";
import type { DomainService } from "./domain.ts";
import type { ModelGateway } from "./gateway.ts";
import type { Orchestrator } from "./orchestrator/orchestrator.ts";
import type { ProfileStore } from "./profile.ts";
import { markApplicationState } from "./tracker/manual.ts";
import { transitionApplication } from "./transitions.ts";

const buildPackSchema = z.object({
  template_id: z.string().min(1).max(40),
  resume_ref: z.string().min(1).max(60).optional(),
  statement_required: z.boolean().optional().default(false),
});

export function registerApplicationRoutes(
  app: Hono<{ Variables: { owner: string } }>,
  db: Store,
  _config: Config,
  _auth: Auth,
  domain: DomainService,
  _profileStore: ProfileStore,
  _gateway: ModelGateway,
  orchestrator: Orchestrator,
) {
  app.get("/api/applications", async (c) => {
    const owner = c.get("owner");
    const applications = await db.list<Application>(owner, domainKinds.applications);
    const jobs = await db.list<{ id: string; title: string; company: string }>(
      owner,
      domainKinds.jobPostings,
    );
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const scores = new Map(
      (await db.list<{ id: string; score: number }>(owner, "job_scores")).map((s) => [
        s.id,
        s.score,
      ]),
    );
    return c.json(
      applications.map((a) => ({
        ...a,
        job: jobById.get(a.job_id) ?? null,
        score: scores.get(a.job_id) ?? null,
      })),
    );
  });

  // Dashboard: KPIs + triage-ordered cards. Must come before "/:id" routes.
  app.get("/api/applications/dashboard", async (c) => {
    const owner = c.get("owner");
    return c.json(await buildDashboard(db, owner));
  });

  // Ghost check: deterministic rule — applications silent past
  // `ghosted_after_days` become a real logged `ghosted` transition.
  app.post("/api/applications/check-ghosting", async (c) => {
    const owner = c.get("owner");
    const prefs = await domain.getPreferences(owner);
    const dash = await buildDashboard(db, owner);
    const candidates = findGhostingCandidates(dash.cards, prefs.ghosted_after_days);
    const marked: string[] = [];
    for (const candidate of candidates) {
      const application = await db.get<Application>(
        owner,
        domainKinds.applications,
        candidate.application_id,
      );
      if (!application || application.state === "ghosted") continue;
      await transitionApplication(
        { db, recordEvent: (o, t, p) => domain.recordEvent(o, t, p) },
        owner,
        application,
        "ghosted",
        "system",
        `No employer signal in ${candidate.silent_days} days`,
      );
      marked.push(candidate.application_id);
    }
    return c.json({ marked, count: marked.length });
  });

  app.post("/api/applications/:id/build-pack", async (c) => {
    const owner = c.get("owner");
    const body = buildPackSchema.parse(await c.req.json());
    if (body.resume_ref && !isBuilderRef(body.resume_ref))
      throw new DocumentError("SCHEMA_INVALID", `Unknown resume prompt: ${body.resume_ref}`);
    const result = await orchestrator.buildPackWorkflow(owner, c.req.param("id"), {
      template_id: body.template_id,
      resume_ref: body.resume_ref,
      statement_required: body.statement_required,
    });
    if (result.status === "hr_blocked") {
      return c.json({
        status: "hr_blocked",
        application: result.application,
        findings: result.findings,
      });
    }
    return c.json({
      status: "pack_review",
      application: result.application,
      pack_id: result.manifest.id,
    });
  });

  // Slice 11 — Tracker: manual state mark. The owner records where an
  // application stands; early pipeline states cannot be set by hand.
  app.post("/api/applications/:id/state", async (c) => {
    const owner = c.get("owner");
    const body = await c.req.json().catch(() => ({}));
    const result = await markApplicationState(
      { db, domain },
      owner,
      c.req.param("id"),
      body as { state: string; note?: string },
    );
    return c.json(result);
  });
}
