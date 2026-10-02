/**
 * Slice 11 — Tracker routes: user-started Gmail scan.
 *
 * POST /api/tracker/scan-mail { query? } — the owner asks to scan recent
 * Gmail for hiring mail; the tracker role maps messages onto application
 * states. Never automatic: no timer, no background login.
 */
import type { Hono } from "hono";
import { z } from "zod";
import type { Mail } from "../../../../packages/domain/src/index.ts";
import type { Store } from "../db.ts";
import type { DomainService } from "../domain.ts";
import type { ModelGateway } from "../gateway.ts";
import type { WorkspaceService } from "../workspace.ts";
import { trackMail } from "./gmail-track.ts";

const scanMailSchema = z.object({
  query: z.string().trim().max(200).default(""),
});

export function registerTrackerRoutes(
  app: Hono<{ Variables: { owner: string } }>,
  db: Store,
  domain: DomainService,
  workspace: WorkspaceService,
  gateway: ModelGateway,
): void {
  app.post("/api/tracker/scan-mail", async (c) => {
    const owner = c.get("owner");
    const body = scanMailSchema.parse(await c.req.json().catch(() => ({})));
    // Default query surfaces hiring mail; the owner can narrow it.
    const mails: Mail[] = await workspace.searchMail(
      owner,
      body.query || "interview OR offer OR application OR rejection",
    );
    // Newest first; the tracker caps at 25 per run.
    mails.sort((a, b) => b.date.localeCompare(a.date));
    return c.json(
      await trackMail(
        {
          db,
          domain,
          complete: (o, input) => gateway.complete(o, input),
        },
        owner,
        mails,
      ),
    );
  });
}
