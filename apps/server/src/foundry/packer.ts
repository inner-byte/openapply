/**
 * Packer: Foundry renders -> stored pack artifacts -> pack_review.
 *
 * The review loop Ahmad approved:
 *   1. Generate the real document bytes.
 *   2. Store the real bytes (domain artifacts under dataDir/packs/).
 *   3. Render page previews FROM those bytes (PDF: pdftoppm; DOCX:
 *      LibreOffice headless -> PDF -> pdftoppm).
 *   4. User inspects in the pack-review UI and requests revisions.
 *   5. Regenerate refreshes previews.
 *   6. Approval(target=pack) gates anything downstream (Slice 9 submit).
 *
 * Format is decided at pack time: PDF unless the portal (or caller) asks for
 * DOCX. The canonical content stays format-agnostic JSON.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact, ArtifactKind } from "../../../../packages/domain/src/openapply.ts";
import { domainKinds } from "../../../../packages/domain/src/openapply.ts";
import { type DocxKind, renderDocx } from "./docx.ts";
import { renderCover, renderResume, renderStatement } from "./render.ts";

export type PackDocKind = "resume" | "cover" | "statement";
export type PackFormat = "pdf" | "docx";

export interface PackInput {
  application_id?: string;
  template_id: string;
  job_title: string;
  company: string;
  resume: unknown;
  cover?: unknown;
  statement?: unknown;
  /** Per-document format; defaults to pdf everywhere. */
  formats?: Partial<Record<PackDocKind, PackFormat>>;
  /**
   * Relevance-only section plan from adaptive-cv. Advisory: shown at pack
   * review where the user can reject it. Never applied silently.
   */
  section_plan?: SectionPlanItem[];
}

/** One item of the advisory section plan (see apps/server/src/adaptive-cv.ts). */
export interface SectionPlanItem {
  section: string;
  order: number;
  leads_with: string | null;
  why: string;
}

export interface PackDocument {
  id: string;
  kind: PackDocKind;
  format: PackFormat;
  filename: string;
  artifact_id: string;
  sha256: string;
  byte_size: number;
  page_count: number;
}

export interface PackManifest {
  id: string;
  kind: "pack_manifest";
  application_id?: string;
  job_title: string;
  company: string;
  template_id: string;
  created_at: string;
  documents: PackDocument[];
  status: "pack_review" | "pack_approved" | "pack_drafting";
  revision_note?: string;
  /**
   * Advisory section plan (see PackInput.section_plan). Shown at pack review;
   * the user can reject it. Never applied silently.
   */
  section_plan?: SectionPlanItem[];
}

export interface PackerDeps {
  db: {
    put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T>;
    get<T>(owner: string, kind: string, id: string): Promise<T | null>;
    list<T>(owner: string, kind: string): Promise<T[]>;
  };
  dataDir: string;
  recordEvent(owner: string, type: string, payload: Record<string, unknown>): Promise<unknown>;
}

const KIND_TO_ARTIFACT: Record<PackDocKind, ArtifactKind> = {
  resume: "resume_final_candidate",
  cover: "cover_final_candidate",
  statement: "statement_final_candidate",
};

const KIND_RENDER = {
  resume: renderResume,
  cover: renderCover,
  statement: renderStatement,
} as const;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, _out, stderr) => {
        if (err) reject(new Error(`${cmd} failed: ${String(stderr).slice(0, 400) || err.message}`));
        else resolve();
      },
    );
  });
}

/** Render page-preview PNGs from the REAL document bytes. */
async function previewsFromBytes(format: PackFormat, bytes: Buffer): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), "oa-pack-preview-"));
  try {
    let pdfPath: string;
    if (format === "pdf") {
      pdfPath = join(dir, "doc.pdf");
      await writeFile(pdfPath, bytes);
    } else {
      const docxPath = join(dir, "doc.docx");
      await writeFile(docxPath, bytes);
      await run("soffice", ["--headless", "--convert-to", "pdf", "--outdir", dir, docxPath], dir);
      pdfPath = join(dir, "doc.pdf");
    }
    await run("pdftoppm", ["-png", "-r", "110", pdfPath, join(dir, "preview")], dir);
    const files = (await readdir(dir)).filter((f) => f.startsWith("preview-")).sort();
    const pages: Buffer[] = [];
    for (const f of files) pages.push(await readFile(join(dir, f)));
    if (pages.length === 0) throw new Error("No preview pages rendered from document bytes.");
    return pages;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function safeName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .slice(0, 80);
}

/**
 * Build a pack: render every document, store bytes + previews, register
 * artifacts, write the manifest, and move the application to pack_review.
 */
