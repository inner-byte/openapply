/**
 * Adaptive CV invariants (debate slice).
 * - selectTemplate is deterministic and explainable: the same job always
 *   yields the same template, and the reason is a one-line human sentence.
 * - Unknown job -> the requested (fallback) template is kept untouched.
 * - validateAdaptation refuses anything outside the enumerated surface
 *   (section order, bullets-per-role, evidence prominence) — loudly.
 * - planSections is deterministic, grounds "what leads" in real entries, and
 *   its output always passes validateAdaptation.
 * - buildCoaching: ghosted applications are censored from denominators;
 *   fewer than 5 known outcomes -> insufficient_data, never n=1 "optimization".
 * - recordTemplateSelection logs cv.template_selected with the full trail.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildCoaching,
  extractFeatures,
  isTemplateId,
  type JobLike,
  planSections,
  recordTemplateSelection,
  selectTemplate,
  validateAdaptation,
} from "../apps/server/src/adaptive-cv.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { ResumeContent } from "../apps/server/src/foundry/model.ts";
import {
  type Application,
  type ApplicationState,
  domainKinds,
} from "../packages/domain/src/openapply.ts";

const owner = "owner-adaptive-cv";

function job(overrides: Partial<JobLike> = {}): JobLike {
  return {
    id: "job-1",
    title: "Software Engineer",
    source: "greenhouse",
    requirements: ["TypeScript", "React", "Node.js"],
    qualifications: ["3+ years experience"],
    ...overrides,
  };
}

/* ---------------- selection ---------------- */

test("selectTemplate is deterministic", () => {
  const j = job();
  const a = selectTemplate(j, undefined, "template-one");
  const b = selectTemplate(j, undefined, "template-one");
  assert.deepEqual(a, b);
});

test("ATS-portal graduate role -> Compact (the spec example)", () => {
  const sel = selectTemplate(
    job({ title: "Graduate Trainee", source: "greenhouse" }),
    undefined,
    "template-one",
  );
  assert.equal(sel.template_id, "template-three");
  assert.match(sel.reason, /Compact/);
  assert.equal(typeof sel.reason, "string");
});

test("ATS-portal senior role -> ATS Classic (parser compatibility first)", () => {
  const sel = selectTemplate(
    job({ title: "Senior Accountant", source: "lever" }),
    undefined,
    "template-one",
  );
  assert.equal(sel.template_id, "template-seven");
});

test("executive role -> Executive template", () => {
  const sel = selectTemplate(
    job({ title: "Director of Engineering", source: "manual" }),
    undefined,
    "template-one",
  );
  assert.equal(sel.template_id, "template-four");
});

test("tech role via email -> Modern Accent; finance via email -> Corporate Grid", () => {
  const tech = selectTemplate(
    job({ title: "Frontend Developer", source: "manual" }),
    undefined,
    "template-one",
  );
  assert.equal(tech.template_id, "template-two");
  const fin = selectTemplate(
    job({ title: "Audit Associate", source: "manual" }),
    undefined,
    "template-one",
  );
  assert.equal(fin.template_id, "template-six");
});

test("referral channel override -> Minimal (human reads first)", () => {
  const sel = selectTemplate(
    job({ title: "Operations Coordinator", source: "manual" }),
    undefined,
    "template-one",
    "referral",
  );
  assert.equal(sel.template_id, "template-five");
  assert.equal(sel.features?.channel, "referral");
});

test("unknown job -> requested template kept untouched", () => {
  const sel = selectTemplate(null, undefined, "template-two");
  assert.equal(sel.template_id, "template-two");
  assert.equal(sel.features, null);
  assert.match(sel.reason, /requested template/);
});

test("unknown fallback id -> first template, not a crash", () => {
  const sel = selectTemplate(null, undefined, "nope-not-a-template");
  assert.equal(sel.template_id, "template-one");
  assert.ok(isTemplateId(sel.template_id));
});

test("extractFeatures: seniority, industry, channel", () => {
  assert.deepEqual(extractFeatures(job({ title: "Junior QA Engineer", source: "rss" }), {}), {
    seniority: "entry",
    industry: "tech",
    channel: "email",
  });
  assert.deepEqual(extractFeatures(job({ title: "Head of Finance", source: "linkedin" }), {}), {
    seniority: "executive",
    industry: "finance",
    channel: "ats",
  });
});

test("preferences role_levels disambiguate an untitled seniority", () => {
  const sel = selectTemplate(
    job({ title: "Product Specialist", source: "manual" }),
    { role_levels: ["entry"] },
    "template-one",
  );
  assert.equal(sel.template_id, "template-three");
  assert.equal(sel.features?.seniority, "entry");
});

