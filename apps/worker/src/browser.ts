import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { BrowserContext, Page } from "playwright";
import {
  capturePdfDownload,
  MAX_DOWNLOAD_BYTES,
  type PdfDownload,
  readDownloadFailures,
  savePdfBytes,
} from "./downloads.ts";
import { WorkerError } from "./errors.ts";
import { validatePublicUrl } from "./network.ts";
import { parseUpstreamProxy, startEgressProxy } from "./proxy.ts";

export interface Session {
  id: string;
  title: string;
  url: string;
  status: "active" | "closed" | "error";
  updatedAt: string;
  /** Named Chromium profile shared across sessions, e.g. `apply:https://example.com`. */
  profileKey?: string;
  /** Per-session idle timeout in minutes; overrides the manager default. */
  idleMinutes?: number;
}
type Running = {
  context: BrowserContext;
  page: Page;
  touched: number;
  pending: Set<Promise<void>>;
  downloadError?: boolean;
  profileDir: string;
};
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_KEY = /^[A-Za-z0-9:_.-]{1,120}$/;

export function validateProfileKey(key: unknown): string {
  if (typeof key !== "string" || !PROFILE_KEY.test(key) || key.includes(".."))
    throw new WorkerError(
      "INVALID_PROFILE_KEY",
      "profile_key must be 1-120 characters of letters, digits, :, _, ., or -.",
    );
  return key;
}

/** Session-class defaults (minutes); an explicit idle_minutes always wins. */
const CLASS_IDLE_MINUTES: Record<string, number> = { apply: 120, hunt: 60 };

export function validateSessionId(id: unknown): string {
  if (typeof id !== "string" || !SESSION_ID.test(id))
    throw new WorkerError("INVALID_SESSION", "A valid UUID session ID is required.");
  return id.toLowerCase();
}

