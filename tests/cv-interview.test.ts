/**
 * CV interview builder invariants.
 * - The question bank is deterministic and hardcoded (never LLM-generated);
 *   no prompt contains a claim about the user.
 * - Answers are stored as verbatim triples; nothing is elaborated.
 * - Completeness = required-filled / required-total; sign-off needs >= 80%.
 * - A contradicting answer opens a conflict and quarantines the field;
 *   quarantined fields block sign-off drafting.
 * - Resolving picks a winner verbatim; the field unquarantines.
 * - Sign-off writes provenance-labeled ("interview") facts to Profile memory
 *   backed by the transcript as evidence, and renders the master draft.
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  answerQuestion,
  applyAnswer,
  buildResumeContent,
  type CvInterview,
  type CvInterviewDeps,
  canSignOff,
  completenessOf,
  contradicts,
  QUESTION_BANK,
  REQUIRED_QUESTIONS,
  resolveConflict,
  sectionStateFor,
  signOffInterview,
  startInterview,
} from "../apps/server/src/cv-interview.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ProfileStore } from "../apps/server/src/profile.ts";

const owner = "owner-cv";

function blank(): CvInterview {
  return {
    id: "iv-1",
    status: "in_progress",
    answers: {},
    conflicts: [],
    provenance: {},
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

test("question bank is hardcoded: exact prompts, no claims about the user", () => {
  assert.equal(QUESTION_BANK.length, 12);
  assert.equal(REQUIRED_QUESTIONS.length, 10);
  const prompts = QUESTION_BANK.map((q) => q.prompt);
  // Literal check: the bank is these strings, nothing generated.
  assert.ok(prompts.includes("What is your full name, exactly as it should appear on your CV?"));
  assert.ok(
    prompts.includes(
      "What did a normal day look like in that role? Describe one concrete thing you actually did, in your own words.",
    ),
  );
  // Fidelity: every prompt is question-led (contains "?"), never a bare
  // statement that could smuggle a claim about the user. Plus a blocklist
  // of claim-shaped phrases.
  const CLAIM_PATTERNS = [/your \d+ years/i, /as an? (accountant|engineer|manager)/i];
  for (const p of prompts) {
    assert.ok(p.includes("?"), `prompt is not question-led: ${p}`);
    for (const pat of CLAIM_PATTERNS) {
      assert.ok(!pat.test(p), `prompt makes a claim: ${p}`);
    }
  }
  // Every question has a section, field, and a "why".
  for (const q of QUESTION_BANK) {
    assert.ok(q.section && q.field && q.why.length > 0);
  }
});

test("answers are stored as verbatim triples", () => {
  const iv = blank();
  const { conflict } = applyAnswer(
    iv,
    "work.latest_day",
    "I swept the shop floor and arranged goods.",
  );
  assert.equal(conflict, null);
  const a = iv.answers.latest_day_detail;
  assert.equal(a.triple.quoted_statement, "I swept the shop floor and arranged goods.");
  assert.equal(a.triple.confirmed, true);
  assert.ok(a.triple.asked_at);
  assert.equal(a.quarantined, false);
});

test("contradiction detection ignores trivial normalization", () => {
  assert.equal(contradicts("Lagos, Nigeria", "lagos nigeria"), false);
  assert.equal(contradicts("Accountant", "Shopkeeper"), true);
});

test("a contradicting answer opens a conflict and quarantines the field", () => {
  const iv = blank();
  applyAnswer(iv, "basics.full_name", "Aliyu Ahmad");
  const { conflict } = applyAnswer(iv, "basics.full_name", "Ahmad Sunusi");
  assert.ok(conflict);
  assert.equal(conflict.existing, "Aliyu Ahmad");
  assert.equal(conflict.incoming, "Ahmad Sunusi");
  assert.equal(conflict.resolved, false);
  assert.equal(iv.answers.full_name.quarantined, true);
  // Quarantined fields do not count as filled.
  assert.equal(completenessOf(iv.answers), 0);
  const check = canSignOff(iv);
  assert.equal(check.ok, false);
  assert.ok(check.reasons.some((r) => r.includes("Quarantined")));
});

test("resolving a conflict picks the winner verbatim and unquarantines", () => {
  const iv = blank();
  applyAnswer(iv, "basics.full_name", "Aliyu Ahmad");
  const { conflict } = applyAnswer(iv, "basics.full_name", "Ahmad Sunusi");
  assert.ok(conflict);
  resolveConflict(iv, conflict.id, "incoming");
  assert.equal(iv.answers.full_name.triple.quoted_statement, "Ahmad Sunusi");
  assert.equal(iv.answers.full_name.quarantined, false);
  assert.equal(iv.conflicts[0].resolved, true);
  assert.equal(iv.conflicts[0].winner, "incoming");
});

test("section states: draft -> correction -> re-draft -> locked", () => {
  const iv = blank();
  assert.equal(sectionStateFor("basics", iv), "draft");
  applyAnswer(iv, "basics.full_name", "Aliyu Ahmad");
  applyAnswer(iv, "basics.full_name", "Ahmad Sunusi");
  assert.equal(sectionStateFor("basics", iv), "correction");
  resolveConflict(iv, iv.conflicts[0].id, "existing");
  // Not all required basics answered yet -> re-draft, not locked.
  assert.equal(sectionStateFor("basics", iv), "re-draft");
  applyAnswer(iv, "basics.email", "a@example.com");
  applyAnswer(iv, "basics.phone", "08000000000");
  applyAnswer(iv, "basics.location", "Zaria, Nigeria");
  assert.equal(sectionStateFor("basics", iv), "locked");
});

test("completeness math and the 80% sign-off gate", () => {
  const iv = blank();
  const answers: Array<[string, string]> = [
    ["basics.full_name", "Aliyu Ahmad"],
    ["basics.email", "a@example.com"],
    ["basics.phone", "08000000000"],
    ["basics.location", "Zaria, Nigeria"],
    ["work.latest_title", "Shop attendant"],
    ["work.latest_employer", "AJ Stores"],
    ["work.latest_dates", "2021 to 2022"],
  ];
  for (const [qid, a] of answers) applyAnswer(iv, qid, a);
  assert.equal(completenessOf(iv.answers), 0.7);
  assert.equal(canSignOff(iv).ok, false);
  applyAnswer(iv, "work.latest_day", "I arranged goods on shelves every morning.");
  assert.equal(completenessOf(iv.answers), 0.8);
  assert.equal(canSignOff(iv).ok, true);
  assert.equal(iv.status, "ready_for_signoff");
});

test("buildResumeContent is mechanical: verbatim quotes, no elaboration", () => {
  const iv = blank();
  applyAnswer(iv, "basics.full_name", "Aliyu Ahmad");
  applyAnswer(iv, "work.latest_title", "Shop attendant");
  applyAnswer(iv, "work.latest_employer", "AJ Stores");
  applyAnswer(iv, "work.latest_day", "I arranged goods on shelves every morning.");
  applyAnswer(iv, "skills.top", "sweeping, arranging, customer care");
  const resume = buildResumeContent(iv);
  assert.equal(resume.full_name, "Aliyu Ahmad");
  assert.equal(resume.experience[0].title, "Shop attendant — AJ Stores");
  assert.deepEqual(resume.experience[0].bullets, ["I arranged goods on shelves every morning."]);
  assert.deepEqual(resume.skills, [
    { category: "Skills", items: "sweeping, arranging, customer care" },
  ]);
});

class FakeDomain {
  events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  async recordEvent(_o: string, type: string, payload: Record<string, unknown>) {
    this.events.push({ type, payload });
    return { id: "e1" };
  }
}

async function signoffDeps(): Promise<{
  deps: CvInterviewDeps;
  domain: FakeDomain;
  profileStore: ProfileStore;
}> {
  const db = await createStore();
  const domain = new FakeDomain();
  const directory = await mkdtemp(join(tmpdir(), "openapply-cv-"));
  const profileStore = new ProfileStore(db, directory);
  const deps: CvInterviewDeps = {
    db,
    recordEvent: (o, t, p) => domain.recordEvent(o, t, p),
    profileStore,
    renderResume: async () => ({ pdf: Buffer.from("%PDF-1.4 fake") }),
  };
  return { deps, domain, profileStore };
}

const EIGHT: Array<[string, string]> = [
  ["basics.full_name", "Aliyu Ahmad"],
  ["basics.email", "a@example.com"],
  ["basics.phone", "08000000000"],
  ["basics.location", "Zaria, Nigeria"],
  ["work.latest_title", "Shop attendant"],
  ["work.latest_employer", "AJ Stores"],
  ["work.latest_dates", "2021 to 2022"],
  ["work.latest_day", "I arranged goods on shelves every morning."],
];

test("sign-off writes provenance-labeled facts, evidence, and the master draft", async () => {
  const { deps, domain, profileStore } = await signoffDeps();
  await startInterview(deps, owner);
  for (const [qid, a] of EIGHT) {
    await answerQuestion(deps, owner, qid, a);
  }
  const { interview, resume } = await signOffInterview(deps, owner);
  assert.equal(interview.status, "signed_off");
  assert.ok(interview.signed_off_at);
  assert.ok(interview.master_draft_pdf_base64);
  assert.equal(
    Buffer.from(interview.master_draft_pdf_base64, "base64").toString(),
    "%PDF-1.4 fake",
  );
  assert.equal(resume.full_name, "Aliyu Ahmad");

  // Provenance: every field labeled "interview" (weakest class).
  for (const field of ["full_name", "email", "latest_job_title"]) {
    assert.equal(interview.provenance[field], "interview");
  }

  // Profile memory holds the confirmed triples verbatim.
  const profile = await profileStore.get(owner);
  assert.equal(profile.memory.full_name, "Aliyu Ahmad");
  assert.equal(profile.memory.latest_day_detail, "I arranged goods on shelves every morning.");

  // The transcript is stored as evidence backing the facts.
  const transcript = profile.evidence.find((e) => e.file_name === "cv-interview-transcript.txt");
  assert.ok(transcript, "transcript evidence exists");

  // Domain event carries the provenance summary.
  const signed = domain.events.find((e) => e.type === "cv_interview.signed_off");
  assert.ok(signed);
  assert.equal(signed.payload.provenance, "interview");
  assert.ok((signed.payload.fields as string[]).includes("full_name"));
});

test("sign-off refuses below 80% and with open conflicts", async () => {
  const { deps } = await signoffDeps();
  await startInterview(deps, owner);
  await answerQuestion(deps, owner, "basics.full_name", "Aliyu Ahmad");
  await assert.rejects(() => signOffInterview(deps, owner), /80%/);

  // Reach 80% but leave a conflict open -> still blocked.
  for (const [qid, a] of EIGHT.slice(1)) await answerQuestion(deps, owner, qid, a);
  await answerQuestion(deps, owner, "basics.full_name", "Ahmad Sunusi");
  await assert.rejects(() => signOffInterview(deps, owner), /conflict|Quarantined/i);
});