/* ---------------- mutation surface ---------------- */

const VALID_ORDER = ["experience", "projects", "education", "skills", "certificates"] as const;

test("validateAdaptation accepts the full enumerated surface", () => {
  const out = validateAdaptation({
    section_order: [...VALID_ORDER],
    bullets_per_entry: { "Acme Corp": 4 },
    lead_evidence_ids: ["ev-1"],
  });
  assert.deepEqual(out.section_order, [...VALID_ORDER]);
  assert.deepEqual(out.bullets_per_entry, { "Acme Corp": 4 });
  assert.deepEqual(out.lead_evidence_ids, ["ev-1"]);
});

test("validateAdaptation refuses titles, skill claims, dates — loudly", () => {
  for (const bad of [
    { section_order: [...VALID_ORDER], titles: ["Senior Wizard"] },
    { section_order: [...VALID_ORDER], skill_claims: ["10x engineer"] },
    { section_order: [...VALID_ORDER], dates: { "Acme Corp": "2020-2025" } },
    { section_order: [...VALID_ORDER], employers: ["Google"] },
    { section_order: [...VALID_ORDER], degrees: ["PhD"] },
  ]) {
    assert.throws(() => validateAdaptation(bad), /outside the allowed mutation surface/);
  }
});

test("validateAdaptation refuses malformed surface values", () => {
  assert.throws(() => validateAdaptation({ section_order: ["experience"] }), /permutation/);
  assert.throws(
    () => validateAdaptation({ section_order: [...VALID_ORDER, ...VALID_ORDER] }),
    /permutation/,
  );
  assert.throws(
    () => validateAdaptation({ section_order: [...VALID_ORDER], bullets_per_entry: { x: 99 } }),
    /1\.\.20/,
  );
  assert.throws(() => validateAdaptation("not-an-object"), /expected an object/);
  assert.throws(() => validateAdaptation(null), /expected an object/);
});

/* ---------------- section planning ---------------- */

function resume(): ResumeContent {
  return {
    full_name: "Test User",
    links: [],
    email: "t@example.com",
    mobile: "123",
    education: [{ institution: "Uni", location: "X", degree: "BSc", dates: "2020-2024" }],
    skills: [{ category: "Languages", items: "TypeScript, React" }],
    experience: [
      {
        title: "Frontend Developer",
        dates: "2022-2024",
        bullets: [
          "Built React dashboards with TypeScript",
          "Shipped Node.js APIs",
          "Unrelated admin work",
          "More admin",
          "Even more admin",
          "Still more admin",
          "Way too many bullets",
        ],
      },
      {
        title: "Retail Assistant",
        dates: "2020-2022",
        bullets: ["Stocked shelves", "Helped customers"],
      },
    ],
    projects: [
      {
        title: "React Portfolio",
        dates: "2023",
        bullets: ["TypeScript React portfolio site"],
      },
    ],
    certificates: [],
  };
}

test("planSections is deterministic and grounds what leads", () => {
  const input = {
    template_id: "template-three" as const,
    job: { title: "Frontend Developer", requirements: ["TypeScript", "React"], qualifications: [] },
    resume: resume(),
  };
  const a = planSections(input);
  const b = planSections(input);
  assert.deepEqual(a, b);
  // Experience leads: the Frontend Developer entry matches best.
  assert.equal(a.items[0].section, "experience");
  assert.equal(a.items[0].leads_with, "Frontend Developer");
  assert.match(a.items[0].why, /Frontend Developer/);
  // One-line whys on every item.
  for (const item of a.items) {
    assert.equal(typeof item.why, "string");
    assert.ok(item.why.length > 0 && !item.why.includes("\n"));
  }
  // Over-budget entry is trimmed to the template budget (Compact: 8).
  // 7 bullets <= 8, so nothing trimmed here; use template-one (budget 6).
  const trimmed = planSections({ ...input, template_id: "template-one" });
  assert.equal(trimmed.adaptation.bullets_per_entry["Frontend Developer"], 6);
  assert.ok(!("Retail Assistant" in trimmed.adaptation.bullets_per_entry));
  // The plan always passes the strict validator.
  assert.doesNotThrow(() => validateAdaptation(a.adaptation));
  assert.doesNotThrow(() => validateAdaptation(trimmed.adaptation));
});

/* ---------------- template_selected logging ---------------- */

