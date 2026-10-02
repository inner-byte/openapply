import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { createBrowserManager, validateSessionId } from "./browser.ts";
import { WorkerError } from "./errors.ts";

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new WorkerError("INVALID_BODY", "A JSON request body is required.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 64 * 1024)
      throw new WorkerError("BODY_TOO_LARGE", "Request body exceeds 64 KiB.", 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Invalid object");
    return result as Record<string, unknown>;
  } catch {
    throw new WorkerError("INVALID_BODY", "A JSON object is required.");
  }
}

function requiredUrl(body: Record<string, unknown>): string {
  if (typeof body.url !== "string" || body.url.length > 8192)
    throw new WorkerError("INVALID_URL", "A URL of at most 8192 characters is required.");
  return body.url;
}

export async function createWorkerServer(options: {
  token: string;
  dataDir: string;
  maxSessions?: number;
  idleTimeoutMs?: number;
  packDir?: string;
  upstreamProxy?: string;
}) {
  if (options.token.length < 32)
    throw new Error("WORKER_TOKEN must contain at least 32 characters.");
  const tokenHash = createHash("sha256").update(`Bearer ${options.token}`).digest();
  /**
   * Parallel computer isolation: the server derives a per-role credential as
   * HMAC(master, "openapply-worker:<role>") and sends the role in the
   * `x-worker-role` header. Accept the master token (operations, debugging)
   * or the matching derived token. timingSafeEqual throws on length
   * mismatch, so compare lengths first.
   */
  const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
  const authorized = (request: IncomingMessage): boolean => {
    const presented = createHash("sha256")
      .update(request.headers.authorization ?? "")
      .digest();
    if (safeEqual(presented, tokenHash)) return true;
    const role = request.headers["x-worker-role"];
    if (typeof role === "string" && /^[a-z]{1,16}$/.test(role)) {
      const derived = createHmac("sha256", options.token)
        .update(`openapply-worker:${role}`)
        .digest("hex");
      const derivedHash = createHash("sha256").update(`Bearer ${derived}`).digest();
      if (safeEqual(presented, derivedHash)) return true;
    }
    return false;
  };
  const browser = await createBrowserManager(options);
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    try {
      const pathname = new URL(request.url ?? "/", "http://worker").pathname;
      if (request.method === "GET" && pathname === "/health") {
        json(200, { status: "ok" });
        return;
      }
      if (!authorized(request))
        throw new WorkerError("UNAUTHORIZED", "Worker authentication is required.", 401);
      if (pathname === "/sessions" && request.method === "GET") {
        json(200, browser.list());
        return;
      }
      if (pathname === "/sessions" && request.method === "POST") {
        const body = await readBody(request);
        const options: { profileKey?: string; idleMinutes?: number; sessionClass?: string } = {};
        if (body.profile_key !== undefined) options.profileKey = body.profile_key as string;
        if (body.idle_minutes !== undefined) options.idleMinutes = body.idle_minutes as number;
        if (body.session_class !== undefined) options.sessionClass = body.session_class as string;
        json(201, await browser.create(validateSessionId(body.id), requiredUrl(body), options));
        return;
      }
      const match =
        /^\/sessions\/([^/]+)\/(navigate|close|screenshot|read|input|downloads|file-chooser|submit)(?:\/([^/]+))?$/.exec(
          pathname,
        );
      if (!match) throw new WorkerError("NOT_FOUND", "Worker endpoint not found.", 404);
      const id = validateSessionId(match[1]);
      const action = match[2];
      const downloadId = match[3];
      if (action === "navigate" && !downloadId && request.method === "POST")
        json(200, await browser.navigate(id, requiredUrl(await readBody(request))));
      else if (action === "close" && !downloadId && request.method === "POST")
        json(200, await browser.closeSession(id));
      else if (action === "input" && !downloadId && request.method === "POST")
        json(200, await browser.input(id, await readBody(request)));
      else if (action === "file-chooser" && !downloadId && request.method === "POST") {
        const body = await readBody(request);
        json(200, await browser.fileChooser(id, body.paths));
      } else if (action === "submit" && !downloadId && request.method === "POST")
        json(200, await browser.submit(id));
      else if (action === "read" && !downloadId && request.method === "GET")
        json(200, await browser.read(id));
      else if (action === "screenshot" && !downloadId && request.method === "GET") {
        const bytes = await browser.screenshot(id);
        response.writeHead(200, { "content-type": "image/png", "content-length": bytes.length });
        response.end(bytes);
      } else if (action === "downloads" && request.method === "GET") {
        if (!downloadId) json(200, await browser.downloads(id));
        else {
          const result = await browser.download(id, downloadId);
          response.writeHead(200, {
            "content-type": "application/pdf",
            "content-length": result.bytes.length,
            "content-disposition": `attachment; filename="${result.metadata.name}"`,
          });
          response.end(result.bytes);
        }
      } else throw new WorkerError("NOT_FOUND", "Worker endpoint not found.", 404);
    } catch (error) {
      const safe =
        error instanceof WorkerError
          ? error
          : new WorkerError(
              "WORKER_FAILURE",
              "The browser operation failed. Check worker health and reopen the session.",
              500,
            );
      if (!response.headersSent && !response.destroyed)
        json(safe.status, { error: { code: safe.code, message: safe.message } });
      else response.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return {
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await browser.close();
    },
  };
}
