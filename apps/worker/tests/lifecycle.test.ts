import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createBrowserManager } from "../src/browser.ts";
import { parseUpstreamProxy, startEgressProxy } from "../src/proxy.ts";

// Sandbox helpers: the live tests need the same browser plumbing as the worker.
function managerOptions(dataDir: string) {
  return { dataDir, upstreamProxy: process.env.WORKER_UPSTREAM_PROXY };
}
/**
 * Direct Chromium launch for the profile-persistence probe. Routes through a
 * standalone copy of the worker's own egress proxy (127.0.0.1) so this
 * sandbox's filtered DNS never touches Chromium's resolver.
 */
async function withDirectBrowser<T>(
  profileDir: string,
  fn: (ctx: Awaited<ReturnType<typeof chromium.launchPersistentContext>>) => Promise<T>,
): Promise<T> {
  const proxy = await startEgressProxy(parseUpstreamProxy(process.env.WORKER_UPSTREAM_PROXY));
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
      : {}),
    proxy: { server: proxy.url },
    args: [
      ...(process.env.CHROMIUM_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
      ...(process.env.CHROMIUM_IGNORE_CERT_ERRORS === "1" ? ["--ignore-certificate-errors"] : []),
    ],
  });
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
    await proxy.close();
  }
}

test("real Chromium cleans failed profiles and restores a saved UUID after worker restart", {
  timeout: 120_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openapply-browser-lifecycle-"));
  let browser = await createBrowserManager(managerOptions(dataDir));
  const id = randomUUID();
  const failedId = randomUUID();
  try {
    await assert.rejects(
      browser.create(
        failedId,
        "https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%3A8790%2Fhealth",
      ),
      { code: "NAVIGATION_FAILED" },
    );
    assert.equal(browser.list().length, 0, "failed creation must release its saved-profile slot");
    assert.equal(
      (await readdir(dataDir)).includes(failedId),
      false,
      "unclaimed profile is removed",
    );
    await browser.create(id, "https://example.com/");
    await browser.closeSession(id);
    await withDirectBrowser(join(dataDir, id, "profile"), async (context) => {
      const page = await context.newPage();
      await page.goto("https://example.com/");
      await page.evaluate(() => localStorage.setItem("openapply-profile-test", "retained"));
    });
    await browser.close();
    browser = await createBrowserManager(managerOptions(dataDir));
    assert.equal(browser.list()[0]?.status, "closed");
    const reopened = await browser.create(id, "https://example.com/");
    assert.equal(reopened.id, id);
    assert.equal(reopened.title, "Example Domain");
    const read = await browser.read(id);
    assert.match(read.text, /Example Domain/);
    await browser.navigate(id, "https://www.rfc-editor.org/rfc/rfc9110.txt");
    const largeRead = await browser.read(id);
    assert.equal(largeRead.text.length, 100_000);
    assert.equal(largeRead.truncated, true);
    assert.equal(largeRead.url, "https://www.rfc-editor.org/rfc/rfc9110.txt");
    await browser.closeSession(id);
    const state = JSON.parse(await readFile(join(dataDir, id, "profile", "storage.json"), "utf8"));
    assert(
      state.origins
        .find((origin: { origin: string }) => origin.origin === "https://example.com")
        ?.localStorage.some(
          (item: { name: string; value: string }) =>
            item.name === "openapply-profile-test" && item.value === "retained",
        ),
    );
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
