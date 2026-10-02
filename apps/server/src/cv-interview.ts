/**
 * CV interview builder: a conversational CV for users who don't have one.
 *
 * The AI interviews the user and they build the CV together. Hard rules:
 * - The question bank is DETERMINISTIC and hardcoded below — questions are
 *   never LLM-generated, so no prompt can smuggle a claim about the user.
 * - Every answer is stored as a triple { quoted_statement, confirmed,
 *   asked_at }, verbatim. The interview never elaborates, never polishes
 *   bullets, never upgrades job titles.
 * - Completeness = required-fields-filled / total-required. The interview
 *   becomes ready for sign-off at >= 80% AND requires explicit sign-off.
 * - If a new answer contradicts a confirmed fact, a conflict record opens and
 *   the field is QUARANTINED: no downstream consumer (including sign-off
 *   drafting) may read it until the user picks a winner.
 * - On sign-off, confirmed triples are written to Profile memory as
 *   interview-derived facts (provenance class "interview" — the weakest
 *   class), backed by the transcript as evidence, and a master resume draft
 *   is rendered through the packer's resume renderer. The draft is marked
 *   UNVERIFIED; it never touches the immutable master resume.
 */
import { randomUUID } from "node:crypto";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import type { ResumeContent } from "./foundry/model.ts";
import type { ProfileFact, ProfileStore } from "./profile.ts";

export type CvSectionId = "basics" | "work_history" | "skills" | "education";

/** Per-section refinement state: draft -> correction -> re-draft -> locked. */
export type CvSectionState = "draft" | "correction" | "re-draft" | "locked";

export interface InterviewQuestion {
  id: string;
  section: CvSectionId;
  field: string;
  prompt: string;
  /** Why this is asked — shown in the UI next to the question. */
  why: string;
  required: boolean;
}

export const SECTION_ORDER: CvSectionId[] = ["basics", "work_history", "skills", "education"];

export const SECTION_LABELS: Record<CvSectionId, string> = {
  basics: "Basics",
  work_history: "Work history",
  skills: "Skills",
  education: "Education",
};

/**
 * The deterministic question bank. Every prompt is a literal string below.
 * Fidelity mandate: no prompt contains a claim about the user that isn't
 * already confirmed — each one only asks.
 */
export const QUESTION_BANK: InterviewQuestion[] = [
  {
    id: "basics.full_name",
    section: "basics",
    field: "full_name",
    prompt: "What is your full name, exactly as it should appear on your CV?",
    why: "This goes at the top of your CV so employers know who you are.",
    required: true,
  },
  {
    id: "basics.email",
    section: "basics",
    field: "email",
    prompt: "What email address should employers use to contact you?",
    why: "Employers need a way to reach you.",
    required: true,
  },
  {
    id: "basics.phone",
    section: "basics",
    field: "phone",
    prompt: "What phone number should appear on your CV?",
    why: "A second contact channel for employers.",
    required: true,
  },
  {
    id: "basics.location",
    section: "basics",
    field: "location",
    prompt: "Which city and country are you currently based in?",
    why: "Location helps match you with roles you can actually take.",
    required: true,
  },
  {
    id: "work.latest_title",
    section: "work_history",
    field: "latest_job_title",
    prompt:
      "What was your most recent job title — the exact title your employer used, not an upgraded version?",
    why: "This builds your work-history section, starting with the latest role.",
    required: true,
  },
  {
    id: "work.latest_employer",
    section: "work_history",
    field: "latest_employer",
    prompt: "Who was the employer for that role? Give the organisation's name.",
    why: "Employers want to see where you have worked.",
    required: true,
  },
  {
    id: "work.latest_dates",
    section: "work_history",
    field: "latest_dates",
    prompt: "When did you start that role, and when did you leave — or are you still there?",
    why: "Dates show the shape of your work history.",
    required: true,
  },
  {
    id: "work.latest_day",
    section: "work_history",
    field: "latest_day_detail",
    prompt:
      "What did a normal day look like in that role? Describe one concrete thing you actually did, in your own words.",
    why: "One real detail beats five polished-sounding claims. We use your words only.",
    required: true,
  },
  {
    id: "work.earlier",
    section: "work_history",
    field: "earlier_roles",
    prompt:
      "Was there a job before that one? If yes, give the job title and employer. If no, just answer 'none'.",
    why: "Earlier roles add depth, but one strong role is enough.",
    required: false,
  },
  {
    id: "skills.top",
    section: "skills",
    field: "top_skills",
    prompt:
      "What are the 3 to 5 things you are genuinely good at that an employer would pay for? List them plainly, separated by commas.",
    why: "This becomes your skills section — only what you claim yourself.",
    required: true,
  },
  {
    id: "education.highest",
    section: "education",
    field: "highest_qualification",
    prompt:
      "What is your highest qualification — a degree, diploma, certificate, or 'none' if you don't have one?",
    why: "Education goes on every CV; 'none' is a perfectly fine answer.",
    required: true,
  },
  {
    id: "education.school",
    section: "education",
    field: "school_and_year",
    prompt:
      "Where did you earn that qualification, and in which year? (Skip if your answer above was 'none'.)",
    why: "School and year complete the education line.",
    required: false,
  },
];

