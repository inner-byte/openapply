/**
 * Applications dashboard (debate slice).
 *
 * A read model over applications + jobs + scores + transition events. The
 * debate panel's decisions are encoded here:
 * - KPI row: Active, Awaiting reply, Interviews, Applied vs Walked-away
 *   (selectivity). No response-rate headline.
 * - Buckets for sorting, states for truth: the 15-state machine is collapsed
 *   into needs_you / waiting_on_them / interviews / closed / fresh for triage,
 *   but the detail view exposes the real state and its transition log.
 * - "Needs you" is ordered by cost-of-ignoring: submit_ready first (the
 *   highest-stakes state), then by days-in-state.
 * - No match score on the card face; one mechanically-sourced evidence line
 *   (the ranker's deterministic reasons) instead.
 * - Legitimacy marker (gate-shaped dot + stated checks), never a black box.
 * - Stall semantics per state; inferred (tracker) transitions flagged so the
 *   client can separate them from confirmed ones.
 */
import type {
  Application,
  ApplicationState,
  Approval,
  DomainEvent,
  JobPosting,
} from "../../../packages/domain/src/openapply.ts";
import { applicationStateSchema, domainKinds } from "../../../packages/domain/src/openapply.ts";
import type { Store } from "./db.ts";
import type { JobScore } from "./ranker.ts";

export type DashboardBucket = "needs_you" | "waiting_on_them" | "interviews" | "closed" | "fresh";

export interface Legitimacy {
  level: "verified" | "likely" | "unknown";
  /** The mechanical checks that passed, in plain words. The basis is always
   *  shown — a marker is never a verdict without its reasons. */
  checks: string[];
}

export interface StallInfo {
  stalled: boolean;
  /** Shown on the card when stalled, e.g. "Silent 24d — consider a nudge". */
  label?: string;
}

export interface TransitionEntry {
  from: ApplicationState | null;
  to: ApplicationState;
  at: string;
  actor: string;
  inferred: boolean;
  /** Tracker-only: deterministic human vs auto-ack classification. */
  reply_kind?: "human" | "auto";
  note?: string;
}

export interface DashboardCard {
  application: Application;
  job: (JobPosting & { id: string }) | null;
  score: number | null;
  /** One mechanically-sourced evidence line (ranker reasons), never generated. */
  evidence_line: string | null;
  bucket: DashboardBucket;
  days_in_state: number;
  stall: StallInfo;
  legitimacy: Legitimacy;
  transitions: TransitionEntry[];
  /** When the employer last replied in a human voice (tracker), if known. */
  last_human_reply_at: string | null;
  /** Latest auto-ack, shown as a dim inline marker — never a jump. */
  last_auto_ack_at: string | null;
  /** Worth-It verdict + one-line cited reason, on the card face. */
  worth_it: WorthIt;
  /** What this application has cost so far (approvals, steps). */
  cost: CostSoFar;
}

export interface DashboardKpis {
  /** shortlisted → interviewing. discovered/ranked are pipeline inventory. */
  active: number;
  awaiting_reply: number;
  interviews: number;
  /** Filings are a cost measure, kept secondary. */
  applied: number;
  walked_away: number;
  fresh: number;
}

export interface EmployerStats {
  employer: string;
  applications: number;
  human_replies: number;
  ghosted: number;
  /** Plain-words line, e.g. "replied to 1 of 3 · ghosted 2". */
  label: string;
}

export interface Dashboard {
  kpis: DashboardKpis;
  cards: DashboardCard[];
  employers: EmployerStats[];
}

