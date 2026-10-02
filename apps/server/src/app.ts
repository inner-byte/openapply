import { randomUUID } from "node:crypto";
import { MessageSchema } from "@ag-ui/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { emailDraftSchema, proposalSchema } from "../../../packages/domain/src/index.ts";
import { isCustomProviderId } from "../../../packages/domain/src/openapply.ts";
import { ActionService } from "./actions.ts";
import { registerAdaptiveCvRoutes } from "./adaptive-cv.ts";
import { agentConfigured } from "./agent.ts";
import { registerApplicationRoutes } from "./applications.ts";
import { registerApplyRoutes } from "./apply/routes.ts";
import { createAuth } from "./auth.ts";
import { BrowserService } from "./browser.ts";
import { ChatApprovals, ensureThread, registerChatRoutes } from "./chat.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { DomainService } from "./domain.ts";
import { agentRoutes } from "./engine/routes.ts";
import { AgentService } from "./engine/service.ts";
import { AppError } from "./errors.ts";
import { Files } from "./files.ts";
import { GatewayError, ModelGateway } from "./gateway.ts";
import { GoogleAuth } from "./google-auth.ts";
import { registerBrowserHuntRoutes } from "./hunter/browser-hunt.ts";
import { HunterScheduler } from "./hunter/scheduler.ts";
import { ModelAccounts } from "./models.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import { registerPackRoutes } from "./packs.ts";
import { ProfileStore } from "./profile.ts";
import { registerTrackerRoutes } from "./tracker/routes.ts";
import { WorkspaceService } from "./workspace.ts";

