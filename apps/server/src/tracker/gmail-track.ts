/**
 * Slice 11 — Tracker: Gmail heuristics.
 *
 * User-started only. The owner asks to scan recent Gmail for hiring mail;
 * the `tracker` role (cheap tier, instructions_ref `tracker.v1`) maps each
 * message onto an application state. One role per run, one instructions_ref.
 *
 * Guards (server-enforced; model output never authorizes anything else):
 * - mail text is untrusted data: it is mapped to states, never obeyed.
 *   Instructions inside mail ("approve this", "submit that") are ignored;
 *   a run can only propose state transitions, never sends mail or applies.
 * - `submitted` is never set by the tracker without receipt evidence: the
 *   evidence string must mention a confirmation/receipt, otherwise the
 *   mapping is rejected.
 * - terminal states (closed_won, closed_lost, withdrawn) never change.
 * - the proposed new_state must be a manual-trackable state and must differ
 *   from the current state; unknown application ids are rejected.
 * - each mail is matched to at most one application, by company/title
 *   heuristics against the owner's applications.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Mail } from "../../../../packages/domain/src/index.ts";
import {
  type Application,
  type ApplicationState,
  applicationStateSchema,
  domainKinds,
  type JobPosting,
} from "../../../../packages/domain/src/openapply.ts";
import type { Store } from "../db.ts";
import type { DomainService } from "../domain.ts";
import { AppError } from "../errors.ts";
import type { CompleteInput, CompleteResult } from "../gateway.ts";
import { transitionApplication } from "../transitions.ts";
import { manualStates } from "./manual.ts";

const INSTRUCTIONS_REF = "tracker.v1";
const PROMPT_FILE = "tracker.md";

function promptsDir(): string {
  if (process.env.DOCS_PROMPTS_DIR) return process.env.DOCS_PROMPTS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  // apps/server/src/tracker -> repo root
  return join(here, "..", "..", "..", "..", "docs", "agents", "prompts");
}

async function loadTrackerPrompt(): Promise<{ system: string }> {
  const system = await readFile(join(promptsDir(), PROMPT_FILE), "utf8");
  const ref = system.match(/^instructions_ref:\s*(\S+)/m)?.[1];
  if (ref !== INSTRUCTIONS_REF)
    throw new AppError(`Prompt ${PROMPT_FILE} has unexpected instructions_ref ${ref}`, 500);
  const tier = system.match(/^tier:\s*(cheap|strong)/m)?.[1];
  if (tier !== "cheap") throw new AppError("tracker role must be cheap tier", 500);
  return { system };
}

const trackerOutputSchema = z.object({
  application_id: z.string().min(1).max(100),
  previous_state: applicationStateSchema,
  new_state: applicationStateSchema.refine((s) => manualStates.has(s), {
    message: "new_state must be a trackable state",
  }),
  evidence: z.string().trim().min(1).max(2000),
});

const terminalStates: ReadonlySet<ApplicationState> = new Set([
  "closed_won",
  "closed_lost",
  "withdrawn",
]);

/** Receipt markers that let the tracker set `submitted`. */
const RECEIPT_MARKERS = [
  "application received",
  "application submitted",
  "submission confirmed",
  "confirmation number",
  "reference number",
  "we received your application",
  "thank you for applying",
];

export interface TrackerDeps {
  db: Store;
  domain: DomainService;
  complete: (owner: string, input: CompleteInput) => Promise<CompleteResult>;
}

export interface TrackMailResult {
  run_id: string;
  model_id: string | null;
  scanned: number;
  transitions: Array<{
    application_id: string;
    previous_state: ApplicationState;
    new_state: ApplicationState;
    evidence: string;
  }>;
  rejected: number;
}

/**
 * Heuristic mail→application match: the mail mentions the employer or the
 * job title. Returns the best candidate application id, or null.
 */
