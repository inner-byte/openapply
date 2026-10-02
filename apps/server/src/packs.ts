/**
 * Pack HTTP routes: build, inspect, preview, download, approve.
 *
 * The review loop: the client renders page previews (rasterized from the
 * real document bytes at pack time) and offers the original PDF/DOCX for
 * download. Approval(target=pack) gates downstream submission (Slice 9).
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import type { Approval, Artifact } from "../../../packages/domain/src/openapply.ts";
import { domainKinds } from "../../../packages/domain/src/openapply.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import type { DomainService } from "./domain.ts";
import { AppError } from "./errors.ts";
import {
  buildPack,
  type PackerDeps,
  type PackManifest,
  readPackManifest,
  writePackStatus,
} from "./foundry/packer.ts";

const packInputSchema = z.object({
  application_id: z.string().min(1).max(100).optional(),
  template_id: z.string().min(1).max(40),
  job_title: z.string().trim().min(1).max(200),
  company: z.string().trim().min(1).max(200),
  resume: z.unknown(),
  cover: z.unknown().optional(),
  statement: z.unknown().optional(),
  formats: z
    .object({
      resume: z.enum(["pdf", "docx"]).optional(),
      cover: z.enum(["pdf", "docx"]).optional(),
      statement: z.enum(["pdf", "docx"]).optional(),
    })
    .optional(),
});

function packView(auth: Auth, owner: string, manifest: PackManifest) {
  return {
    ...manifest,
    documents: manifest.documents.map((d) => ({
      ...d,
      preview_urls: Array.from({ length: d.page_count }, (_, i) =>
        auth.sign(owner, `/api/packs/${manifest.id}/previews/${d.id}/p${i + 1}.png`),
      ),
      content_url: auth.sign(owner, `/api/packs/${manifest.id}/documents/${d.id}/content`),
    })),
  };
}

async function requirePackArtifact(db: Store, owner: string, packId: string): Promise<Artifact> {
  const artifact = await db.get<Artifact>(owner, domainKinds.artifacts, packId);
  if (artifact?.kind !== "pack_manifest") throw new AppError("Pack not found", 404);
  return artifact;
}

export function registerPackRoutes(
  app: Hono<{ Variables: { owner: string } }>,
  db: Store,
  config: Config,
  auth: Auth,
  domain: DomainService,
) {
  const deps: PackerDeps = {
    db,
    dataDir: config.dataDir,
    recordEvent: (owner, type, payload) => domain.recordEvent(owner, type, payload),
  };

  app.post("/api/packs", async (c) => {
    const body = packInputSchema.parse(await c.req.json());
    const manifest = await buildPack(deps, c.get("owner"), body);
    return c.json(packView(auth, c.get("owner"), manifest), 201);
  });

  app.get("/api/packs", async (c) => {
    const owner = c.get("owner");
    const artifacts = await db.list<Artifact>(owner, domainKinds.artifacts);
    const packs = artifacts
      .filter((a) => a.kind === "pack_manifest")
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const manifests: PackManifest[] = [];
    for (const p of packs) {
      try {
        manifests.push(await readPackManifest(config.dataDir, p.id));
      } catch {
        // manifest file missing; skip
      }
    }
    return c.json(manifests.map((m) => packView(auth, owner, m)));
  });

  app.get("/api/packs/:id", async (c) => {
    const owner = c.get("owner");
    const id = c.req.param("id");
    await requirePackArtifact(db, owner, id);
    return c.json(packView(auth, owner, await readPackManifest(config.dataDir, id)));
  });

  app.get("/api/packs/:id/previews/:docId/:page", async (c) => {
    const owner = c.get("owner");
    const id = c.req.param("id");
    const docId = c.req.param("docId");
    await requirePackArtifact(db, owner, id);
    const manifest = await readPackManifest(config.dataDir, id);
    const doc = manifest.documents.find((d) => d.id === docId);
    if (!doc) throw new AppError("Document not found", 404);
    const match = /^p(\d+)\.png$/.exec(c.req.param("page"));
    const page = match ? Number(match[1]) : NaN;
    if (!Number.isInteger(page) || page < 1 || page > doc.page_count)
      throw new AppError("Page not found", 404);
    const bytes = await readFile(
      join(config.dataDir, "packs", id, "previews", `${docId}-p${page}.png`),
    );
    c.header("Content-Type", "image/png");
    c.header("Cache-Control", "private, max-age=3600");
    return c.body(bytes);
  });

  app.get("/api/packs/:id/documents/:docId/content", async (c) => {
    const owner = c.get("owner");
    const id = c.req.param("id");
    const docId = c.req.param("docId");
    await requirePackArtifact(db, owner, id);
    const manifest = await readPackManifest(config.dataDir, id);
    const doc = manifest.documents.find((d) => d.id === docId);
    if (!doc) throw new AppError("Document not found", 404);
    const ext = doc.format === "pdf" ? "pdf" : "docx";
    const bytes = await readFile(join(config.dataDir, "packs", id, `${docId}.${ext}`));
    c.header(
      "Content-Type",
      doc.format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    c.header(
      "Content-Disposition",
      `${doc.format === "pdf" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
    );
    return c.body(bytes);
  });

  app.post("/api/packs/:id/approve", async (c) => {
    const owner = c.get("owner");
    const id = c.req.param("id");
    await requirePackArtifact(db, owner, id);
    const manifest = await readPackManifest(config.dataDir, id);
    if (manifest.status !== "pack_approved") {
      const approval: Approval = {
        id: randomUUID(),
        application_id: manifest.application_id ?? "",
        target: "pack",
        status: "approved",
        decided_at: new Date().toISOString(),
      };
      await db.put(owner, domainKinds.approvals, approval);
    }
    const updated = await writePackStatus(deps, owner, id, "pack_approved");
    return c.json(packView(auth, owner, updated));
  });

  app.post("/api/packs/:id/request-changes", async (c) => {
    const owner = c.get("owner");
    const id = c.req.param("id");
    const { note } = z
      .object({ note: z.string().trim().max(2000).optional() })
      .parse(await c.req.json());
    await requirePackArtifact(db, owner, id);
    const updated = await writePackStatus(deps, owner, id, "pack_drafting", note);
    return c.json(packView(auth, owner, updated));
  });
}