export const REQUIRED_QUESTIONS = QUESTION_BANK.filter((q) => q.required);
/** The interview is ready for sign-off at this completeness. */
export const SIGNOFF_COMPLETENESS = 0.8;

export interface AnswerTriple {
  quoted_statement: string;
  confirmed: boolean;
  asked_at: string;
}

export interface FieldAnswer {
  field: string;
  question_id: string;
  triple: AnswerTriple;
  /** Quarantined while a conflict on this field is unresolved. */
  quarantined: boolean;
}

export interface ConflictRecord {
  id: string;
  field: string;
  question_id: string;
  existing: string;
  incoming: string;
  asked_at: string;
  resolved: boolean;
  winner?: "existing" | "incoming";
}

export type CvInterviewStatus = "in_progress" | "ready_for_signoff" | "signed_off";

export interface CvInterview {
  id: string;
  status: CvInterviewStatus;
  answers: Record<string, FieldAnswer>;
  conflicts: ConflictRecord[];
  /** field -> "interview" (weakest provenance class), written at sign-off. */
  provenance: Record<string, "interview">;
  /** Base64 PDF of the rendered master draft; present only after sign-off. */
  master_draft_pdf_base64?: string;
  started_at: string;
  updated_at: string;
  signed_off_at?: string;
}

export const CV_INTERVIEW_KIND = "cv_interviews";

const now = () => new Date().toISOString();

