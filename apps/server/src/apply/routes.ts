/**
 * Apply routes (Slice 9): supervised apply for a pack_approved application.
 *
 *   POST /api/applications/:id/usher          bind profile / session
 *   POST /api/applications/:id/prefill        fill fields + attach manifest files
 *   POST /api/applications/:id/approve-submit explicit submit approval (target=submit)
 *   POST /api/applications/:id/submit        submit_waiter: clicks only on stored approval
 *   GET  /api/applications/:id/apply-state   current apply session status
 *
 * Nothing here submits without a stored Approval(target=submit,
 * status=approved). Pack approval is not submit approval.
 */
import type { Hono } from "hono";
import { z } from "zod";
import type { Application } from "../../../../packages/domain/src/openapply.ts";
import { domainKinds } from "../../../../packages/domain/src/openapply.ts";
import type { BrowserService } from "../browser.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import type { DomainService } from "../domain.ts";
import type { ModelGateway } from "../gateway.ts";
import type { ProfileStore } from "../profile.ts";
import { type ApplyBrowser, WorkerApplyBrowser } from "./browser-adapter.ts";
import { prefillApplication } from "./prefill.ts";
import { getApplySession } from "./session.ts";
import { approveSubmit, submitApplication } from "./submit.ts";
import { usherApplication } from "./usher.ts";

const approveSubmitSchema = z.object({ confirm: z.literal(true) });

export function registerApplyRoutes(
  app: Hono<{ Variables: { owner: string } }>,
  db: Store,
  config: Config,
  domain: DomainService,
  profileStore: ProfileStore,
  browserService: BrowserService,
  gateway: ModelGateway,
  browser?: ApplyBrowser,
) {
  const applyBrowser: ApplyBrowser = browser ?? new WorkerApplyBrowser(db, config, browserService);
  const recordEvent = (owner: string, type: string, payload: Record<string, unknown>) =>
    domain.recordEvent(owner, type, payload);

  app.post("/api/applications/:id/usher", async (c) => {
    const owner = c.get("owner");
    const result = await usherApplication(
      { db, recordEvent, browser: applyBrowser },
      owner,
      c.req.param("id"),
    );
    return c.json(result);
  });

  app.post("/api/applications/:id/prefill", async (c) => {
    const owner = c.get("owner");
    const result = await prefillApplication(
      {
        db,
        dataDir: config.dataDir,
        profileStore,
        recordEvent,
        browser: applyBrowser,
        complete: (o, input) => gateway.complete(o, input),
      },
      owner,
      c.req.param("id"),
    );
    return c.json(result);
  });

  app.post("/api/applications/:id/approve-submit", async (c) => {
    const owner = c.get("owner");
    const body = approveSubmitSchema.safeParse(await c.req.json().catch(() => ({})));
    const result = await approveSubmit(
      {
        db,
        recordEvent,
        browser: applyBrowser,
        complete: (o, input) => gateway.complete(o, input),
      },
      owner,
      c.req.param("id"),
      body.success,
    );
    return c.json(result);
  });

  app.post("/api/applications/:id/submit", async (c) => {
    const owner = c.get("owner");
    const result = await submitApplication(
      {
        db,
        recordEvent,
        browser: applyBrowser,
        complete: (o, input) => gateway.complete(o, input),
      },
      owner,
      c.req.param("id"),
    );
    return c.json(result);
  });

  app.get("/api/applications/:id/apply-state", async (c) => {
    const owner = c.get("owner");
    const application = await db.get<Application>(
      owner,
      domainKinds.applications,
      c.req.param("id"),
    );
    if (!application) return c.json({ error: "Application not found" }, 404);
    const session = await getApplySession(db, owner, application.id);
    const live =
      session?.session_id != null && session.session_id !== ""
        ? await applyBrowser.getSession(owner, session.session_id)
        : null;
    return c.json({
      application_state: application.state,
      browser_profile_key: application.browser_profile_key ?? null,
      session: session
        ? {
            state: session.state,
            origin: session.origin,
            idle_deadline: session.idle_deadline,
            warm:
              !!live &&
              (live.status === "active" || live.status === "idle") &&
              new Date(session.idle_deadline).getTime() > Date.now(),
          }
        : null,
    });
  });
}