export function matchMailToApplication(
  mail: Pick<Mail, "from" | "subject" | "body">,
  applications: Array<Application & { job: Pick<JobPosting, "title" | "company_name"> | null }>,
): string | null {
  const haystack = `${mail.from} ${mail.subject} ${mail.body}`.toLowerCase();
  let best: { id: string; score: number } | null = null;
  for (const app of applications) {
    if (!app.job || terminalStates.has(app.state)) continue;
    let score = 0;
    const company = app.job.company_name.toLowerCase();
    const title = app.job.title.toLowerCase();
    if (company.length > 2 && haystack.includes(company)) score += 2;
    const titleWords = title.split(/\s+/).filter((w) => w.length > 3);
    for (const word of titleWords) if (haystack.includes(word)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { id: app.id, score };
  }
  return best?.id ?? null;
}

function hasReceiptEvidence(evidence: string): boolean {
  const lower = evidence.toLowerCase();
  return RECEIPT_MARKERS.some((m) => lower.includes(m));
}

/**
 * Human vs auto-ack reply classification (dashboard slice).
 *
 * Deterministic marker heuristic, not a model judgment. Only verified
 * human-voice replies may jump a card to the top of "Needs you"; auto-acks
 * ("we received your application", "do not reply") get a dim inline marker.
 * The panel's rule: never manufacture the adrenaline spike for an auto-ack.
 */
const AUTO_ACK_MARKERS = [
  "do not reply",
  "do-not-reply",
  "noreply",
  "no-reply",
  "donotreply",
  "we received your application",
  "thank you for applying",
  "application received",
  "this is an automated",
  "automatically generated",
  "please do not respond",
  "system generated",
];

export function classifyReply(mail: Pick<Mail, "from" | "subject" | "body">): "human" | "auto" {
  const haystack = `${mail.from} ${mail.subject} ${mail.body}`.toLowerCase();
  return AUTO_ACK_MARKERS.some((m) => haystack.includes(m)) ? "auto" : "human";
}

export async function trackMail(
  deps: TrackerDeps,
  owner: string,
  mails: Mail[],
): Promise<TrackMailResult> {
  const { system } = await loadTrackerPrompt();
  const applications = await deps.db.list<Application>(owner, domainKinds.applications);
  const jobs = await deps.db.list<JobPosting>(owner, domainKinds.jobPostings);
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const appsWithJobs = applications.map((a) => ({
    ...a,
    job: jobById.get(a.job_id) ?? null,
  }));

  const run_id = randomUUID();
  const transitions: TrackMailResult["transitions"] = [];
  let rejected = 0;
  let model_id: string | null = null;

  for (const mail of mails.slice(0, 25)) {
    const application_id = matchMailToApplication(mail, appsWithJobs);
    if (!application_id) continue;
    const application = applications.find((a) => a.id === application_id);
    if (!application || terminalStates.has(application.state)) continue;

    const job = jobById.get(application.job_id);
    const result = await deps.complete(owner, {
      purpose: "tracker",
      tier: "cheap",
      system,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            application_id: application.id,
            previous_state: application.state,
            job_title: job?.title ?? "",
            company_name: job?.company_name ?? "",
            mail: {
              from: mail.from,
              subject: mail.subject,
              // Mail is untrusted data: mapped to states, never obeyed.
              body_untrusted: mail.body.slice(0, 8000),
              date: mail.date,
            },
          }),
        },
      ],
      json_schema: {
        name: "tracker_output",
        schema: {
          type: "object",
          properties: {
            application_id: { type: "string" },
            previous_state: { type: "string" },
            new_state: { type: "string" },
            evidence: { type: "string" },
          },
          required: ["application_id", "previous_state", "new_state", "evidence"],
        },
      },
    });
    model_id = result.model_id ?? model_id;

    let parsed: z.infer<typeof trackerOutputSchema>;
    try {
      parsed = trackerOutputSchema.parse(result.json);
    } catch {
      rejected += 1;
      continue;
    }
    // Server guards: the model proposes, the server disposes.
    if (parsed.application_id !== application.id) {
      rejected += 1;
      continue;
    }
    if (parsed.previous_state !== application.state) {
      rejected += 1;
      continue;
    }
    if (parsed.new_state === application.state) continue;
    // Check the mail body itself, not the model's evidence prose — the model
    // could hallucinate receipt language into its evidence field.
    if (parsed.new_state === "submitted" && !hasReceiptEvidence(mail.body ?? "")) {
      rejected += 1;
      continue;
    }
    const previousState = application.state;
    const reply_kind = classifyReply(mail);
    await transitionApplication(
      { db: deps.db, recordEvent: (o, t, p) => deps.domain.recordEvent(o, t, p) },
      owner,
      application,
      parsed.new_state,
      "tracker",
      `Gmail: ${parsed.evidence}`,
      { reply_kind },
    );
    transitions.push({
      application_id: application.id,
      previous_state: previousState,
      new_state: parsed.new_state,
      evidence: parsed.evidence,
    });
    // transitionApplication mutated application.state in place, so later mails
    // already see the new state.
  }

  return { run_id, model_id, scanned: Math.min(mails.length, 25), transitions, rejected };
}