export async function createApp(db: Store, config: Config) {
  const auth = await createAuth(db, config),
    files = new Files(db, config, auth),
    google = new GoogleAuth(db, config),
    workspace = new WorkspaceService(db, config, files, google),
    domain = new DomainService(db, config),
    modelAccounts = new ModelAccounts(db, config),
    gateway = new ModelGateway(db, modelAccounts, (owner) => domain.getPreferences(owner)),
    profile = new ProfileStore(db, config.dataDir, {
      ocr: async (owner, image, mime) => {
        const result = await gateway.complete(owner, {
          purpose: "ocr evidence image",
          system:
            "You transcribe text visible in images. Return only the transcription, " +
            "preserving reading order. If no text is visible, return an empty string.",
          messages: [
            {
              role: "user",
              content: "Transcribe all visible text in this image exactly.",
              images: [{ mime, base64: Buffer.from(image).toString("base64") }],
            },
          ],
          tier: "cheap",
        });
        return result.text.trim();
      },
    });
  const actions = new ActionService(db, {
    execute: (owner, input, connectionId, targetVersion) =>
      workspace.execute(owner, input, connectionId, targetVersion),
    prepare: (owner, input, connectionId) => workspace.prepare(owner, input, connectionId),
    connected: (owner) => workspace.connected(owner),
    connection: (owner) => workspace.connection(owner),
  });
  const browser = new BrowserService(db, config, auth, files);
  const agent = new AgentService(db, config, workspace, files, actions, browser);
  // Human-approval gate for chat tool calls that need it; pending approvals
  // survive in the store so a restart still lists them (deciding a stale run
  // returns 410).
  const approvals = new ChatApprovals(db);
  const app = new Hono<{ Variables: { owner: string } }>();
  const origins = new Set([...config.allowedOrigins, new URL(config.publicUrl).origin]);
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin)) return c.json({ error: "Origin is not allowed" }, 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin) => (origins.has(origin) ? origin : undefined),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 12 * 1024 * 1024,
      onError: (c) => c.json({ error: "Request is too large; PDFs must be 10 MB or smaller" }, 413),
    }),
  );
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json({ error: error.issues.map((i) => i.message).join("; ") }, 422);
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    if (error.name === "PdfError" || error.name === "RecurringEventError")
      return c.json({ error: error.message }, 422);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid request data" }, 400);
    // Provider and document errors are useful, but raw stack traces and token-bearing responses are not.
    console.error(`[OpenApply] ${error.name}`);
    return c.json(
      {
        error:
          error.name === "PdfError" || error.name === "GoogleApiError"
            ? error.message
            : "Request failed. Check the server setup and try again.",
      },
      502,
    );
  });
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      mode: config.mode,
      agentConfigured: agentConfigured(config),
      browserConfigured: Boolean(config.workerUrl && config.workerToken),
    }),
  );
  let loginWindow = 0,
    loginAttempts = 0;
  app.post("/api/session", async (c) => {
    if (Date.now() - loginWindow > 60000) {
      loginWindow = Date.now();
      loginAttempts = 0;
    }
    if (++loginAttempts > 30)
      throw new AppError("Too many sign-in attempts. Try again in a minute.", 429);
    const body = z.object({ accessKey: z.string().optional() }).parse(await c.req.json());
    const session = await auth.session(body.accessKey);
    await workspace.ensureSample("local-user", actions);
    await agent.ensure("local-user");
    if (config.mode === "sample") await agent.refreshIdeas("local-user");
    return c.json(session);
  });
  app.get("/api/google/callback", async (c) => {
    if (c.req.query("error"))
      return c.html("<h1>Google connection cancelled</h1><p>You can return to OpenApply.</p>", 400);
    const state = c.req.query("state"),
      code = c.req.query("code");
    if (!state || !code) throw new AppError("Google callback is incomplete");
    await google.callback(state, code);
    return c.html(
      "<h1>Google is connected</h1><p>Return to OpenApply and refresh your workspace.</p>",
    );
  });
  app.use("/api/*", async (c, next) => {
    const signedRoute =
      /^\/api\/files\/[^/]+\/content$|^\/api\/browsers\/[^/]+\/(?:preview|console)$|^\/api\/packs\/[^/]+\/(?:previews|documents)\/[^/]+(?:\/[^/]+)?$/.test(
        c.req.path,
      );
    const owner =
      signedRoute && c.req.query("signature")
        ? auth.verify(new URL(c.req.url))
        : await auth.owner(c.req.header("authorization"));
    c.set("owner", owner);
    await next();
  });
  app.get("/api/workspace", async (c) => {
    const [snapshot, reachable] = await Promise.all([
      workspace.snapshot(c.get("owner"), c.req.query("q")),
      browser.reachable(),
    ]);
    snapshot.browsers = snapshot.browsers.map((s) => browser.decorate(c.get("owner"), s));
    // A configured worker that does not answer is offline, not ready.
    snapshot.connections = snapshot.connections.map((connection) =>
      connection.id === "browser" && connection.status === "connected" && !reachable
        ? { ...connection, status: "unavailable" }
        : connection,
    );
    return c.json(snapshot);
  });
  app.route("/api/agent", agentRoutes(agent));
  app.get("/api/calendars", async (c) => c.json(await workspace.calendars(c.get("owner"))));
  app.get("/api/calendar/events", async (c) => {
    const query = z
      .object({
        calendarId: z.string().min(1).max(1024).optional(),
        timeMin: z.iso.datetime({ offset: true }).optional(),
        timeMax: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(c.req.query());
    if (
      query.timeMin &&
      query.timeMax &&
      (Date.parse(query.timeMax) <= Date.parse(query.timeMin) ||
        Date.parse(query.timeMax) - Date.parse(query.timeMin) > 366 * 86400000)
    )
      throw new AppError("Choose a calendar range between one moment and 366 days", 422);
    return c.json(await workspace.events(c.get("owner"), query));
  });
  app.get("/api/mail/threads/:id", async (c) =>
    c.json(await workspace.thread(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/actions", async (c) => {
    const input = proposalSchema.parse(await c.req.json());
    if (input.kind === "email.send")
      for (const id of input.data.attachmentIds) await files.get(c.get("owner"), id);
    return c.json(await actions.propose(c.get("owner"), input), 201);
  });
  app.post("/api/actions/:id/decide", async (c) => {
    const body = z
      .object({ hash: z.string(), decision: z.enum(["approve", "deny"]) })
      .parse(await c.req.json());
    return c.json(
      await actions.decide(c.get("owner"), c.req.param("id"), body.hash, body.decision),
    );
  });
  app.get("/api/drafts", async (c) => c.json(await db.list(c.get("owner"), "drafts")));
  app.post("/api/drafts", async (c) => {
    const body = emailDraftSchema.extend({ id: z.string().optional() }).parse(await c.req.json());
    const existing = body.id
      ? await db.get<{ createdAt: string }>(c.get("owner"), "drafts", body.id)
      : null;
    if (body.id && !existing) throw new AppError("Draft not found", 404);
    return c.json(
      await db.put(c.get("owner"), "drafts", {
        ...body,
        id: body.id ?? randomUUID(),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      }),
      201,
    );
  });
  app.get("/api/main-thread", async (c) => {
    const owner = c.get("owner");
    await db.insertIfAbsent(owner, "conversation-settings", {
      id: "main",
      threadId: randomUUID(),
      existing: false,
    });
    const main = await db.get<{ threadId: string }>(owner, "conversation-settings", "main");
    if (!main) throw new AppError("Main conversation could not be loaded", 503);
    // Threads now live in the app's own store instead of cloud storage.
    const thread = await ensureThread(db, owner, main.threadId);
    return c.json({ threadId: thread.id, existing: true });
  });
  app.get("/api/conversation", async (c) =>
    c.json((await db.get(c.get("owner"), "conversations", "default")) ?? { messages: [] }),
  );
  app.put("/api/conversation", async (c) => {
    const body = await c.req.json();
    const messages = z.array(z.unknown()).max(1000).parse(body.messages);
    for (const message of messages) MessageSchema.parse(message);
    await db.put(c.get("owner"), "conversations", { id: "default", messages });
    return c.json({ ok: true });
  });
  app.post("/api/files", async (c) => {
    const data = await c.req.parseBody();
    const file = data.file;
    if (!(file instanceof File)) throw new AppError("Choose a PDF file");
    return c.json(
      await files.import(
        c.get("owner"),
        file.name,
        new Uint8Array(await file.arrayBuffer()),
        "Uploaded by you",
      ),
      201,
    );
  });
  app.get("/api/files/:id/content", async (c) => {
    const file = await files.get(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return c.body(await files.bytes(c.get("owner"), file.id));
  });
  app.post("/api/files/:id/fill", async (c) => {
    const body = z
      .object({ fields: z.record(z.string(), z.union([z.string(), z.boolean()])) })
      .parse(await c.req.json());
    return c.json(await files.fill(c.get("owner"), c.req.param("id"), body.fields), 201);
  });
  app.post("/api/mail/import-attachment", async (c) => {
    const body = z.object({ reference: z.string() }).parse(await c.req.json());
    return c.json(await workspace.importAttachment(c.get("owner"), body.reference), 201);
  });
  app.post("/api/jobs", async (c) => {
    const { posting, created } = await domain.insertJobPosting(c.get("owner"), await c.req.json());
    return c.json({ posting, created }, created ? 201 : 200);
  });
  app.get("/api/jobs", async (c) => {
    const owner = c.get("owner");
    const [postings, scores] = await Promise.all([
      domain.listJobPostings(owner),
      domain.listJobScores(owner),
    ]);
    const byJob = new Map(scores.map((s) => [s.job_id, s.score]));
    return c.json(
      postings
        .map((p) => ({ ...p, score: byJob.get(p.id) ?? null }))
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
    );
  });
  app.get("/api/jobs/:id", async (c) => {
    const owner = c.get("owner");
    const posting = await domain.getJobPosting(owner, c.req.param("id"));
    const scored = await domain.getJobScore(owner, posting.id);
    return c.json({
      ...posting,
      score: scored?.score ?? null,
      score_reasons: scored?.reasons ?? [],
      missing_requirements: scored?.missing_requirements ?? [],
    });
  });
  const hunter = new HunterScheduler(db, domain);
  const orchestrator = new Orchestrator({
    db,
    domain,
    config,
    profileStore: profile,
    dataDir: config.dataDir,
    complete: (owner, input) => gateway.complete(owner, input),
    hunter,
  });
  app.post("/api/hunter/scan", async (c) => c.json(await orchestrator.scanHunter(c.get("owner"))));
  app.get("/api/hunter/state", async (c) =>
    c.json((await hunter.getState(c.get("owner"))) ?? { id: "default" }),
  );
  app.get("/api/orchestrator/runs", async (c) => {
    const q = c.req.query();
    return c.json(
      await orchestrator.listRuns(c.get("owner"), {
        application_id: q.application_id,
        state: q.state as "queued" | "running" | "done" | "failed" | undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    );
  });
  app.get("/api/orchestrator/runs/:id", async (c) => {
    const run = await orchestrator.getRun(c.get("owner"), c.req.param("id"));
    if (!run) return c.json({ error: "not_found" }, 404);
    return c.json(run);
  });
  app.get("/api/orchestrator/state", async (c) => c.json(await orchestrator.getState()));
  app.post("/api/orchestrator/tick", async (c) => {
    await orchestrator.tick();
    return c.json({ ok: true, ...(await orchestrator.getState()) });
  });
  app.post("/api/orchestrator/applications/:id/advance", async (c) =>
    c.json(await orchestrator.advanceApplication(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/inbox", async (c) => {
    const data = await c.req.parseBody();
    const file = data.file;
    if (!(file instanceof File)) throw new AppError("Choose a file to upload");
    return c.json(
      {
        artifact: await domain.inboxUpload(
          c.get("owner"),
          file.name,
          new Uint8Array(await file.arrayBuffer()),
        ),
      },
      201,
    );
  });
  app.get("/api/profile", async (c) => c.json(await profile.get(c.get("owner"))));
  app.post("/api/profile/upload", async (c) => {
    const data = await c.req.parseBody();
    const file = data.file;
    if (!(file instanceof File)) throw new AppError("Choose a file to upload");
    const kind = typeof data.kind === "string" ? data.kind : "resume";
    return c.json(
      {
        item: await profile.upload(
          c.get("owner"),
          file.name,
          new Uint8Array(await file.arrayBuffer()),
          kind as Parameters<ProfileStore["upload"]>[3],
        ),
      },
      201,
    );
  });
  app.post("/api/profile/facts", async (c) => {
    const body = await c.req.json();
    return c.json(
      {
        fact: await profile.addFact(
          c.get("owner"),
          String(body.field ?? ""),
          String(body.value ?? ""),
          String(body.evidence_id ?? ""),
        ),
      },
      201,
    );
  });
  app.delete("/api/profile/facts/:id", async (c) =>
    c.json(await profile.removeFact(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/profile/confirm", async (c) => c.json(await profile.confirm(c.get("owner"))));
  app.delete("/api/profile/evidence/:id", async (c) =>
    c.json(await profile.forgetEvidence(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/inbox", async (c) => c.json(await domain.listArtifacts(c.get("owner"))));
  app.get("/api/events", async (c) => c.json(await domain.listEvents(c.get("owner"))));
  app.get("/api/preferences", async (c) => c.json(await domain.getPreferences(c.get("owner"))));
  registerPackRoutes(app, db, config, auth, domain);
  registerApplicationRoutes(app, db, config, auth, domain, profile, gateway, orchestrator);
  registerAdaptiveCvRoutes(app, db, config.dataDir, profile);
  registerApplyRoutes(app, db, config, domain, profile, browser, gateway);
  registerBrowserHuntRoutes(app, domain, browser, gateway);
  registerTrackerRoutes(app, db, domain, workspace, gateway);
  registerChatRoutes(app, db, config, agent, modelAccounts, domain, approvals);
  app.put("/api/preferences", async (c) =>
    c.json(await domain.updatePreferences(c.get("owner"), await c.req.json())),
  );
  // Model gateway (docs/MODELS.md): one interface for every connect.
  app.get("/api/models", async (c) => {
    const owner = c.get("owner");
    const prefs = await domain.getPreferences(owner);
    return c.json({
      accounts: await modelAccounts.list(owner),
      custom_providers: prefs.custom_providers ?? [],
      settings: {
        cheap_provider: prefs.cheap_provider,
        cheap_model: prefs.cheap_model,
        strong_provider: prefs.strong_provider,
        strong_model: prefs.strong_model,
      },
    });
  });
  app.post("/api/models/connect", async (c) => {
    const account = await modelAccounts.connectApiKey(c.get("owner"), await c.req.json());
    return c.json({ account }, 201);
  });
  // Slice 15: user-defined custom providers. No one-provider limit; each
  // connect mints its own id and vault credential.
  app.post("/api/models/custom/connect", async (c) => {
    const owner = c.get("owner");
    const record = await modelAccounts.connectCustomProvider(owner, await c.req.json());
    try {
      await domain.addCustomProvider(owner, {
        ...record,
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      await modelAccounts.deleteCustomProvider(owner, record.id).catch(() => {});
      throw error;
    }
    return c.json({ provider: record }, 201);
  });
  app.post("/api/models/custom/test", async (c) => {
    const body = z.object({ base_url: z.string(), api_key: z.string() }).parse(await c.req.json());
    return c.json(await modelAccounts.discoverCustomModels(body));
  });
  app.post("/api/models/discover", async (c) => {
    const body = z
      .object({ provider: z.string(), api_key: z.string(), base_url: z.string().optional() })
      .parse(await c.req.json());
    return c.json(await modelAccounts.discoverModels(body));
  });
  app.post("/api/models/image", async (c) => {
    const body = z
      .object({
        provider: z.string(),
        prompt: z.string(),
        model: z.string().optional(),
        size: z.string().optional(),
      })
      .parse(await c.req.json());
    return c.json(await modelAccounts.generateImage(c.get("owner"), body));
  });
  app.post("/api/models/disconnect", async (c) => {
    const owner = c.get("owner");
    const body = z.object({ provider: z.string() }).parse(await c.req.json());
    // Slice 15: deleting a user-defined custom provider is blocked (409)
    // while a tier or role override still references it, so settings can
    // never silently point at a deleted provider.
    const prefs = await domain.getPreferences(owner);
    if ((prefs.custom_providers ?? []).some((p) => p.id === body.provider)) {
      const refs = domain.customProviderReferences(prefs, body.provider);
      if (refs.length)
        return c.json(
          {
            error: `Cannot delete this provider: it is still used by ${refs.join(" and ")}. Point ${refs.length > 1 ? "them" : "it"} at another provider in Models first.`,
          },
          409,
        );
      await modelAccounts.deleteCustomProvider(owner, body.provider);
      await domain.removeCustomProvider(owner, body.provider);
      return c.json({ ok: true });
    }
    if (isCustomProviderId(body.provider))
      return c.json({ error: `Unknown custom provider "${body.provider}".` }, 404);
    await modelAccounts.disconnect(owner, body.provider);
    return c.json({ ok: true });
  });
  app.post("/api/models/oauth/:provider/start", async (c) => {
    const started = await modelAccounts.oauthStart(c.get("owner"), c.req.param("provider"));
    return c.json(started, 201);
  });
  app.post("/api/models/oauth/:provider/finish", async (c) => {
    const body = z.object({ code: z.string(), state: z.string() }).parse(await c.req.json());
    const account = await modelAccounts.oauthFinish(c.get("owner"), c.req.param("provider"), body);
    return c.json({ account }, 201);
  });
  app.post("/api/models/test", async (c) => {
    const body = z.object({ tier: z.enum(["cheap", "strong"]) }).parse(await c.req.json());
    try {
      return c.json(await gateway.testTier(c.get("owner"), body.tier));
    } catch (error) {
      if (error instanceof GatewayError)
        return c.json(
          { ok: false, error_class: error.errorClass, message: error.message },
          error.status,
        );
      throw error;
    }
  });
  app.post("/api/google/connect", async (c) => {
    const body = z.object({ capability: z.enum(["read", "write"]) }).parse(await c.req.json());
    if (config.mode === "sample") {
      await db.put(c.get("owner"), "settings", {
        id: "google",
        enabled: true,
        connectionId: randomUUID(),
      });
      return c.json({ url: null, connected: true });
    }
    return c.json(await google.connect(c.get("owner"), body.capability === "write"));
  });
  app.post("/api/google/disconnect", async (c) => {
    if (config.mode === "sample")
      await db.put(c.get("owner"), "settings", { id: "google", enabled: false });
    else await google.disconnect(c.get("owner"));
    return c.json({ ok: true });
  });
  app.post("/api/browsers", async (c) => {
    const body = z
      .object({
        url: z.url().max(4096),
        profile_key: z.string().max(120).optional(),
        session_class: z.string().max(32).optional(),
        idle_minutes: z.number().int().min(5).max(720).optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await browser.create(c.get("owner"), body.url, {
        profileKey: body.profile_key,
        sessionClass: body.session_class,
        idleMinutes: body.idle_minutes,
      }),
      201,
    );
  });
  app.get("/api/browsers/:id", async (c) => {
    const owner = c.get("owner");
    return c.json(browser.decorate(owner, await browser.get(owner, c.req.param("id"))));
  });
  app.post("/api/browsers/:id/navigate", async (c) => {
    const body = z.object({ url: z.url().max(4096) }).parse(await c.req.json());
    return c.json(await browser.navigate(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/close", async (c) =>
    c.json(await browser.close(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/read", async (c) =>
    c.json(await browser.read(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/browsers/:id/reopen", async (c) => {
    const raw = await c.req.text();
    const body = z.object({ url: z.url().max(4096).optional() }).parse(raw ? JSON.parse(raw) : {});
    return c.json(await browser.reopen(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/import-downloads", async (c) =>
    c.json(await browser.imports(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/preview", async (c) => {
    const response = await browser.preview(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", "image/png");
    return c.body(await response.arrayBuffer());
  });
  app.get("/api/browsers/:id/console", async (c) => {
    await browser.get(c.get("owner"), c.req.param("id"));
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    );
    return c.html(browser.console(c.get("owner"), c.req.param("id")));
  });
  app.post("/api/browsers/:id/console", async (c) => {
    await browser.input(c.get("owner"), c.req.param("id"), await c.req.json());
    return c.json({ ok: true });
  });
  app.get("/", (c) =>
    c.json({ name: "OpenApply", app: "http://localhost:8081", health: "/api/health" }),
  );
  return { app, auth, files, actions, workspace, agent, domain, hunter, orchestrator };
}