export async function createBrowserManager(options: {
  dataDir: string;
  maxSessions?: number;
  idleTimeoutMs?: number;
  /** Directory pack files are served from for the file-chooser endpoint. */
  packDir?: string;
  /**
   * Optional upstream proxy URL (http://[user:pass@]host:port) the worker's
   * egress proxy chains through. Needed in sandboxes without direct egress.
   * The worker still validates every destination; only DNS resolution and
   * transport move to the upstream proxy.
   */
  upstreamProxy?: string;
}) {
  const { dataDir, maxSessions = 3, idleTimeoutMs = 30 * 60_000 } = options;
  const packDir = resolve(options.packDir ?? join(dataDir, "..", "files"));
  const upstream = parseUpstreamProxy(options.upstreamProxy);
  const validateOptions = upstream ? { skipIpCheck: true } : {};
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(packDir, { recursive: true, mode: 0o700 });
  const sessions = new Map<string, Session>();
  const running = new Map<string, Running>();
  const queues = new Map<string, Promise<unknown>>();
  const proxy = await startEgressProxy(upstream);
  for (const id of await readdir(dataDir)) {
    if (!SESSION_ID.test(id)) continue;
    try {
      const stored = JSON.parse(
        await readFile(join(dataDir, id, "session.json"), "utf8"),
      ) as Session;
      sessions.set(id, { ...stored, id, status: "closed" });
    } catch {
      /* An incomplete first launch has no session metadata to restore. */
    }
    if (sessions.has(id)) await readDownloadFailures(join(dataDir, id), true);
  }
  const directory = (id: string) => join(dataDir, validateSessionId(id));
  async function persist(session: Session) {
    const path = join(directory(session.id), "session.json");
    await writeFile(`${path}.tmp`, JSON.stringify(session), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  async function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    queues.set(id, next);
    try {
      return await next;
    } finally {
      if (queues.get(id) === next) queues.delete(id);
    }
  }
  function active(id: string) {
    const value = running.get(id);
    if (!value || value.page.isClosed())
      throw new WorkerError(
        "SESSION_CLOSED",
        "Open this browser session before using its console.",
        409,
      );
    value.touched = Date.now();
    return value;
  }
  async function refresh(id: string) {
    const instance = active(id);
    if (instance.page.url() !== "about:blank")
      await validatePublicUrl(instance.page.url(), undefined, validateOptions);
    const session: Session = {
      id,
      title: (await instance.page.title()).slice(0, 300),
      url: instance.page.url(),
      status: "active",
      updatedAt: new Date().toISOString(),
      profileKey: sessions.get(id)?.profileKey,
      idleMinutes: sessions.get(id)?.idleMinutes,
    };
    sessions.set(id, session);
    await persist(session);
    return session;
  }
  async function downloads(id: string): Promise<PdfDownload[]> {
    if (!sessions.has(id))
      throw new WorkerError("SESSION_NOT_FOUND", "Browser session not found.", 404);
    const folder = join(directory(id), "downloads");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const list: PdfDownload[] = [];
    for (const name of await readdir(folder)) {
      if (!name.endsWith(".json")) continue;
      const item = JSON.parse(await readFile(join(folder, name), "utf8")) as PdfDownload;
      list.push(item);
    }
    return list;
  }
  async function navigate(id: string, url: string) {
    const target = await validatePublicUrl(url, undefined, validateOptions);
    const { page } = active(id);
    try {
      await page.goto(target.url.href, { waitUntil: "domcontentloaded", timeout: 20_000 });
      // Chromium can follow redirects outside Playwright's initial route hook.
      // The proxy blocks those sockets, but its 403 is still an HTTP response:
      // validate the final location so the API does not report it as success.
      await validatePublicUrl(page.url(), undefined, validateOptions);
    } catch (error) {
      if (error instanceof WorkerError && error.code === "BLOCKED_URL") {
        await page.goto("about:blank", { timeout: 5000 });
      }
      // A successful attachment intentionally aborts page navigation.
      if (!(error instanceof Error && /Download is starting/.test(error.message))) {
        throw new WorkerError(
          "NAVIGATION_FAILED",
          "The page could not be loaded. It may be unreachable or contain a blocked destination.",
          502,
        );
      }
    }
    return refresh(id);
  }
  async function closeSession(id: string) {
    const instance = running.get(id);
    const stored = sessions.get(id);
    if (!stored) throw new WorkerError("SESSION_NOT_FOUND", "Browser session not found.", 404);
    if (instance) {
      await instance.context.storageState({ path: join(instance.profileDir, "storage.json") });
      await instance.context.close();
      await Promise.allSettled(instance.pending);
      running.delete(id);
    }
    const result: Session = { ...stored, status: "closed", updatedAt: new Date().toISOString() };
    sessions.set(id, result);
    await persist(result);
    return result;
  }
  function resolveIdleMinutes(sessionClass?: string, idleMinutes?: number): number {
    if (typeof idleMinutes === "number" && Number.isFinite(idleMinutes))
      return Math.min(720, Math.max(5, Math.round(idleMinutes)));
    if (typeof sessionClass === "string" && CLASS_IDLE_MINUTES[sessionClass] !== undefined)
      return CLASS_IDLE_MINUTES[sessionClass];
    return Math.round(idleTimeoutMs / 60_000);
  }

  async function createSession(
    id: string,
    url: string,
    options?: { profileKey?: string; idleMinutes?: number; sessionClass?: string },
  ) {
    await validatePublicUrl(url, undefined, validateOptions);
    if (running.has(id)) return navigate(id, url);
    if (running.size >= maxSessions)
      throw new WorkerError(
        "SESSION_LIMIT",
        `Close an active session before opening another (limit ${maxSessions}).`,
        409,
      );
    if (!sessions.has(id) && sessions.size >= 20)
      throw new WorkerError(
        "PROFILE_LIMIT",
        "The worker has reached its 20 saved-profile limit.",
        409,
      );
    const previous = sessions.get(id);
    const profileKey =
      options?.profileKey !== undefined ? validateProfileKey(options.profileKey) : undefined;
    // One live Chromium per named profile: a second concurrent session on the
    // same profile would fight over the profile lock and fail cryptically.
    if (profileKey) {
      for (const otherId of running.keys()) {
        if (otherId !== id && sessions.get(otherId)?.profileKey === profileKey) {
          throw new WorkerError(
            "PROFILE_IN_USE",
            "This site already has an open browser session. Reuse it or close it first.",
            409,
          );
        }
      }
    }
    const idleMinutes = resolveIdleMinutes(options?.sessionClass, options?.idleMinutes);
    // Named profiles persist per origin (e.g. `apply:https://example.com`) so a
    // later session on the same origin reuses its Chromium profile. Ephemeral
    // sessions keep a profile scoped to the session id.
    const profileDir = profileKey
      ? join(dataDir, "profiles", profileKey)
      : join(directory(id), "profile");
    const tempDirectory = join("/tmp", `openapply-downloads-${id}`);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    // Session metadata (session.json, downloads) always lives under the
    // session id, even when the Chromium profile itself is named per origin.
    await mkdir(directory(id), { recursive: true, mode: 0o700 });
    await mkdir(tempDirectory, { recursive: true, mode: 0o700 });
    let context: BrowserContext;
    try {
      const { chromium } = await import("playwright");
      // CHROMIUM_EXECUTABLE_PATH lets Docker/root environments point at a
      // system Chromium; CHROMIUM_NO_SANDBOX=1 is required when running as root.
      const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
      const noSandbox = process.env.CHROMIUM_NO_SANDBOX === "1";
      context = await chromium.launchPersistentContext(profileDir, {
        // Chromium does not need the worker API credential in its environment.
        env: {
          HOME: process.env.HOME ?? "/tmp",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C.UTF-8",
        },
        executablePath,
        headless: true,
        viewport: { width: 1280, height: 800 },
        proxy: { server: proxy.url, bypass: "<-loopback>" },
        serviceWorkers: "block",
        acceptDownloads: true,
        downloadsPath: tempDirectory,
        timeout: 25_000,
        args: [
          "--disable-quic",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--disable-extensions",
          "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
          ...(noSandbox ? ["--no-sandbox"] : []),
          // Opt-in only for TLS-intercepting sandboxes whose CA Chromium does
          // not trust (e.g. this dev sandbox's egress proxy). Never set in
          // production; the default keeps full certificate validation.
          ...(process.env.CHROMIUM_IGNORE_CERT_ERRORS === "1"
            ? ["--ignore-certificate-errors"]
            : []),
        ],
      });
    } catch {
      if (!previous) await rm(directory(id), { recursive: true, force: true });
      await rm(tempDirectory, { recursive: true, force: true });
      throw new WorkerError(
        "BROWSER_UNAVAILABLE",
        "Chromium could not start. Rebuild the browser-worker image and check its resource limits.",
        503,
      );
    }
    try {
      const statePath = join(profileDir, "storage.json");
      try {
        const state = JSON.parse(await readFile(statePath, "utf8")) as Awaited<
          ReturnType<BrowserContext["storageState"]>
        >;
        await context.addCookies(state.cookies);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await context.route("**/*", async (route) => {
        const requestUrl = route.request().url();
        try {
          await validatePublicUrl(requestUrl, undefined, validateOptions);
        } catch {
          await route.abort("blockedbyclient").catch(() => {});
          return;
        }
        try {
          // Chromium's built-in PDF viewer opens PDFs in-page and fires no
          // download event, so navigations to PDF documents are captured here
          // via route.fetch() and stored as downloads instead.
          if (
            route.request().resourceType() === "document" &&
            /\.pdf([?#]|$)/i.test(requestUrl)
          ) {
            const response = await route.fetch();
            const contentType = response.headers()["content-type"] ?? "";
            const contentLength = Number(response.headers()["content-length"] ?? "0");
            if (/^application\/pdf\b/i.test(contentType) && contentLength <= MAX_DOWNLOAD_BYTES) {
              const body = await response.body().catch(() => null);
              if (body && body.subarray(0, 5).toString("ascii") === "%PDF-") {
                const saved = await downloads(id);
                const name =
                  new URL(requestUrl).pathname.split("/").filter(Boolean).pop() ??
                  "document.pdf";
                inFlightPdfCaptures += 1;
                try {
                  await savePdfBytes({
                    directory: directory(id),
                    name,
                    bytes: body,
                    limitReached: saved.length + inFlightPdfCaptures > 20,
                  });
                } finally {
                  inFlightPdfCaptures -= 1;
                }
                await route
                  .fulfill({
                    status: 200,
                    contentType: "text/html",
                    body: "<html><body><p>This PDF was captured as a download.</p></body></html>",
                  })
                  .catch(() => {});
                return;
              }
            }
          }
        } catch {
          // Fall through to a normal navigation below.
        }
        await route.continue().catch(() => {});
      });
      await context.routeWebSocket("**/*", (socket) => socket.close());
      for (const old of context.pages()) await old.close();
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      // Tracks PDF captures in flight inside the route handler below, so the
      // 20-download limit holds across concurrent navigations.
      let inFlightPdfCaptures = 0;
      const instance: Running = {
        context,
        page,
        touched: Date.now(),
        pending: new Set(),
        profileDir,
      };
      running.set(id, instance);
      context.on("page", (popup) => {
        void popup.close();
      });
      page.on("dialog", (dialog) => {
        void dialog.dismiss();
      });
      page.on("download", (download) => {
        const pending = downloads(id).then((saved) =>
          capturePdfDownload({
            directory: directory(id),
            tempDirectory,
            download,
            limitReached: saved.length + instance.pending.size > 20,
          }),
        );
        instance.pending.add(pending);
        void pending.then(
          () => instance.pending.delete(pending),
          () => {
            instance.downloadError = true;
            instance.pending.delete(pending);
          },
        );
      });
      const initial: Session = {
        id,
        title: previous?.title ?? "New session",
        url,
        status: "active",
        updatedAt: new Date().toISOString(),
        profileKey,
        idleMinutes,
      };
      sessions.set(id, initial);
      await persist(initial);
      return await navigate(id, url);
    } catch (error) {
      await context.close().catch(() => {});
      await Promise.allSettled(running.get(id)?.pending ?? []);
      running.delete(id);
      if (previous) {
        const failed: Session = {
          ...previous,
          url,
          status: "error",
          updatedAt: new Date().toISOString(),
        };
        sessions.set(id, failed);
        await persist(failed);
      } else {
        sessions.delete(id);
        await rm(directory(id), { recursive: true, force: true });
      }
      await rm(tempDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  const sweeper = setInterval(() => {
    for (const [id, instance] of running) {
      const minutes = sessions.get(id)?.idleMinutes ?? Math.round(idleTimeoutMs / 60_000);
      if (Date.now() - instance.touched > minutes * 60_000) {
        void serial(id, () => closeSession(id)).catch(() => {});
      }
    }
  }, 60_000);
  sweeper.unref();
  const FILE_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".txt", ".png", ".jpg", ".jpeg"]);

  async function resolvePackPath(raw: unknown): Promise<string> {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 500)
      throw new WorkerError("INVALID_PATH", "Each pack path must be a non-empty string.", 400);
    const resolved = resolve(packDir, raw);
    if (resolved !== packDir && !resolved.startsWith(`${packDir}${sep}`))
      throw new WorkerError("INVALID_PATH", "Pack paths must stay inside the pack directory.", 400);
    const lower = resolved.toLowerCase();
    if (![...FILE_EXTENSIONS].some((ext) => lower.endsWith(ext)))
      throw new WorkerError(
        "INVALID_PATH",
        "Only document and image pack files may be attached.",
        400,
      );
    try {
      const info = await stat(resolved);
      if (!info.isFile() || info.size === 0 || info.size > 25 * 1024 * 1024)
        throw new WorkerError("INVALID_PATH", "Pack file is missing or unusable.", 400);
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError("INVALID_PATH", "Pack file could not be read.", 400);
    }
    return resolved;
  }

  async function fileChooser(id: string, paths: unknown) {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 5)
      throw new WorkerError("INVALID_PATH", "Provide 1 to 5 pack file paths.", 400);
    const resolved = await Promise.all(paths.map(resolvePackPath));
    const { page } = active(id);
    const fileInput = page.locator('input[type="file"]').first();
    try {
      await fileInput.setInputFiles(resolved, { timeout: 10_000 });
    } catch {
      throw new WorkerError(
        "FILE_INPUT_NOT_FOUND",
        "No file-upload field was found on this page. Attach the pack files manually in the browser.",
        409,
      );
    }
    return refresh(id);
  }

  async function submit(id: string) {
    const { page } = active(id);
    const candidates = [
      page.locator('input[type="submit"]'),
      page.locator('button[type="submit"]'),
      // Per HTML, <button> without a type inside a form defaults to submit.
      page.locator('form button:not([type])'),
      page.getByRole("button", {
        name: /^(submit|submit application|apply now|send application)$/i,
      }),
    ];
    for (const candidate of candidates) {
      const target = candidate.first();
      try {
        if (await target.isVisible({ timeout: 2000 })) {
          await target.click({ timeout: 10_000 });
          return refresh(id);
        }
      } catch {
        /* try the next candidate */
      }
    }
    throw new WorkerError(
      "SUBMIT_NOT_FOUND",
      "No submit control was found on this page. Click submit yourself in the browser.",
      409,
    );
  }

  return {
    list: () => [...sessions.values()],
    create: (
      id: string,
      url: string,
      options?: { profileKey?: string; idleMinutes?: number; sessionClass?: string },
    ) => serial("create", () => serial(id, () => createSession(id, url, options))),
    navigate: (id: string, url: string) => serial(id, () => navigate(id, url)),
    closeSession: (id: string) => serial(id, () => closeSession(id)),
    fileChooser: (id: string, paths: unknown) => serial(id, () => fileChooser(id, paths)),
    submit: (id: string) => serial(id, () => submit(id)),
    screenshot: (id: string) =>
      serial(id, () => active(id).page.screenshot({ type: "png", timeout: 10_000 })),
    read: (id: string) =>
      serial(id, async () => {
        const { page } = active(id);
        await validatePublicUrl(page.url(), undefined, validateOptions);
        // Evaluation is fixed by the worker; callers cannot inject JavaScript.
        const result = await page.evaluate(() => {
          const text = document.body?.innerText ?? "";
          return {
            url: location.href,
            title: document.title.slice(0, 300),
            text: text.slice(0, 100_000),
            truncated: text.length > 100_000,
          };
        });
        await validatePublicUrl(result.url, undefined, validateOptions);
        const session: Session = {
          id,
          url: result.url,
          title: result.title,
          status: "active",
          updatedAt: new Date().toISOString(),
          profileKey: sessions.get(id)?.profileKey,
          idleMinutes: sessions.get(id)?.idleMinutes,
        };
        sessions.set(id, session);
        await persist(session);
        return result;
      }),
    input: (id: string, input: Record<string, unknown>) =>
      serial(id, async () => {
        const { page } = active(id);
        // The API sends `action`; the worker historically reads `type`. Accept both.
        const kind = input.type ?? input.action;
        const { x, y, key, text, deltaY, field, selector, value } = input;
        if (
          kind === "click" &&
          typeof x === "number" &&
          typeof y === "number" &&
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          x >= 0 &&
          x < 1280 &&
          y >= 0 &&
          y < 800
        )
          await page.mouse.click(x, y);
        else if (kind === "text" && typeof text === "string" && text.length <= 10_000)
          await page.keyboard.insertText(text);
        else if (
          kind === "key" &&
          typeof key === "string" &&
          /^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Control\+a|Meta\+a|Shift\+Tab)$/.test(
            key,
          )
        )
          await page.keyboard.press(key);
        else if (
          kind === "scroll" &&
          typeof deltaY === "number" &&
          Number.isFinite(deltaY) &&
          Math.abs(deltaY) <= 5000
        )
          await page.mouse.wheel(0, deltaY);
        else if (
          kind === "fill" &&
          typeof value === "string" &&
          value.length <= 10_000 &&
          ((typeof field === "string" && field.length > 0 && field.length <= 300) ||
            (typeof selector === "string" && selector.length > 0 && selector.length <= 500))
        ) {
          const target =
            typeof field === "string" && field.length > 0
              ? page.getByLabel(field).first()
              : page.locator(selector as string).first();
          await target.fill(value, { timeout: 10_000 });
        } else throw new WorkerError("INVALID_INPUT", "Unsupported browser input or coordinates.");
        return refresh(id);
      }),
    downloads: async (id: string) => {
      const saved = await downloads(id);
      if (running.get(id)?.downloadError)
        throw new WorkerError(
          "DOWNLOAD_STORE_FAILED",
          "A download outcome could not be saved. Check worker storage and try again.",
          500,
        );
      return { downloads: saved, failures: await readDownloadFailures(directory(id)) };
    },
    download: async (id: string, downloadId: string) => {
      validateSessionId(downloadId);
      const metadata = (await downloads(id)).find((item) => item.id === downloadId);
      if (!metadata) throw new WorkerError("DOWNLOAD_NOT_FOUND", "PDF download not found.", 404);
      const path = join(directory(id), "downloads", `${downloadId}.pdf`);
      const info = await stat(path);
      if (info.size > MAX_DOWNLOAD_BYTES)
        throw new WorkerError("DOWNLOAD_TOO_LARGE", "The PDF exceeds 10 MiB.", 413);
      return { metadata, bytes: await readFile(path) };
    },
    close: async () => {
      clearInterval(sweeper);
      await Promise.allSettled([...queues.values()]);
      await Promise.allSettled([...running.keys()].map(closeSession));
      await proxy.close();
    },
  };
}