/** Normalize for contradiction detection: case, punctuation, whitespace. */
export function normalizeAnswer(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Two statements contradict when they differ beyond trivial normalization. */
export function contradicts(existing: string, incoming: string): boolean {
  return normalizeAnswer(existing) !== normalizeAnswer(incoming);
}

function filledAnswer(a: FieldAnswer | undefined): boolean {
  return !!a && a.triple.confirmed && !a.quarantined && a.triple.quoted_statement.length > 0;
}

/** Completeness = required-fields-filled / total-required. */
export function completenessOf(answers: Record<string, FieldAnswer>): number {
  const filled = REQUIRED_QUESTIONS.filter((q) => filledAnswer(answers[q.field])).length;
  return filled / REQUIRED_QUESTIONS.length;
}

export function openConflicts(interview: CvInterview): ConflictRecord[] {
  return interview.conflicts.filter((c) => !c.resolved);
}

export function quarantinedFields(interview: CvInterview): string[] {
  return Object.values(interview.answers)
    .filter((a) => a.quarantined)
    .map((a) => a.field);
}

/**
 * Derive the per-section refinement state.
 * - locked: every required question in the section is filled, no open conflicts.
 * - correction: an open conflict sits in the section.
 * - re-draft: a conflict in the section was resolved (the user corrected it).
 * - draft: otherwise.
 */
export function sectionStateFor(section: CvSectionId, interview: CvInterview): CvSectionState {
  const sectionConflicts = interview.conflicts.filter((c) => {
    const q = QUESTION_BANK.find((qq) => qq.id === c.question_id);
    return q?.section === section;
  });
  if (sectionConflicts.some((c) => !c.resolved)) return "correction";
  const required = QUESTION_BANK.filter((q) => q.section === section && q.required);
  const allFilled = required.every((q) => filledAnswer(interview.answers[q.field]));
  if (allFilled) return "locked";
  if (sectionConflicts.some((c) => c.resolved)) return "re-draft";
  return "draft";
}

export function sectionStatesFor(interview: CvInterview): Record<CvSectionId, CvSectionState> {
  return {
    basics: sectionStateFor("basics", interview),
    work_history: sectionStateFor("work_history", interview),
    skills: sectionStateFor("skills", interview),
    education: sectionStateFor("education", interview),
  };
}

/** The next question to ask: first unanswered required, then unanswered optional. */
export function nextQuestion(interview: CvInterview): InterviewQuestion | null {
  for (const q of QUESTION_BANK) {
    if (q.required && !filledAnswer(interview.answers[q.field])) return q;
  }
  for (const q of QUESTION_BANK) {
    if (!q.required && !filledAnswer(interview.answers[q.field])) return q;
  }
  return null;
}

export interface AnswerResult {
  interview: CvInterview;
  conflict: ConflictRecord | null;
}

function refreshStatus(interview: CvInterview): void {
  if (interview.status === "signed_off") return;
  interview.status =
    completenessOf(interview.answers) >= SIGNOFF_COMPLETENESS ? "ready_for_signoff" : "in_progress";
}

/**
 * Store an answer verbatim. If the field already holds a confirmed triple
 * that contradicts the new statement, open a conflict and quarantine the
 * field instead of overwriting.
 */
export function applyAnswer(
  interview: CvInterview,
  questionId: string,
  rawAnswer: string,
): AnswerResult {
  const question = QUESTION_BANK.find((q) => q.id === questionId);
  if (!question) throw new AppError(`Unknown question "${questionId}"`, 422);
  const answer = rawAnswer.trim().slice(0, 2000);
  if (!answer) throw new AppError("Answer cannot be empty", 422);

  const existing = interview.answers[question.field];
  if (existing?.triple.confirmed && contradicts(existing.triple.quoted_statement, answer)) {
    const conflict: ConflictRecord = {
      id: randomUUID(),
      field: question.field,
      question_id: question.id,
      existing: existing.triple.quoted_statement,
      incoming: answer,
      asked_at: now(),
      resolved: false,
    };
    interview.conflicts.push(conflict);
    existing.quarantined = true;
    interview.updated_at = now();
    refreshStatus(interview);
    return { interview, conflict };
  }

  interview.answers[question.field] = {
    field: question.field,
    question_id: question.id,
    triple: { quoted_statement: answer, confirmed: true, asked_at: now() },
    quarantined: false,
  };
  interview.updated_at = now();
  refreshStatus(interview);
  return { interview, conflict: null };
}

/** The user picks a winner; the field unquarantines with the winning triple. */
export function resolveConflict(
  interview: CvInterview,
  conflictId: string,
  winner: "existing" | "incoming",
): CvInterview {
  const conflict = interview.conflicts.find((c) => c.id === conflictId);
  if (!conflict) throw new AppError("Conflict not found", 404);
  if (conflict.resolved) throw new AppError("Conflict is already resolved", 409);
  const answer = interview.answers[conflict.field];
  if (!answer) throw new AppError("Answer for conflicted field is missing", 409);
  conflict.resolved = true;
  conflict.winner = winner;
  const winning = winner === "incoming" ? conflict.incoming : conflict.existing;
  answer.triple = { quoted_statement: winning, confirmed: true, asked_at: now() };
  answer.quarantined = false;
  interview.updated_at = now();
  refreshStatus(interview);
  return interview;
}

export interface SignoffCheck {
  ok: boolean;
  reasons: string[];
}

/** Drafting blocks on quarantined fields — surfaced as its own state. */
export function canSignOff(interview: CvInterview): SignoffCheck {
  const reasons: string[] = [];
  if (interview.status === "signed_off") reasons.push("This interview is already signed off.");
  const completeness = completenessOf(interview.answers);
  if (completeness < SIGNOFF_COMPLETENESS)
    reasons.push(
      `Completeness is ${Math.round(completeness * 100)}%; sign-off needs ${Math.round(SIGNOFF_COMPLETENESS * 100)}%.`,
    );
  const open = openConflicts(interview);
  if (open.length > 0)
    reasons.push(`${open.length} conflict(s) unresolved: ${open.map((c) => c.field).join(", ")}.`);
  const quarantined = quarantinedFields(interview);
  if (quarantined.length > 0)
    reasons.push(`Quarantined field(s) block drafting: ${quarantined.join(", ")}.`);
  return { ok: reasons.length === 0, reasons };
}

function answerValue(interview: CvInterview, field: string): string {
  const a = interview.answers[field];
  return a && filledAnswer(a) ? a.triple.quoted_statement : "";
}

/**
 * Mechanical mapping from confirmed triples to resume JSON. No elaboration:
 * bullets are the user's quoted statements verbatim; empty sections stay empty.
 */
export function buildResumeContent(interview: CvInterview): ResumeContent {
  const title = answerValue(interview, "latest_job_title");
  const employer = answerValue(interview, "latest_employer");
  const dayDetail = answerValue(interview, "latest_day_detail");
  const skillsRaw = answerValue(interview, "top_skills");
  const qualification = answerValue(interview, "highest_qualification");
  const school = answerValue(interview, "school_and_year");

  const skillItems = skillsRaw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");

  return {
    full_name: answerValue(interview, "full_name"),
    links: [],
    email: answerValue(interview, "email"),
    mobile: answerValue(interview, "phone"),
    education:
      qualification && normalizeAnswer(qualification) !== "none"
        ? [{ institution: school, location: "", degree: qualification, dates: school }]
        : [],
    skills: skillItems ? [{ category: "Skills", items: skillItems }] : [],
    experience: title
      ? [
          {
            title: employer ? `${title} — ${employer}` : title,
            dates: answerValue(interview, "latest_dates"),
            bullets: dayDetail ? [dayDetail] : [],
          },
        ]
      : [],
    projects: [],
    certificates: [],
  };
}

/** The transcript doubles as the evidence backing interview-derived facts. */
export function buildTranscript(interview: CvInterview): string {
  const lines = [
    "CV interview transcript (evidence for interview-derived facts)",
    `Interview: ${interview.id}`,
    `Started: ${interview.started_at}`,
    "",
  ];
  for (const q of QUESTION_BANK) {
    const a = interview.answers[q.field];
    if (!a) continue;
    lines.push(`Q [${q.id}]: ${q.prompt}`);
    lines.push(`A: ${a.triple.quoted_statement}`);
    lines.push("");
  }
  return lines.join("\n");
}

export interface CvInterviewDeps {
  db: Store;
  recordEvent(owner: string, type: string, payload: Record<string, unknown>): Promise<unknown>;
  profileStore: ProfileStore;
  /** The packer's resume renderer; stubbed in tests. */
  renderResume(templateId: string, content: unknown): Promise<{ pdf: Buffer }>;
}

async function loadInterview(
  deps: Pick<CvInterviewDeps, "db">,
  owner: string,
): Promise<CvInterview | null> {
  const all = await deps.db.list<CvInterview>(owner, CV_INTERVIEW_KIND);
  if (all.length === 0) return null;
  return all.sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
}

async function saveInterview(
  deps: CvInterviewDeps,
  owner: string,
  interview: CvInterview,
): Promise<CvInterview> {
  await deps.db.put(owner, CV_INTERVIEW_KIND, interview);
  return interview;
}

export async function startInterview(deps: CvInterviewDeps, owner: string): Promise<CvInterview> {
  const existing = await loadInterview(deps, owner);
  if (existing && existing.status !== "signed_off") return existing;
  const interview: CvInterview = {
    id: randomUUID(),
    status: "in_progress",
    answers: {},
    conflicts: [],
    provenance: {},
    started_at: now(),
    updated_at: now(),
  };
  await saveInterview(deps, owner, interview);
  await deps.recordEvent(owner, "cv_interview.started", { interview_id: interview.id });
  return interview;
}

export async function answerQuestion(
  deps: CvInterviewDeps,
  owner: string,
  questionId: string,
  answer: string,
): Promise<AnswerResult> {
  const interview = await loadInterview(deps, owner);
  if (!interview) throw new AppError("No interview in progress. Start one first.", 404);
  if (interview.status === "signed_off")
    throw new AppError("This interview is signed off. Start a new one to change answers.", 409);
  const result = applyAnswer(interview, questionId, answer);
  await saveInterview(deps, owner, interview);
  if (result.conflict) {
    await deps.recordEvent(owner, "cv_interview.conflict_opened", {
      interview_id: interview.id,
      field: result.conflict.field,
    });
  }
  return result;
}

export async function resolveInterviewConflict(
  deps: CvInterviewDeps,
  owner: string,
  conflictId: string,
  winner: "existing" | "incoming",
): Promise<CvInterview> {
  const interview = await loadInterview(deps, owner);
  if (!interview) throw new AppError("No interview in progress.", 404);
  resolveConflict(interview, conflictId, winner);
  await saveInterview(deps, owner, interview);
  await deps.recordEvent(owner, "cv_interview.conflict_resolved", {
    interview_id: interview.id,
    conflict_id: conflictId,
    winner,
  });
  return interview;
}

/**
 * Sign-off: write confirmed triples to Profile memory as interview-derived
 * facts (provenance class "interview"), back them with the transcript as
 * evidence, and render the master resume draft through the packer's renderer.
 */
export async function signOffInterview(
  deps: CvInterviewDeps,
  owner: string,
): Promise<{ interview: CvInterview; resume: ResumeContent }> {
  const interview = await loadInterview(deps, owner);
  if (!interview) throw new AppError("No interview in progress.", 404);
  const check = canSignOff(interview);
  if (!check.ok) throw new AppError(`Cannot sign off: ${check.reasons.join(" ")}`, 409);

  const resume = buildResumeContent(interview);

  // 1. Transcript as evidence for the interview-derived facts.
  const transcript = await deps.profileStore.upload(
    owner,
    "cv-interview-transcript.txt",
    Buffer.from(buildTranscript(interview), "utf8"),
    "prior_statement",
  );

  // 2. Confirmed triples -> Profile memory, provenance "interview" (weakest).
  const facts: ProfileFact[] = Object.values(interview.answers)
    .filter(filledAnswer)
    .map((a) => ({
      id: randomUUID(),
      field: a.field,
      value: a.triple.quoted_statement,
      evidence_id: transcript.id,
      confirmed: true,
      created_at: now(),
    }));
  const memory = await deps.profileStore.writeConfirmedMemory(owner, facts);
  for (const f of facts) interview.provenance[f.field] = "interview";

  // 3. Master resume draft via the packer's resume renderer. A draft only:
  //    it is marked UNVERIFIED and never touches the immutable master resume.
  const rendered = await deps.renderResume("template-one", resume);
  interview.master_draft_pdf_base64 = rendered.pdf.toString("base64");

  interview.status = "signed_off";
  interview.signed_off_at = now();
  interview.updated_at = now();
  await saveInterview(deps, owner, interview);

  await deps.recordEvent(owner, "cv_interview.signed_off", {
    interview_id: interview.id,
    completeness: completenessOf(interview.answers),
    fields: facts.map((f) => f.field),
    provenance: "interview",
    memory_fields: Object.keys(memory),
  });
  return { interview, resume };
}

export interface InterviewView {
  interview: CvInterview | null;
  questions: InterviewQuestion[];
  current: InterviewQuestion | null;
  completeness: number;
  required_answered: number;
  required_total: number;
  section_states: Record<CvSectionId, CvSectionState> | null;
  open_conflicts: ConflictRecord[];
  blocked_on: string[];
  /** Mechanical draft preview; null before 2 answers. THIN/UNVERIFIED until sign-off. */
  draft_preview: ResumeContent | null;
  has_master_draft: boolean;
}

export async function interviewView(
  deps: Pick<CvInterviewDeps, "db">,
  owner: string,
): Promise<InterviewView> {
  const interview = await loadInterview(deps, owner);
  if (!interview) {
    return {
      interview: null,
      questions: QUESTION_BANK,
      current: null,
      completeness: 0,
      required_answered: 0,
      required_total: REQUIRED_QUESTIONS.length,
      section_states: null,
      open_conflicts: [],
      blocked_on: [],
      draft_preview: null,
      has_master_draft: false,
    };
  }
  const answeredCount = Object.values(interview.answers).filter(filledAnswer).length;
  return {
    interview: { ...interview, master_draft_pdf_base64: undefined },
    questions: QUESTION_BANK,
    current: nextQuestion(interview),
    completeness: completenessOf(interview.answers),
    required_answered: REQUIRED_QUESTIONS.filter((q) => filledAnswer(interview.answers[q.field]))
      .length,
    required_total: REQUIRED_QUESTIONS.length,
    section_states: sectionStatesFor(interview),
    open_conflicts: openConflicts(interview),
    blocked_on: quarantinedFields(interview),
    draft_preview: answeredCount >= 2 ? buildResumeContent(interview) : null,
    has_master_draft: !!interview.master_draft_pdf_base64,
  };
}
