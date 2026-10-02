/**
 * Slice 13 invariants: the orchestrator.
 * - One specialist per run: every dispatch creates exactly one run with one
 *   role and one instructions_ref; runs move queued -> running -> done/failed.
 * - State updates: agent.run_started/completed/failed events fire per run.
 * - The pipeline's specialists (resume, cover, HR review, packer) each
 *   become a tracked run when the workflow goes through the orchestrator.
 * - advanceApplication moves ranked -> pack_review and notifies; every
 *   other state is left alone.
 * - Hard gates: the orchestrator has no submit path and never advances an
 *   application to submitted.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { DomainService } from "../apps/server/src/domain.ts";
import type { CompleteInput, CompleteResult } from "../apps/server/src/gateway.ts";
import { HunterScheduler } from "../apps/server/src/hunter/scheduler.ts";
import { Orchestrator } from "../apps/server/src/orchestrator/orchestrator.ts";
import { listRuns, transitionRun } from "../apps/server/src/orchestrator/runs.ts";
import { ProfileStore } from "../apps/server/src/profile.ts";
import { type Application, domainKinds } from "../packages/domain/src/openapply.ts";

let directory: string;
let db: Store;
let domain: DomainService;
let config: Config;
let orchestrator: Orchestrator;
const owner = "owner-orchestrator";

const stubResume = {
  resume_content: {
    full_name: "Test Candidate",
    email: "t@example.com",
    mobile: "+1 555 0100",
    links: [],
    education: [],
    skills: [{ category: "Languages", items: "TypeScript" }],
    experience: [{ title: "Engineer", dates: "2020-2024", bullets: ["Shipped things."] }],
    projects: [],
    certificates: [{ title: "AWS Certified Solutions Architect", dates: "2023", bullets: [] }],
  },
  keywords_used: [],
  missing_evidence: [],
  evidence_ids_used: ["ev-aws"],
  notes_for_hr_reviewer: [],
};
const stubCover = {
  cover_content: {
    full_name: "Test Candidate",
    email: "t@example.com",
    mobile: "+1 555 0100",
    company: "Acme",
    date: "September 25, 2026",
    paragraphs: ["I am a good fit for this role."],
    salutation: "Hello",
    closing: "Thanks",
  },
  claims: [{ text: "Holds AWS cert", evidence_id: "ev-aws" }],
  questions_for_user: [],
};
const stubHrReview = {
  findings: [],
  resume_final_candidate: stubResume.resume_content,
  cover_final_candidate: stubCover.cover_content,
  statement_final_candidate: null,
  can_approve: true,
};

function stubComplete(outputs: Record<string, unknown>) {
  return async (_o: string, input: CompleteInput): Promise<CompleteResult> => {
    const key =
      Object.keys(outputs).find(
        (k) => input.purpose.includes(k) || input.messages[0]?.content.includes(k),
      ) ?? "default";
    return {
      text: JSON.stringify(outputs[key] ?? outputs.default),
      usage: { input_tokens: 1, output_tokens: 1 },
      model_id: "stub",
    };
  };
}

const complete = stubComplete({
  resume_specialist: stubResume,
  cover_specialist: stubCover,
  "hr.review.v2": stubHrReview,
});

async function seedApplication(state: Application["state"]): Promise<string> {
  const jobId = `job-${state}-${Date.now()}`;
  await db.put(owner, domainKinds.jobPostings, {
    id: jobId,
    title: "Platform Engineer",
    company: "Acme",
    description: "Build things.",
    source: "greenhouse",
    external_id: jobId,
  });
  const appId = `app-${state}-${Date.now()}`;
  await db.put<Application>(owner, domainKinds.applications, {
    id: appId,
    job_id: jobId,
    state,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as Application);
  return appId;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openapply-orch-"));
  db = await createStore();
  config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  const created = await createApp(db, config);
  domain = created.domain;
  await db.put(owner, "profile", {
    id: "profile",
    master_resume_id: null,
    draft: null,
    memory: { headline: "Platform Engineer" },
    evidence: [
      {
        id: "ev-aws",
        kind: "certificate",
        file_name: "aws-cert.pdf",
        mime: "application/pdf",
        sha256: "abc",
        byte_size: 10,
        storage_path: "uploads/aws-cert.pdf",
        text_excerpt: "AWS Certified Solutions Architect Associate issued by Amazon Web Services",
        confirmed: true,
      },
    ],
  });
  orchestrator = new Orchestrator({
    db,
    domain,
    config,
    profileStore: new ProfileStore(db, directory),
    dataDir: directory,
    complete,
    hunter: new HunterScheduler(db, domain),
  });
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("dispatch moves a run queued -> running -> done with state-update events", async () => {
  const events: string[] = [];
  const orig = domain.recordEvent.bind(domain);
  (domain as { recordEvent: DomainService["recordEvent"] }).recordEvent = (async (
    o: string,
    type: string,
    payload: Record<string, unknown>,
  ) => {
    if (type.startsWith("agent.run_")) events.push(type);
    return orig(o, type, payload);
  }) as DomainService["recordEvent"];

  try {
    const result = await orchestrator.runSpecialist(
      owner,
      { role: "tracker", instructions_ref: "tracker.v1" },
      async () => "ok",
    );
    assert.equal(result, "ok");
    const runs = await listRuns(db, owner, { limit: 10 });
    const run = runs.find((r) => r.role === "tracker");
    assert.ok(run);
    assert.equal(run.state, "done");
    assert.equal(run.instructions_ref, "tracker.v1");
    assert.ok(run.started_at && run.finished_at);
    assert.deepEqual(events, ["agent.run_started", "agent.run_completed"]);
  } finally {
    (domain as { recordEvent: DomainService["recordEvent"] }).recordEvent = orig;
  }
});

test("a failing specialist marks the run failed, emits run_failed, and rethrows", async () => {
  const boom = Object.assign(new Error("specialist exploded"), { errorClass: "PROVIDER_ERROR" });
  await assert.rejects(
    () =>
      orchestrator.runSpecialist(owner, { role: "ranker", instructions_ref: "ranker.v1" }, () => {
        throw boom;
      }),
    /specialist exploded/,
  );
  const runs = await listRuns(db, owner, { state: "failed", limit: 10 });
  const run = runs.find((r) => r.role === "ranker");
  assert.ok(run);
  assert.equal(run.error, "specialist exploded");
  assert.equal(run.error_class, "PROVIDER_ERROR");
  assert.ok(run.finished_at);
});

test("illegal run transitions are rejected", async () => {
  const done = await orchestrator.runSpecialist(
    owner,
    { role: "notifier", instructions_ref: "notifier.v1" },
    async () => 1,
  );
  assert.equal(done, 1);
  const run = (await listRuns(db, owner, { limit: 1 }))[0];
  await assert.rejects(() => transitionRun(db, owner, run.id, "running"), /Illegal run transition/);
  await assert.rejects(() => transitionRun(db, owner, run.id, "queued"), /Illegal run transition/);
});

test("the pack workflow tracks every specialist as its own run", async () => {
  const appId = await seedApplication("ranked");
  const result = await orchestrator.buildPackWorkflow(owner, appId, {
    template_id: "template-one",
  });
  assert.equal(result.status, "pack_review");

  const runs = await listRuns(db, owner, { application_id: appId, limit: 20 });
  const roles = runs.map((r) => `${r.role}:${r.instructions_ref}`).sort();
  assert.ok(
    roles.includes("resume_specialist:resume.ats_optimize.v2"),
    `missing resume run: ${roles}`,
  );
  assert.ok(roles.includes("cover_specialist:cover.draft.v2"), `missing cover run: ${roles}`);
  assert.ok(
    roles.includes("hr_authenticity_reviewer:hr.review.v2"),
    `missing HR review run: ${roles}`,
  );
  assert.ok(roles.includes("packer:packer.v1"), `missing packer run: ${roles}`);
  // One role per run: every run is done, each with exactly one role/ref.
  for (const run of runs) {
    assert.equal(run.state, "done");
    assert.ok(run.role && !("roles" in run));
    assert.ok(run.instructions_ref && !("instructions_refs" in run));
  }
});

test("advanceApplication moves ranked -> pack_review and notifies; other states untouched", async () => {
  const appId = await seedApplication("ranked");
  const advanced = await orchestrator.advanceApplication(owner, appId);
  assert.equal(advanced.advanced, true);
  assert.equal(advanced.pack_status, "pack_review");
  const app = await db.get<Application>(owner, domainKinds.applications, appId);
  assert.equal(app?.state, "pack_review");

  const notifications = await db.list<{ taskId: string; title: string }>(owner, "notifications");
  assert.ok(
    notifications.some((n) => n.taskId === `pack-ready:${appId}`),
    "pack-ready notification was not written",
  );

  // A non-ranked application is never advanced autonomously.
  const reviewId = await seedApplication("pack_review");
  const untouched = await orchestrator.advanceApplication(owner, reviewId);
  assert.equal(untouched.advanced, false);
  assert.equal(untouched.state, "pack_review");
});

test("hard gate: the orchestrator has no submit path", async () => {
  const proto = Object.getPrototypeOf(orchestrator) as Record<string, unknown>;
  const names = Object.getOwnPropertyNames(proto);
  assert.ok(
    !names.some((n) => /submit/i.test(n)),
    `orchestrator must not expose a submit method: ${names}`,
  );
  // Advancing never lands an application in submitted.
  const appId = await seedApplication("ranked");
  await orchestrator.advanceApplication(owner, appId);
  const app = await db.get<Application>(owner, domainKinds.applications, appId);
  assert.notEqual(app?.state, "submitted");
});

test("hunter tick dispatches one tracked hunter_ats run for a due owner", async () => {
  await db.put(owner, domainKinds.preferences, {
    id: "preferences",
    scan_interval_hours: 6,
    ats_boards: [],
  });
  await orchestrator.tick();
  const runs = await listRuns(db, owner, { limit: 5 });
  const hunterRun = runs.find((r) => r.role === "hunter_ats");
  assert.ok(hunterRun, "hunter tick did not dispatch a hunter_ats run");
  assert.equal(hunterRun.instructions_ref, "hunter.ats.v1");
  assert.equal(hunterRun.state, "done");
  const state = await orchestrator.getState();
  assert.ok(state.last_tick_at, "tick did not record orchestrator_state");
});

test("concurrent manual + tick builds: exactly one wins the atomic claim, the loser gets 409", async () => {
  const appId = await seedApplication("ranked");
  // Slow the stub so both callers are inside the claim window together.
  let resumeCalls = 0;
  const slowComplete = async (o: string, input: CompleteInput): Promise<CompleteResult> => {
    if (input.purpose.includes("resume")) {
      resumeCalls++;
      await new Promise((r) => setTimeout(r, 150));
    }
    return complete(o, input);
  };
  const racing = new Orchestrator({
    db,
    domain,
    config,
    profileStore: new ProfileStore(db, directory),
    dataDir: directory,
    complete: slowComplete,
    hunter: new HunterScheduler(db, domain),
  });
  const results = await Promise.allSettled([
    racing.buildPackWorkflow(owner, appId, { template_id: "template-one" }),
    racing.buildPackWorkflow(owner, appId, { template_id: "template-one" }),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one build should win the claim");
  assert.equal(rejected.length, 1, "exactly one build should lose the claim");
  const reason = (rejected[0] as PromiseRejectedResult).reason;
  assert.match(String(reason?.message ?? reason), /already in progress/);
  assert.equal(reason?.status ?? reason?.statusCode, 409);
  // Only one resume run happened: no duplicate specialist work.
  assert.equal(resumeCalls, 1, `expected 1 resume call, got ${resumeCalls}`);
  const app = await db.get<Application>(owner, domainKinds.applications, appId);
  assert.equal(app?.state, "pack_review");
});

test("a stale pack_drafting claim is taken over; a fresh one is not", async () => {
  // Stale: claimed 2h ago (simulates a crashed run).
  const staleId = await seedApplication("pack_drafting");
  const staleApp = await db.get<Application>(owner, domainKinds.applications, staleId);
  assert.ok(staleApp);
  await db.put(owner, domainKinds.applications, {
    ...staleApp,
    state: "pack_drafting",
    pack_claimed_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
  });
  const staleResult = await orchestrator.buildPackWorkflow(owner, staleId, {
    template_id: "template-one",
  });
  assert.equal(staleResult.status, "pack_review");

  // Fresh: claimed just now by a live holder.
  const freshId = await seedApplication("pack_drafting");
  const freshApp = await db.get<Application>(owner, domainKinds.applications, freshId);
  assert.ok(freshApp);
  await db.put(owner, domainKinds.applications, {
    ...freshApp,
    state: "pack_drafting",
    pack_claimed_at: new Date().toISOString(),
  });
  await assert.rejects(
    () => orchestrator.buildPackWorkflow(owner, freshId, { template_id: "template-one" }),
    /already in progress/,
  );
});

test("advanceApplication notifies on HR blockers and leaves the app shortlisted", async () => {
  const blockingComplete = stubComplete({
    resume_specialist: stubResume,
    cover_specialist: stubCover,
    "hr.review.v2": {
      ...stubHrReview,
      can_approve: false,
      findings: [
        {
          severity: "blocker",
          location: "resume",
          issue: "Unverified metric",
          fix: "Add evidence",
        },
      ],
    },
  });
  const blocking = new Orchestrator({
    db,
    domain,
    config,
    profileStore: new ProfileStore(db, directory),
    dataDir: directory,
    complete: blockingComplete,
    hunter: new HunterScheduler(db, domain),
  });
  const appId = await seedApplication("ranked");
  const advanced = await blocking.advanceApplication(owner, appId);
  assert.equal(advanced.advanced, true);
  assert.equal(advanced.pack_status, "hr_blocked");
  const app = await db.get<Application>(owner, domainKinds.applications, appId);
  assert.equal(app?.state, "shortlisted");
  const notifications = await db.list<{ taskId: string; title: string; body: string }>(
    owner,
    "notifications",
  );
  const note = notifications.find((n) => n.taskId === `hr-blocked:${appId}`);
  assert.ok(note, "hr-blocked notification was not written");
  assert.match(note.body, /Unverified metric/);
});

test("advanceApplication notifies on build failure, releases to shortlisted, and rethrows", async () => {
  const failingComplete = async (): Promise<CompleteResult> => {
    throw new Error("provider exploded");
  };
  const failing = new Orchestrator({
    db,
    domain,
    config,
    profileStore: new ProfileStore(db, directory),
    dataDir: directory,
    complete: failingComplete,
    hunter: new HunterScheduler(db, domain),
  });
  const appId = await seedApplication("ranked");
  await assert.rejects(() => failing.advanceApplication(owner, appId), /provider exploded/);
  const app = await db.get<Application>(owner, domainKinds.applications, appId);
  assert.equal(app?.state, "shortlisted", "failed build must release the claim to shortlisted");
  const notifications = await db.list<{ taskId: string; title: string }>(owner, "notifications");
  assert.ok(
    notifications.some((n) => n.taskId === `pack-failed:${appId}`),
    "pack-failed notification was not written",
  );
});