test("recordTemplateSelection logs cv.template_selected", async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const deps = {
    recordEvent: async (_o: string, type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
      return {};
    },
  };
  const selection = selectTemplate(job(), undefined, "template-one");
  await recordTemplateSelection(deps, owner, "app-1", "job-1", selection, "template-one");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "cv.template_selected");
  const p = events[0].payload;
  assert.equal(p.application_id, "app-1");
  assert.equal(p.job_id, "job-1");
  assert.equal(p.template_id, selection.template_id);
  assert.equal(p.reason, selection.reason);
  assert.equal(p.requested_template_id, "template-one");
  assert.ok(typeof p.at === "string");
});

/* ---------------- coaching ---------------- */

class FakeProfileStore {
  constructor(private evidence: Array<{ id: string; file_name: string; text_excerpt: string }>) {}
  async get(_owner: string) {
    return { evidence: this.evidence };
  }
}

async function seedCoaching(
  db: Store,
  dataDir: string,
  apps: Array<{ id: string; state: ApplicationState; evidence: string[] }>,
) {
  const profileStore = new FakeProfileStore([
    { id: "ev-a", file_name: "bcom.pdf", text_excerpt: "B.Com Accountancy, First Class" },
    { id: "ev-b", file_name: "cfa.pdf", text_excerpt: "climateforafrica.org founder" },
  ]);
  await mkdir(join(dataDir, "drafts"), { recursive: true });
  let n = 0;
  for (const app of apps) {
    n++;
    const application: Application = { id: app.id, job_id: "job-1", state: app.state };
    await db.put(owner, domainKinds.applications, { ...application, pack_id: `pack-${app.id}` });
    const artifactId = `draft-${app.id}`;
    await db.put(owner, domainKinds.artifacts, {
      id: artifactId,
      kind: "resume_draft",
      application_id: app.id,
      mime: "application/json",
      sha256: "x",
      byte_size: 10,
      storage_path: `drafts/${artifactId}.json`,
      created_at: new Date(Date.now() + n).toISOString(),
    });
    await writeFile(
      join(dataDir, "drafts", `${artifactId}.json`),
      JSON.stringify({ evidence_ids_used: app.evidence }),
    );
  }
  return { db, dataDir, profileStore };
}

test("buildCoaching: insufficient_data below 5 known outcomes", async () => {
  const db = await createStore();
  const dataDir = await mkdtemp(join(tmpdir(), "oa-coach-"));
  const deps = await seedCoaching(db, dataDir, [
    { id: "a1", state: "interviewing", evidence: ["ev-a"] },
    { id: "a2", state: "closed_lost", evidence: ["ev-a"] },
  ]);
  const result = await buildCoaching(deps, owner);
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.read_only, true);
  if (result.status === "insufficient_data") {
    assert.match(result.message, /5 needed/);
    assert.equal(result.known_outcomes, 2);
  }
});

test("buildCoaching: ghosted applications are censored from denominators", async () => {
  const db = await createStore();
  const dataDir = await mkdtemp(join(tmpdir(), "oa-coach-"));
  const deps = await seedCoaching(db, dataDir, [
    { id: "a1", state: "interviewing", evidence: ["ev-a"] },
    { id: "a2", state: "closed_won", evidence: ["ev-a", "ev-b"] },
    { id: "a3", state: "closed_lost", evidence: ["ev-a"] },
    { id: "a4", state: "interviewing", evidence: ["ev-b"] },
    { id: "a5", state: "closed_lost", evidence: ["ev-b"] },
    // Ghosts cite ev-a heavily but must not move any denominator.
    { id: "g1", state: "ghosted", evidence: ["ev-a"] },
    { id: "g2", state: "ghosted", evidence: ["ev-a"] },
    { id: "g3", state: "ghosted", evidence: ["ev-a"] },
    // Still-waiting: not a known outcome, excluded too.
    { id: "w1", state: "awaiting_reply", evidence: ["ev-a"] },
  ]);
  const result = await buildCoaching(deps, owner);
  assert.equal(result.status, "ok");
  assert.equal(result.read_only, true);
  if (result.status !== "ok") throw new Error("unreachable");
  assert.match(result.note, /never mutates any CV/);
  assert.equal(result.known_outcomes, 5);
  const byId = new Map(result.details.map((d) => [d.evidence_id, d]));
  const a = byId.get("ev-a");
  assert.ok(a);
  // cited_in counts only known outcomes: a1, a2, a3 (not g1-g3, not w1).
  assert.equal(a.cited_in, 3);
  assert.equal(a.n, 3);
  // replies: interviewing + closed_won (a1, a2). closed_lost is known but not a reply.
  assert.equal(a.replies, 2);
  assert.equal(a.reply_rate, Math.round((2 / 3) * 100) / 100);
  assert.match(a.detail, /B\.Com/);
  const b = byId.get("ev-b");
  assert.ok(b);
  assert.equal(b.cited_in, 3);
  assert.equal(b.replies, 2);
});
