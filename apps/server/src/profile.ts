import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import { type ExtractionReport, extractDocument, type VisionOcrFn } from "./extract.ts";

export type EvidenceKind =
  | "master_resume"
  | "resume"
  | "certificate"
  | "transcript"
  | "license"
  | "award"
  | "portfolio"
  | "publication"
  | "recommendation"
  | "prior_statement"
  | "voice_sample";

export type UploadKind = Exclude<EvidenceKind, "master_resume" | "resume"> | "resume";

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  file_name: string;
  mime: string;
  sha256: string;
  byte_size: number;
  storage_path: string;
  /** Extracted text, capped. Empty when nothing readable was found. */
  text_excerpt: string;
  /** How the text was extracted; warnings surface in the UI. */
  extraction?: ExtractionReport;
  confirmed: boolean;
  created_at: string;
}

export interface ProfileFact {
  id: string;
  field: string;
  value: string;
  /** The evidence item this fact was drawn from. */
  evidence_id: string;
  confirmed: boolean;
  created_at: string;
}

export interface ProfileDraft {
  id: string;
  facts: ProfileFact[];
  /** Upload ids waiting for confirm. */
  evidence_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface Profile {
  id: string;
  /** Schema version, bumped on every write. Draft artifacts reference the
   *  profile version they were built from. */
  version: number;
  master_resume_id: string | null;
  evidence: EvidenceItem[];
  draft: ProfileDraft | null;
  /** Confirmed fields written by memory_writer. */
  memory: Record<string, string>;
}

const PROFILE_ID = "profile";
const MAX_BYTES = 10 * 1024 * 1024;

const ACCEPTED: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt",
  "text/markdown": "md",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/zip": "zip",
};

const UPLOAD_KINDS: UploadKind[] = [
  "resume",
  "certificate",
  "transcript",
  "license",
  "award",
  "portfolio",
  "publication",
  "recommendation",
  "prior_statement",
  "voice_sample",
];

function emptyProfile(): Profile {
  return {
    id: PROFILE_ID,
    version: 1,
    master_resume_id: null,
    evidence: [],
    draft: null,
    memory: {},
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeName(name: string): string {
  return name.replace(/[^\w.\-() ]+/g, "_").slice(0, 120) || "upload";
}

/** Sniff the real MIME type from magic bytes. Never trusts the extension. */
export function sniffMime(bytes: Uint8Array): { mime: string; ext: string } | null {
  const head = bytes.subarray(0, 12);
  const ascii = (n: number) => String.fromCharCode(...head.subarray(0, n));
  if (ascii(5) === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (head[0] === 0x89 && ascii(4) === "\u0089PNG") return { mime: "image/png", ext: "png" };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return { mime: "image/jpeg", ext: "jpg" };
  if (ascii(4) === "RIFF" && ascii(12).endsWith("WEBP")) return { mime: "image/webp", ext: "webp" };
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    try {
      const files = unzipSync(bytes);
      const names = Object.keys(files);
      const isDocx = names.some((n) => n === "word/document.xml" || n.startsWith("word/"));
      if (isDocx)
        return {
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ext: "docx",
        };
    } catch {
      // Not a readable zip.
    }
    return { mime: "application/zip", ext: "zip" };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 4096));
    if (/^[\s\S]*$/.test(text) && !/[\u0000-\u0008\u000e-\u001f]/.test(text.slice(0, 1024)))
      return { mime: "text/plain", ext: "txt" };
  } catch {
    // Not decodable text.
  }
  return null;
}

/** Best-effort text for intake (no OCR; use extractDocument for the full pipeline). */
export async function extractText(bytes: Uint8Array, mime: string): Promise<string> {
  return (await extractDocument(bytes, mime)).text;
}

/** Intake heuristics: pull obvious contact facts from extracted text. */
export function intakeFacts(
  text: string,
  evidenceId: string,
): Omit<ProfileFact, "id" | "created_at">[] {
  const facts: Omit<ProfileFact, "id" | "created_at">[] = [];
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (email)
    facts.push({ field: "email", value: email, evidence_id: evidenceId, confirmed: false });
  const phone = text.match(/(\+?\d[\d\s().-]{7,}\d)/)?.[0];
  if (phone && phone.replace(/\D/g, "").length >= 7 && phone.replace(/\D/g, "").length <= 15)
    facts.push({ field: "phone", value: phone.trim(), evidence_id: evidenceId, confirmed: false });
  return facts;
}

const now = () => new Date().toISOString();

export interface ProfileStoreOptions {
  /**
   * Vision-model OCR for scanned pages and image evidence. Receives the
   * owner so the call can go through the model gateway (cheap tier).
   * When absent, only local tools (tesseract, if installed) are tried.
   */
  ocr?: (owner: string, image: Uint8Array, mime: string) => Promise<string>;
}

export class ProfileStore {
  constructor(
    private readonly db: Store,
    private readonly dataDir: string,
    private readonly options: ProfileStoreOptions = {},
  ) {}

  async get(owner: string): Promise<Profile> {
    return (await this.db.get<Profile>(owner, "profile", PROFILE_ID)) ?? emptyProfile();
  }

  private async save(owner: string, profile: Profile): Promise<Profile> {
    await this.db.put(owner, "profile", profile);
    return profile;
  }

  private ensureDraft(profile: Profile): ProfileDraft {
    if (!profile.draft) {
      profile.draft = {
        id: randomUUID(),
        facts: [],
        evidence_ids: [],
        created_at: now(),
        updated_at: now(),
      };
    }
    return profile.draft;
  }