/** Normalize employer names for aggregation: lowercase, strip legal suffixes. */
export function normalizeEmployer(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(ltd|limited|inc|incorporated|corp|corporation|llc|plc|gmbh|pty)\b\.?/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NEEDS_YOU: ReadonlySet<ApplicationState> = new Set([
  "submit_ready",
  "pack_review",
  "session_needed",
  "shortlisted",
  "pack_drafting",
  "prefilled",
]);
/** Cost-of-ignoring order inside "Needs you": irreversibility first. */
const NEEDS_YOU_ORDER: ApplicationState[] = [
  "submit_ready",
  "pack_review",
  "session_needed",
  "shortlisted",
  "prefilled",
  "pack_drafting",
];
const WAITING_ON_THEM: ReadonlySet<ApplicationState> = new Set(["submitted", "awaiting_reply"]);
const CLOSED: ReadonlySet<ApplicationState> = new Set([
  "ghosted",
  "closed_won",
  "closed_lost",
  "withdrawn",
]);
const FRESH: ReadonlySet<ApplicationState> = new Set(["discovered", "ranked"]);
/** States that count as a filing (cost), for applied-vs-walked-away. */
const APPLIED: ReadonlySet<ApplicationState> = new Set([
  "submitted",
  "awaiting_reply",
  "interviewing",
  "ghosted",
  "closed_won",
  "closed_lost",
]);

export function bucketFor(state: ApplicationState): DashboardBucket {
  if (NEEDS_YOU.has(state)) return "needs_you";
  if (WAITING_ON_THEM.has(state)) return "waiting_on_them";
  if (state === "interviewing") return "interviews";
  if (CLOSED.has(state)) return "closed";
  if (FRESH.has(state)) return "fresh";
  return "fresh";
}

/** Per-state stall thresholds in days. A stall is decay, not just age. */
const STALL_AFTER_DAYS: Partial<Record<ApplicationState, number>> = {
  pack_review: 7,
  session_needed: 3,
  submit_ready: 3,
  shortlisted: 14,
  pack_drafting: 2,
  prefilled: 2,
  submitted: 14,
  awaiting_reply: 21,
  interviewing: 14,
};

const STALL_LABELS: Partial<Record<ApplicationState, (days: number) => string>> = {
  pack_review: (d) => `Review decaying — ${d}d untouched`,
  session_needed: (d) => `Waiting on you — ${d}d`,
  submit_ready: (d) => `Submit approval aging — ${d}d`,
  shortlisted: (d) => `Not started — ${d}d`,
  pack_drafting: (d) => `Draft stuck? — ${d}d`,
  prefilled: (d) => `Prefill stuck? — ${d}d`,
  submitted: (d) => `No reply in ${d}d`,
  awaiting_reply: (d) => `Silent ${d}d — nudge, withdraw, or flag as ghost`,
  interviewing: (d) => `No movement in ${d}d — follow up?`,
};

export function daysInState(app: Application, now = Date.now()): number {
  const entered = app.state_entered_at ? Date.parse(app.state_entered_at) : NaN;
  if (Number.isNaN(entered)) return 0;
  return Math.max(0, Math.floor((now - entered) / 86_400_000));
}

export function stallFor(state: ApplicationState, days: number): StallInfo {
  const threshold = STALL_AFTER_DAYS[state];
  if (threshold === undefined || days < threshold) return { stalled: false };
  const label = STALL_LABELS[state]?.(days);
  return { stalled: true, label };
}

/**
 * Legitimacy marker from mechanical, stated checks only. Majority vote of the
 * panel: show the marker on the card face, but never as a black box — the
 * checks that passed travel with it.
 */
export function legitimacyFor(job: JobPosting | null, hasBrief: boolean): Legitimacy {
  const checks: string[] = [];
  if (!job) return { level: "unknown", checks };
  const knownBoard = new Set(["greenhouse", "lever", "ashby", "linkedin", "indeed", "government"]);
  if (knownBoard.has(job.source)) checks.push(`Seen on ${job.source}`);
  if (job.apply_url) checks.push("Has an apply link");
  if (hasBrief) checks.push("Company brief on file");
  const lastSeen = Date.parse(job.last_seen_at ?? "");
  if (!Number.isNaN(lastSeen) && Date.now() - lastSeen < 30 * 86_400_000)
    checks.push("Posting seen recently");
  const level = checks.length >= 3 ? "verified" : checks.length === 2 ? "likely" : "unknown";
  return { level, checks };
}

function transitionFromEvent(e: DomainEvent): TransitionEntry | null {
  if (e.type !== "application.state_changed") return null;
  const p = e.payload as Record<string, unknown>;
  // A malformed event must never inject garbage into the timeline.
  const to = applicationStateSchema.safeParse(p.new_state);
  if (!to.success) return null;
  const from =
    p.previous_state === undefined || p.previous_state === null
      ? null
      : applicationStateSchema.safeParse(p.previous_state);
  return {
    from: from === null ? null : from.success ? from.data : null,
    to: to.data,
    at: e.created_at,
    actor: String(p.actor ?? "system"),
    inferred: p.inferred === true,
    reply_kind: p.reply_kind === "human" || p.reply_kind === "auto" ? p.reply_kind : undefined,
    note: typeof p.note === "string" ? p.note : undefined,
  };
}

export interface WorthIt {
  verdict: "worth_it" | "marginal" | "skip";
  /** One-line cited reason. Always shown with the verdict. */
  reason: string;
}

export interface CostSoFar {
  approvals: number;
  transitions: number;
  /** Plain-words summary, e.g. "3 approvals · 8 steps". */
  label: string;
}

export interface GhostingCandidate {
  application_id: string;
  silent_days: number;
}

/**
 * Worth-It verdict: deterministic, explainable, displayed on the card face.
 * It disciplines volume — the scarcest resource is the seeker's effort.
 * This is a display verdict, not a gate; it never blocks the user.
 *
 * The reason is built from the ranker's own stated reasons — but exclusion
 * reasons ("title matches excluded term") are filtered out first, so a
 * negative can never read as a positive on the card face.
 */
export function worthItFor(
  legitimacy: Legitimacy,
  score: number | null,
  reasons: readonly string[] | null | undefined,
): WorthIt {
  const positive = (reasons ?? []).filter((r) => !/excluded|not in your preferences/i.test(r));
  const evidenceLine = positive[0] ?? null;
  if (legitimacy.level === "unknown" && (score ?? 0) < 40)
    return {
      verdict: "skip",
      reason: "Employer unverified and weak fit — effort better spent elsewhere",
    };
  if (legitimacy.level === "unknown")
    return { verdict: "marginal", reason: "Proceed carefully — employer not yet verified" };
  if ((score ?? 0) >= 60 && evidenceLine)
    return {
      verdict: "worth_it",
      reason: `Strong fit (${evidenceLine}) on a ${legitimacy.level} posting`,
    };
  if ((score ?? 0) >= 60)
    return { verdict: "worth_it", reason: `Good fit on a ${legitimacy.level} posting` };
  return { verdict: "marginal", reason: "Fit signal is thin — weigh the effort" };
}

/**
 * Deterministic ghost rule: an application sitting in submitted/awaiting_reply
 * with no transition event for `afterDays` is ghosted. Ghosted is a real
 * logged state (not a label) — and it is NOT terminal, so a late employer
 * reply can still move it back via the tracker.
 */
export function findGhostingCandidates(
  cards: DashboardCard[],
  afterDays: number,
  now = Date.now(),
): GhostingCandidate[] {
  const out: GhostingCandidate[] = [];
  for (const card of cards) {
    const state = card.application.state;
    if (state !== "submitted" && state !== "awaiting_reply") continue;
    // A recent auto-ack is proof the employer is responsive — it resets the
    // silence clock even though it creates no transition event.
    const candidates = [
      card.transitions.length
        ? Date.parse(card.transitions[card.transitions.length - 1].at)
        : Number.NaN,
      Date.parse(card.application.state_entered_at ?? ""),
      card.last_auto_ack_at ? Date.parse(card.last_auto_ack_at) : Number.NaN,
    ].filter((t) => !Number.isNaN(t));
    if (candidates.length === 0) continue;
    const lastActivity = Math.max(...candidates);
    const silentDays = Math.floor((now - lastActivity) / 86_400_000);
    if (silentDays >= afterDays)
      out.push({ application_id: card.application.id, silent_days: silentDays });
  }
  return out;
}

export async function buildDashboard(db: Store, owner: string): Promise<Dashboard> {
  const applications = await db.list<Application>(owner, domainKinds.applications);
  const jobs = await db.list<JobPosting & { id: string }>(owner, domainKinds.jobPostings);
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const scores = new Map(
    (await db.list<JobScore & { id: string }>(owner, "job_scores")).map((s) => [s.job_id, s]),
  );
  const briefs = await db.list<{ id: string; company_name?: string }>(
    owner,
    domainKinds.companyBriefs,
  );
  const briefCompanies = new Set(
    briefs.map((b) => (b.company_name ?? "").toLowerCase()).filter(Boolean),
  );
  const approvals = await db.list<Approval>(owner, domainKinds.approvals);
  const approvalsByApp = new Map<string, number>();
  for (const a of approvals) {
    if (!a.application_id) continue;
    approvalsByApp.set(a.application_id, (approvalsByApp.get(a.application_id) ?? 0) + 1);
  }
  const events = await db.list<DomainEvent>(owner, domainKinds.events);
  const transitionsByApp = new Map<string, TransitionEntry[]>();
  for (const e of events) {
    const t = transitionFromEvent(e);
    if (!t) continue;
    const appId = String((e.payload as Record<string, unknown>).application_id ?? "");
    if (!appId) continue;
    const list = transitionsByApp.get(appId) ?? [];
    list.push(t);
    transitionsByApp.set(appId, list);
  }
  for (const list of transitionsByApp.values())
    list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const cards: DashboardCard[] = applications.map((application) => {
    const job = jobById.get(application.job_id) ?? null;
    const scoreRow = scores.get(application.job_id);
    const bucket = bucketFor(application.state);
    const days = daysInState(application);
    const transitions = (transitionsByApp.get(application.id) ?? []).slice(-20);
    // Reply signals: only verified human-voice replies may jump the card;
    // auto-acks are recorded for the dim inline marker. Never manufacture
    // the adrenaline spike for an auto-ack.
    let last_human_reply_at: string | null = null;
    let last_auto_ack_at: string | null = null;
    for (let i = transitions.length - 1; i >= 0; i--) {
      const t = transitions[i];
      if (t.actor !== "tracker") continue;
      if (t.reply_kind === "human" && !last_human_reply_at) last_human_reply_at = t.at;
      if (t.reply_kind === "auto" && !last_auto_ack_at) last_auto_ack_at = t.at;
      if (last_human_reply_at && last_auto_ack_at) break;
    }
    const legitimacy = legitimacyFor(
      job,
      job ? briefCompanies.has(job.company_name.toLowerCase()) : false,
    );
    // The evidence line on the card face must never cite a negative
    // ("title matches excluded term") as if it were fit.
    const positiveReasons = (scoreRow?.reasons ?? []).filter(
      (r) => !/excluded|not in your preferences/i.test(r),
    );
    const evidenceLine = positiveReasons[0] ?? null;
    const approvalCount = approvalsByApp.get(application.id) ?? 0;
    const transitionCount = transitions.length;
    return {
      application,
      job,
      score: scoreRow?.score ?? null,
      evidence_line: evidenceLine,
      bucket,
      days_in_state: days,
      stall: stallFor(application.state, days),
      legitimacy,
      transitions,
      last_human_reply_at,
      last_auto_ack_at,
      worth_it: worthItFor(legitimacy, scoreRow?.score ?? null, scoreRow?.reasons),
      cost: {
        approvals: approvalCount,
        transitions: transitionCount,
        label: `${approvalCount} approval${approvalCount === 1 ? "" : "s"} · ${transitionCount} step${transitionCount === 1 ? "" : "s"}`,
      },
    };
  });

  // "Needs you": cost-of-ignoring — irreversibility order, then stale first.
  // A fresh human reply jumps to the top of the section.
  const needsRank = new Map(NEEDS_YOU_ORDER.map((s, i) => [s, i]));
  cards.sort((a, b) => {
    const rank = (c: DashboardCard) =>
      c.bucket === "needs_you"
        ? 0
        : c.bucket === "waiting_on_them"
          ? 1
          : c.bucket === "interviews"
            ? 2
            : c.bucket === "fresh"
              ? 3
              : 4;
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.bucket === "needs_you" && b.bucket === "needs_you") {
      const hr = (b.last_human_reply_at ? 1 : 0) - (a.last_human_reply_at ? 1 : 0);
      if (hr !== 0) return hr;
      const o =
        (needsRank.get(a.application.state) ?? 99) - (needsRank.get(b.application.state) ?? 99);
      if (o !== 0) return o;
      return b.days_in_state - a.days_in_state;
    }
    return b.days_in_state - a.days_in_state;
  });

  const inState = (s: ApplicationState) => cards.filter((c) => c.application.state === s).length;
  const kpis: DashboardKpis = {
    active:
      inState("shortlisted") +
      inState("pack_drafting") +
      inState("pack_review") +
      inState("pack_approved") +
      inState("session_needed") +
      inState("prefilled") +
      inState("submit_ready") +
      inState("submitted") +
      inState("awaiting_reply") +
      inState("interviewing"),
    awaiting_reply: inState("awaiting_reply"),
    interviews: inState("interviewing"),
    applied: [...APPLIED].reduce((n, s) => n + inState(s), 0),
    walked_away: inState("withdrawn"),
    fresh: inState("discovered") + inState("ranked"),
  };

  // Per-employer reply behavior (aggregates, never a gaming leaderboard).
  const byEmployer = new Map<
    string,
    { display: string; apps: number; replies: number; ghosted: number }
  >();
  for (const card of cards) {
    const name = card.job?.company_name ?? "Unknown";
    const key = normalizeEmployer(name);
    const entry = byEmployer.get(key) ?? { display: name, apps: 0, replies: 0, ghosted: 0 };
    entry.apps += 1;
    if (card.last_human_reply_at) entry.replies += 1;
    if (card.application.state === "ghosted") entry.ghosted += 1;
    byEmployer.set(key, entry);
  }
  const employers: EmployerStats[] = [...byEmployer.values()]
    .map((e) => ({
      employer: e.display,
      applications: e.apps,
      human_replies: e.replies,
      ghosted: e.ghosted,
      label: `replied to ${e.replies} of ${e.apps}${e.ghosted > 0 ? ` · ghosted ${e.ghosted}` : ""}`,
    }))
    .sort((a, b) => b.ghosted - a.ghosted || b.applications - a.applications);
  return { kpis, cards, employers };
}
