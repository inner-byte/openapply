/**
 * Dashboard slice invariants.
 * - transitionApplication stamps state_entered_at and appends an
 *   application.state_changed event with the actor; tracker transitions are
 *   flagged inferred.
 * - bucketFor collapses the 15-state machine into triage buckets
 *   (buckets for sorting, states for truth).
 * - daysInState / stallFor: per-state stall semantics, not just age.
 * - legitimacyFor: mechanical, stated checks only — never a black box.
 * - classifyReply: auto-acks are labeled; only human replies may jump.
 * - buildDashboard: KPIs (no response-rate headline), cost-of-ignoring
 *   ordering, human-reply jump, inferred/confirmed separation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bucketFor,
  buildDashboard,
  daysInState,
  findGhostingCandidates,
  legitimacyFor,
  normalizeEmployer,
  stallFor,
  worthItFor,
} from "../apps/server/src/dashboard.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { classifyReply } from "../apps/server/src/tracker/gmail-track.ts";
import { transitionApplication } from "../apps/server/src/transitions.ts";
import {
  type Application,
  type ApplicationState,
  type DomainEvent,
  domainKinds,
  type JobPosting,
} from "../packages/domain/src/openapply.ts";

const owner = "owner-dashboard";

class FakeDomain {
  events: { type: string; payload: Record<string, unknown>; created_at: string }[] = [];
  async recordEvent(_o: string, type: string, payload: Record<string, unknown>) {
    this.events.push({ type, payload, created_at: new Date().toISOString() });
    return {
      id: "e1",
      type,
      payload,
      notify: false,
      created_at: new Date().toISOString(),
      delivered_channels: [],
    };
  }
}

function app(id: string, state: ApplicationState, enteredDaysAgo = 0): Application {
  return {
    id,
    job_id: "job-acme",
    state,
    state_entered_at: new Date(Date.now() - enteredDaysAgo * 86_400_000).toISOString(),
  };
}

function job(): JobPosting {
  return {
    id: "job-acme",
    source: "greenhouse",
    source_url: "https://boards.greenhouse.io/acme/jobs/1",
    apply_url: "https://boards.greenhouse.io/acme/jobs/1#apply",
    company_name: "Acme",
    title: "Accountant",
    location_text: "Lagos, Nigeria",
    raw_text: "Accountant needed",
    requirements: [],
    qualifications: [],
    content_hash: "h",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    is_active: true,
  };
}

test("transitionApplication stamps state_entered_at and logs the actor", async () => {
  const db = await createStore();
  const domain = new FakeDomain();
  const a = app("a1", "pack_approved");
  await db.put(owner, domainKinds.applications, a);
  const updated = await transitionApplication(
    { db, recordEvent: (o, t, p) => domain.recordEvent(o, t, p) },
    owner,
    a,
    "session_needed",
    "system",
  );
  assert.equal(updated.state, "session_needed");
  assert.ok(updated.state_entered_at);
  assert.equal(domain.events.length, 1);
  const payload = domain.events[0].payload;
  assert.equal(payload.previous_state, "pack_approved");
  assert.equal(payload.new_state, "session_needed");
  assert.equal(payload.actor, "system");
  assert.equal(payload.inferred, false);
});

test("tracker transitions are flagged inferred", async () => {
  const db = await createStore();
  const domain = new FakeDomain();
  const a = app("a2", "submitted");
  await db.put(owner, domainKinds.applications, a);
  await transitionApplication(
    { db, recordEvent: (o, t, p) => domain.recordEvent(o, t, p) },
    owner,
    a,
    "awaiting_reply",
    "tracker",
    "Gmail: interview invite",
    { reply_kind: "human" },
  );
  const payload = domain.events[0].payload;
  assert.equal(payload.actor, "tracker");
  assert.equal(payload.inferred, true);
  assert.equal(payload.reply_kind, "human");
});

test("ghosted is a real closed bucket, not terminal", () => {
  assert.equal(bucketFor("ghosted"), "closed");
});

test("worthItFor: deterministic, explainable, never a black box", () => {
  const verified: { level: "verified"; checks: string[] } = {
    level: "verified",
    checks: ["Seen on greenhouse"],
  };
  const unknown: { level: "unknown"; checks: string[] } = { level: "unknown", checks: [] };
  const w1 = worthItFor(verified, 82, ["title matches your wanted titles"]);
  assert.equal(w1.verdict, "worth_it");
  assert.ok(w1.reason.includes("title matches"));
  const w2 = worthItFor(unknown, 30, null);
  assert.equal(w2.verdict, "skip");
  const w3 = worthItFor(unknown, 70, ["location matches"]);
  assert.equal(w3.verdict, "marginal");
});

test("worthItFor: exclusion reasons never read as positive fit", () => {
  const verified: { level: "verified"; checks: string[] } = {
    level: "verified",
    checks: ["Seen on greenhouse"],
  };
  // Ranker pushes exclusion reasons first; the card must not cite them as fit.
  const w = worthItFor(verified, 82, ['title matches excluded term "intern"', "location matches"]);
  assert.equal(w.verdict, "worth_it");
  assert.ok(!w.reason.includes("excluded"), w.reason);
  assert.ok(w.reason.includes("location matches"), w.reason);
});

test("normalizeEmployer strips legal suffixes", () => {
  assert.equal(normalizeEmployer("First Bank Ltd."), "first bank");
  assert.equal(normalizeEmployer("Acme Inc"), "acme");
});

test("findGhostingCandidates: deterministic silence rule", async () => {
  const db = await createStore();
  await seedDashboard(db);
  // A truly silent application: awaiting_reply, 30d, no events at all.
  await db.put(owner, domainKinds.applications, app("w2", "awaiting_reply", 30));
  const dash = await buildDashboard(db, owner);
  const cands = findGhostingCandidates(dash.cards, 21);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].application_id, "w2");
  assert.ok(cands[0].silent_days >= 21);
  // w1 had an auto-ack 1 hour ago — a signal, so not ghosted.
  assert.ok(!cands.some((c) => c.application_id === "w1"));
  // higher threshold → no candidates
  assert.equal(findGhostingCandidates(dash.cards, 90).length, 0);
});
test("bucketFor: buckets for sorting, states for truth", () => {
  assert.equal(bucketFor("submit_ready"), "needs_you");
  assert.equal(bucketFor("pack_review"), "needs_you");
  assert.equal(bucketFor("session_needed"), "needs_you");
  assert.equal(bucketFor("awaiting_reply"), "waiting_on_them");
  assert.equal(bucketFor("interviewing"), "interviews");
  assert.equal(bucketFor("closed_won"), "closed");
  assert.equal(bucketFor("withdrawn"), "closed");
  assert.equal(bucketFor("discovered"), "fresh");
  assert.equal(bucketFor("ranked"), "fresh");
});

test("stallFor: per-state decay semantics", () => {
  assert.equal(stallFor("pack_review", 3).stalled, false);
  const stalled = stallFor("pack_review", 9);
  assert.equal(stalled.stalled, true);
  assert.ok(stalled.label?.includes("9d"));
  const silent = stallFor("awaiting_reply", 24);
  assert.equal(silent.stalled, true);
  assert.ok(silent.label?.includes("ghost"));
  assert.equal(stallFor("interviewing", 5).stalled, false);
});

test("daysInState counts whole days from state_entered_at", () => {
  assert.equal(daysInState(app("x", "pack_review", 5)), 5);
  assert.equal(daysInState({ id: "y", job_id: "j", state: "ranked" }), 0);
});

test("legitimacyFor: stated checks, honest levels", () => {
  const full = legitimacyFor(job(), true);
  assert.equal(full.level, "verified");
  assert.ok(full.checks.length >= 3);
  const thin = legitimacyFor(
    {
      ...job(),
      source: "manual",
      apply_url: undefined,
      last_seen_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    },
    false,
  );
  assert.equal(thin.level, "unknown");
  assert.equal(legitimacyFor(null, false).level, "unknown");
});

test("classifyReply: auto-acks labeled, humans pass", () => {
  const auto = classifyReply({
    from: "noreply@acme.example",
    subject: "Application received",
    body: "Thank you for applying. This is an automated message, do not reply.",
  });
  assert.equal(auto, "auto");
  const human = classifyReply({
    from: "adaeze@acme.example",
    subject: "Interview invitation — Accountant role",
    body: "Hi Ahmad, we'd like to invite you for a chat on Thursday. Are you available?",
  });
  assert.equal(human, "human");
});

async function seedDashboard(db: Store) {
  await db.put(owner, domainKinds.jobPostings, job());
  await db.put(owner, "job_scores", {
    id: "job-acme",
    job_id: "job-acme",
    score: 82,
    reasons: ["title matches your wanted titles", "location matches your preferences"],
    missing_requirements: [],
    evidence_ids_relevant: [],
    scored_at: new Date().toISOString(),
  });
  // needs_you ordered by cost-of-ignoring: submit_ready first, then stale pack_review
  await db.put(owner, domainKinds.applications, app("n1", "pack_review", 9));
  await db.put(owner, domainKinds.applications, app("n2", "submit_ready", 1));
  await db.put(owner, domainKinds.applications, app("w1", "awaiting_reply", 25));
  await db.put(owner, domainKinds.applications, app("i1", "interviewing", 2));
  await db.put(owner, domainKinds.applications, app("c1", "closed_lost", 30));
  await db.put(owner, domainKinds.applications, app("c2", "withdrawn", 30));
  // A human-voice tracker reply on w1: recorded as an event (the log the
  // dashboard reads), not just on the application row.
  const replyEvent: DomainEvent = {
    id: "evt-reply",
    type: "application.state_changed",
    payload: {
      application_id: "w1",
      job_id: "job-acme",
      previous_state: "submitted",
      new_state: "awaiting_reply",
      actor: "tracker",
      inferred: true,
      reply_kind: "human",
      note: "Gmail: interview invitation from adaeze@acme.example",
    },
    notify: false,
    created_at: new Date(Date.now() - 3600_000).toISOString(),
    delivered_channels: [],
  };
  await db.put(owner, domainKinds.events, replyEvent);
}

test("buildDashboard: KPIs, ordering, stall, evidence, legitimacy", async () => {
  const db = await createStore();
  await seedDashboard(db);
  const dash = await buildDashboard(db, owner);
  assert.equal(dash.kpis.active, 4);
  assert.equal(dash.kpis.awaiting_reply, 1);
  assert.equal(dash.kpis.interviews, 1);
  assert.equal(dash.kpis.applied, 3);
  assert.equal(dash.kpis.walked_away, 1);
  // "active" excludes pipeline inventory
  await db.put(owner, domainKinds.applications, app("f1", "ranked"));
  const dash2 = await buildDashboard(db, owner);
  assert.equal(dash2.kpis.active, 4);
  assert.equal(dash2.kpis.fresh, 1);

  const needs = dash.cards.filter((c) => c.bucket === "needs_you");
  assert.equal(needs[0].application.id, "n2"); // submit_ready: irreversibility first
  assert.equal(needs[1].application.id, "n1"); // then stale pack_review
  assert.equal(needs[1].stall.stalled, true);

  const w1 = dash.cards.find((c) => c.application.id === "w1");
  assert.ok(w1);
  assert.equal(w1.evidence_line, "title matches your wanted titles");
  assert.equal(w1.legitimacy.level, "verified");
  assert.ok(w1.legitimacy.checks.length > 0);
  assert.equal(w1.last_human_reply_at !== null, true);
  assert.equal(w1.transitions.length, 1);
  assert.equal(w1.transitions[0].inferred, true);
  assert.equal(w1.stall.stalled, true);
  assert.ok(w1.stall.label?.includes("ghost"));
  assert.equal(w1.worth_it.verdict, "worth_it");
  assert.ok(w1.cost.label.includes("approval"));

  // Per-employer aggregates
  assert.ok(dash.employers.length > 0);
  const acme = dash.employers.find((e) => e.employer === "Acme");
  assert.ok(acme);
});