export async function buildPack(
  deps: PackerDeps,
  owner: string,
  input: PackInput,
): Promise<PackManifest> {
  const packId = randomUUID();
  const packDir = join(deps.dataDir, "packs", packId);
  const previewDir = join(packDir, "previews");
  await mkdir(previewDir, { recursive: true, mode: 0o700 });

  const docs: Array<{ kind: PackDocKind; content: unknown }> = [
    { kind: "resume", content: input.resume },
  ];
  if (input.cover !== undefined) docs.push({ kind: "cover", content: input.cover });
  if (input.statement !== undefined) docs.push({ kind: "statement", content: input.statement });

  const documents: PackDocument[] = [];
  for (const { kind, content } of docs) {
    const format: PackFormat = input.formats?.[kind] ?? "pdf";
    const docId = randomUUID();
    const ext = format === "pdf" ? "pdf" : "docx";
    const filename = `${safeName(input.company)} - ${safeName(input.job_title)} - ${kind}.${ext}`;

    // 1-2. Generate the real bytes, from the canonical JSON.
    const bytes =
      format === "pdf"
        ? Buffer.from((await KIND_RENDER[kind](input.template_id, content)).pdf)
        : await renderDocx(kind as DocxKind, input.template_id, content);

    // 3. Previews FROM those bytes.
    const pages = await previewsFromBytes(format, bytes);
    for (let i = 0; i < pages.length; i++)
      await writeFile(join(previewDir, `${docId}-p${i + 1}.png`), pages[i], { mode: 0o600 });

    await writeFile(join(packDir, `${docId}.${ext}`), bytes, { mode: 0o600 });

    const artifact: Artifact = {
      id: docId,
      kind: KIND_TO_ARTIFACT[kind],
      application_id: input.application_id,
      mime:
        format === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sha256: sha256Hex(bytes),
      byte_size: bytes.length,
      storage_path: `packs/${packId}/${docId}.${ext}`,
      agent_role: "packer",
      created_at: new Date().toISOString(),
    };
    await deps.db.put(owner, domainKinds.artifacts, artifact);

    documents.push({
      id: docId,
      kind,
      format,
      filename,
      artifact_id: docId,
      sha256: artifact.sha256,
      byte_size: bytes.length,
      page_count: pages.length,
    });
  }

  const manifest: PackManifest = {
    id: packId,
    kind: "pack_manifest",
    application_id: input.application_id,
    job_title: input.job_title,
    company: input.company,
    template_id: input.template_id,
    created_at: new Date().toISOString(),
    documents,
    status: "pack_review",
    section_plan: input.section_plan,
  };
  await deps.db.put(owner, domainKinds.artifacts, {
    id: packId,
    kind: "pack_manifest" as ArtifactKind,
    application_id: input.application_id,
    mime: "application/json",
    sha256: sha256Hex(Buffer.from(JSON.stringify(manifest))),
    byte_size: JSON.stringify(manifest).length,
    storage_path: `packs/${packId}/manifest.json`,
    agent_role: "packer",
    created_at: manifest.created_at,
  });
  await writeFile(join(packDir, "manifest.json"), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });

  if (input.application_id) {
    const app = await deps.db.get<{ id: string; state: string }>(
      owner,
      domainKinds.applications,
      input.application_id,
    );
    if (app) {
      const now = new Date().toISOString();
      await deps.db.put(owner, domainKinds.applications, {
        ...app,
        state: "pack_review",
        state_entered_at: now,
        pack_id: packId,
      });
      await deps.recordEvent(owner, "application.state_changed", {
        application_id: input.application_id,
        previous_state: app.state,
        new_state: "pack_review",
        actor: "system",
        inferred: false,
        note: "pack built",
      });
    }
  }

  await deps.recordEvent(owner, "pack.built", {
    pack_id: packId,
    application_id: input.application_id,
    documents: documents.map((d) => `${d.kind}.${d.format}`),
    template_id: input.template_id,
  });

  return manifest;
}

/** Read a manifest back from disk (source of truth for serving). */
export async function readPackManifest(dataDir: string, packId: string): Promise<PackManifest> {
  const raw = await readFile(join(dataDir, "packs", packId, "manifest.json"), "utf-8");
  return JSON.parse(raw) as PackManifest;
}

/** Persist a manifest status change (approve / request changes). */
export async function writePackStatus(
  deps: PackerDeps,
  owner: string,
  packId: string,
  status: PackManifest["status"],
  revisionNote?: string,
): Promise<PackManifest> {
  const manifest = await readPackManifest(deps.dataDir, packId);
  manifest.status = status;
  if (revisionNote !== undefined) manifest.revision_note = revisionNote;
  await writeFile(
    join(deps.dataDir, "packs", packId, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    {
      mode: 0o600,
    },
  );
  if (manifest.application_id) {
    const app = await deps.db.get<{ id: string; state: string }>(
      owner,
      domainKinds.applications,
      manifest.application_id,
    );
    if (app) {
      const now = new Date().toISOString();
      const newState = status === "pack_approved" ? "pack_approved" : "pack_drafting";
      await deps.db.put(owner, domainKinds.applications, {
        ...app,
        state: newState,
        state_entered_at: now,
      });
      await deps.recordEvent(owner, "application.state_changed", {
        application_id: manifest.application_id,
        previous_state: app.state,
        new_state: newState,
        actor: "user",
        inferred: false,
        note: status === "pack_approved" ? "pack approved" : "changes requested",
      });
    }
  }
  await deps.recordEvent(
    owner,
    status === "pack_approved" ? "pack.approved" : "pack.changes_requested",
    {
      pack_id: packId,
      application_id: manifest.application_id,
      ...(revisionNote ? { note: revisionNote } : {}),
    },
  );
  return manifest;
}
