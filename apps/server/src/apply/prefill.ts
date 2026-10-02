/**
 * Prefill (Slice 9). Fills visible form fields from the confirmed profile
 * and attaches only files listed in the pack manifest.
 *
 * Guards (enforced server-side, not just by the model):
 * - attached paths must be real manifest artifact paths (no invented uploads)
 * - every filled value must come from the confirmed profile
 * - unknown fields become questions for the user, never guesses
 * - the apply session must be warm (120-minute idle kills it)
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Application, Artifact } from "../../../../packages/domain/src/openapply.ts";
import { domainKinds } from "../../../../packages/domain/src/openapply.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { PackManifest } from "../foundry/packer.ts";
import type { ProfileStore } from "../profile.ts";
import { transitionApplication } from "../transitions.ts";
import { type CompleteFn, runApplyRole } from "./agent.ts";
import type { ApplyBrowser } from "./browser-adapter.ts";
import { getApplySession, isWarm, putApplySession, refreshIdle } from "./session.ts";

const prefillFieldSchema = z.object({
  field: z.string().min(1).max(200),
  memory_key: z.string().min(1).max(200),
  value: z.string().max(2000),
});
const prefillOutputSchema = z.object({
  filled_fields: z.array(prefillFieldSchema).default([]),
  unfilled_fields: z.array(z.string()).default([]),
  attached_files: z.array(z.string()).default([]),
  stop_reason: z.string().nullable().default(null),
});
type PrefillOutput = z.infer<typeof prefillOutputSchema>;

export interface PrefillDeps {
  db: Store;
  dataDir: string;
  profileStore: ProfileStore;
  recordEvent(owner: string, type: string, payload: Record<string, unknown>): Promise<unknown>;
  browser: ApplyBrowser;
  complete: CompleteFn;
}

const PREFILL_FROM_STATES = new Set(["pack_approved", "session_needed", "prefilled"]);

export interface PrefillResult {
  status: "prefilled";
  filled_fields: string[];
  unfilled_fields: string[];
  attached_files: string[];
  stop_reason: string | null;
  questions_for_user: string[];
}

async function requireWarmSession(deps: PrefillDeps, owner: string, application: Application) {
  const session = await getApplySession(deps.db, owner, application.id);
  if (!session?.session_id) throw new AppError("No apply session. Run the usher first.", 409);
  const live = await deps.browser.getSession(owner, session.session_id);
  if (!isWarm(session, live)) {
    // 120-minute idle (or a dead browser session): the binding is gone.
    session.session_id = "";
    session.state = "session_needed";
    await putApplySession(deps.db, owner, session);
    await transitionApplication(deps, owner, application, "session_needed", "system");
    throw new AppError(
      "The apply session idled out (120 minutes) or closed. Take over the browser again.",
      409,
    );
  }
  return session;
}

export async function prefillApplication(
  deps: PrefillDeps,
  owner: string,
  application_id: string,
): Promise<PrefillResult> {
  const application = await deps.db.get<Application>(
    owner,
    domainKinds.applications,
    application_id,
  );
  if (!application) throw new AppError("Application not found", 404);
  if (!PREFILL_FROM_STATES.has(application.state))
    throw new AppError(`Prefill needs a bound session (now: ${application.state}).`, 409);
  if (!application.pack_id) throw new AppError("This application has no approved pack.", 422);

  const session = await requireWarmSession(deps, owner, application);

  const manifest = await deps.db.get<PackManifest>(
    owner,
    domainKinds.artifacts,
    application.pack_id,
  );
  if (manifest?.kind !== "pack_manifest") throw new AppError("Pack manifest not found.", 404);

  const profile = await deps.profileStore.get(owner);
  const memory: Record<string, string> = profile?.memory ?? {};
  const packFiles = manifest.documents.map((d) => ({
    label: d.kind,
    format: d.format,
    pack_path: d.artifact_id,
  }));
  const page = await deps.browser.readPage(owner, session.session_id);

  const { output } = await runApplyRole({
    owner,
    instructions_ref: "prefill.v1",
    complete: deps.complete,
    payload: {
      profile_confirmed: memory,
      pack_files: packFiles,
      form_page_text: page.text.slice(0, 20_000),
    },
  });
  const parsed = prefillOutputSchema.safeParse(output);
  if (!parsed.success) throw new AppError("Prefill did not return a valid fill plan.", 502);
  const plan: PrefillOutput = parsed.data;

  // Server-side guardrail: attached files must be real manifest artifacts.
  const manifestPaths = new Set(packFiles.map((f) => f.pack_path));
  for (const path of plan.attached_files) {
    if (!manifestPaths.has(path))
      throw new AppError(`POLICY_DENIED: prefill invented an upload path (${path}).`, 403);
  }

  // Resolve manifest artifact paths to real storage paths for the file chooser.
  const storagePaths: string[] = [];
  for (const artifactId of plan.attached_files) {
    const artifact = await deps.db.get<Artifact>(owner, domainKinds.artifacts, artifactId);
    if (!artifact?.storage_path) throw new AppError(`Pack file ${artifactId} is missing.`, 404);
    storagePaths.push(`${deps.dataDir}/${artifact.storage_path}`);
  }
  if (storagePaths.length > 0)
    await deps.browser.attachFiles(owner, session.session_id, storagePaths);

  // Server-side guardrail: never fill password-type fields. The "do not type
  // a password" rule was prompt-only; this makes it mechanical.
  for (const f of plan.filled_fields) {
    if (/passw/i.test(f.field))
      throw new AppError(`POLICY_DENIED: refusing to fill password-type field "${f.field}".`, 403);
  }

  // Server-side guardrail: every filled value is copied verbatim from the
  // confirmed memory entry it names. Anything else is an invention.
  for (const f of plan.filled_fields) {
    const confirmed = memory[f.memory_key];
    if (confirmed === undefined || confirmed !== f.value)
      throw new AppError(
        `POLICY_DENIED: prefill value for "${f.field}" is not the confirmed "${f.memory_key}".`,
        403,
      );
  }

  // Execute the grounded fill plan through the worker.
  for (const f of plan.filled_fields) {
    await deps.browser.fillField(owner, session.session_id, { field: f.field, value: f.value });
  }

  const snapshot = {
    id: randomUUID(),
    kind: "form_snapshot",
    application_id: application.id,
    filled_fields: plan.filled_fields.map((f) => f.field),
    unfilled_fields: plan.unfilled_fields,
    attached_files: plan.attached_files,
    page_url: page.url,
    created_at: new Date().toISOString(),
  };
  await deps.db.put(owner, domainKinds.artifacts, snapshot);

  application.last_form_snapshot_artifact_id = snapshot.id;
  await transitionApplication(deps, owner, application, "prefilled", "system");

  refreshIdle(session);
  session.state = "prefilled";
  await putApplySession(deps.db, owner, session);

  await deps.recordEvent(owner, "apply.prefilled", {
    application_id: application.id,
    filled: plan.filled_fields.length,
    unfilled: plan.unfilled_fields.length,
  });

  const questions_for_user =
    plan.stop_reason === "USER_ACTION_REQUIRED"
      ? [
          `The form needs your input before it can be submitted: ${plan.unfilled_fields.join(", ") || "see the browser"}.`,
        ]
      : plan.unfilled_fields.map((f) => `The form asks for "${f}" — answer it in the browser.`);

  return {
    status: "prefilled",
    filled_fields: plan.filled_fields.map((f) => f.field),
    unfilled_fields: plan.unfilled_fields,
    attached_files: plan.attached_files,
    stop_reason: plan.stop_reason,
    questions_for_user,
  };
}