  async upload(
    owner: string,
    fileName: string,
    bytes: Uint8Array,
    kindHint: UploadKind,
  ): Promise<EvidenceItem> {
    if (bytes.length === 0) throw new AppError("File is empty", 422);
    if (bytes.length > MAX_BYTES) throw new AppError("Files must be 10 MB or smaller", 413);
    if (!UPLOAD_KINDS.includes(kindHint)) throw new AppError("Unknown evidence kind", 422);
    const sniffed = sniffMime(bytes);
    if (!sniffed || !ACCEPTED[sniffed.mime])
      throw new AppError(
        "File type is not accepted. Use pdf, docx, txt, md, png, jpg, jpeg, webp, or zip.",
        422,
      );
    const profile = await this.get(owner);
    const id = randomUUID();
    const dir = join(this.dataDir, "files");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, `${id}.${sniffed.ext}`), bytes, { mode: 0o600, flag: "wx" });
    // The first resume (confirmed or still pending) becomes the master; later ones are plain resumes.
    const pendingMaster = (profile.draft?.evidence_ids ?? []).some(
      (eid) => profile.evidence.find((e) => e.id === eid)?.kind === "master_resume",
    );
    const kind: EvidenceKind =
      kindHint === "resume"
        ? profile.master_resume_id || pendingMaster
          ? "resume"
          : "master_resume"
        : kindHint;
    const ocr = this.options.ocr;
    const visionOcr: VisionOcrFn | undefined = ocr
      ? (image, mime) => ocr(owner, image, mime)
      : undefined;
    const { text, report } = await extractDocument(bytes, sniffed.mime, { visionOcr });
    const item: EvidenceItem = {
      id,
      kind,
      file_name: safeName(fileName),
      mime: sniffed.mime,
      sha256: sha256Hex(bytes),
      byte_size: bytes.length,
      storage_path: `files/${id}.${sniffed.ext}`,
      text_excerpt: text,
      extraction: report,
      confirmed: false,
      created_at: now(),
    };
    profile.evidence.push(item);
    const draft = this.ensureDraft(profile);
    draft.evidence_ids.push(id);
    for (const f of intakeFacts(text, id))
      draft.facts.push({ ...f, id: randomUUID(), created_at: now() });
    draft.updated_at = now();
    await this.save(owner, profile);
    return item;
  }

  async addFact(
    owner: string,
    field: string,
    value: string,
    evidenceId: string,
  ): Promise<ProfileFact> {
    const profile = await this.get(owner);
    const draft = this.ensureDraft(profile);
    if (!profile.evidence.some((e) => e.id === evidenceId))
      throw new AppError("Evidence item not found", 404);
    const cleanField = field.trim().slice(0, 60);
    const cleanValue = value.trim().slice(0, 500);
    if (!cleanField || !cleanValue) throw new AppError("Field and value are required", 422);
    const fact: ProfileFact = {
      id: randomUUID(),
      field: cleanField,
      value: cleanValue,
      evidence_id: evidenceId,
      confirmed: false,
      created_at: now(),
    };
    draft.facts.push(fact);
    draft.updated_at = now();
    await this.save(owner, profile);
    return fact;
  }

  async removeFact(owner: string, factId: string): Promise<Profile> {
    const profile = await this.get(owner);
    const draft = profile.draft;
    if (!draft) throw new AppError("No draft to edit", 404);
    const before = draft.facts.length;
    draft.facts = draft.facts.filter((f) => f.id !== factId);
    if (draft.facts.length === before) throw new AppError("Fact not found", 404);
    draft.updated_at = now();
    return this.save(owner, profile);
  }

  /**
   * memory_writer: writes confirmed fields into profile memory.
   * Refuses to run on anything that has not been confirmed.
   */
  async writeConfirmedMemory(owner: string, facts: ProfileFact[]): Promise<Record<string, string>> {
    const profile = await this.get(owner);
    this.applyMemoryWrite(profile, facts);
    await this.save(owner, profile);
    return profile.memory;
  }

  private applyMemoryWrite(profile: Profile, facts: ProfileFact[]): void {
    const unconfirmed = facts.filter((f) => !f.confirmed);
    if (unconfirmed.length > 0)
      throw new AppError(
        `memory_writer refused: ${unconfirmed.length} fact(s) are not confirmed`,
        409,
      );
    for (const f of facts) profile.memory[f.field] = f.value;
  }

  /**
   * Confirm the draft: promote evidence to the locker, then run memory_writer.
   * Evidence is never promoted before this point. One object, one save.
   */
  async confirm(owner: string): Promise<Profile> {
    const profile = await this.get(owner);
    const draft = profile.draft;
    if (!draft) throw new AppError("Nothing to confirm", 404);
    const pending = new Set(draft.evidence_ids);
    for (const item of profile.evidence) {
      if (pending.has(item.id)) {
        item.confirmed = true;
        if (item.kind === "master_resume" && !profile.master_resume_id)
          profile.master_resume_id = item.id;
      }
    }
    for (const fact of draft.facts) fact.confirmed = true;
    this.applyMemoryWrite(profile, draft.facts);
    profile.draft = null;
    return this.save(owner, profile);
  }

  async forgetEvidence(owner: string, evidenceId: string): Promise<Profile> {
    const profile = await this.get(owner);
    const item = profile.evidence.find((e) => e.id === evidenceId);
    if (!item) throw new AppError("Evidence item not found", 404);
    if (item.kind === "master_resume")
      throw new AppError("The master resume is immutable and cannot be removed", 409);
    profile.evidence = profile.evidence.filter((e) => e.id !== evidenceId);
    if (profile.draft) {
      profile.draft.evidence_ids = profile.draft.evidence_ids.filter((id) => id !== evidenceId);
      profile.draft.facts = profile.draft.facts.filter((f) => f.evidence_id !== evidenceId);
    }
    await unlink(join(this.dataDir, item.storage_path)).catch(() => {});
    return this.save(owner, profile);
  }
}
