import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { ModelGateway } from "../apps/server/src/gateway.ts";
import type { ModelAccount, ModelAccounts, ModelProvider } from "../apps/server/src/models.ts";
import type { StoredPreferences } from "../packages/domain/src/openapply.ts";

let db: Store;
let app: Awaited<ReturnType<typeof createApp>>["app"];
let token: string;
let directory: string;
const owner = "local-user";
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const realFetch = globalThis.fetch;

interface SeenRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
const seen: SeenRequest[] = [];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(text: string, input_tokens: number, output_tokens: number): Response {
  const body = [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens, output_tokens } } })}\n`,
  ].join("\n");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Stubs the vendor OAuth + inference endpoints; the gateway must reach them through one interface. */
/** Failures to inject into the stubbed chat-completions endpoint for the retry test. */
let chatFailures: Array<{ status: number }> = [];

async function stubFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  } catch {
    /* form-encoded token exchange */
  }
  seen.push({ url, headers, body });
  if (url.includes("auth.openai.com/oauth/token"))
    return jsonResponse({
      access_token: "chatgpt-access",
      refresh_token: "chatgpt-refresh",
      expires_in: 3600,
    });
  if (url.includes("auth.x.ai/oauth2/token"))
    return jsonResponse({
      access_token: "grok-access",
      refresh_token: "grok-refresh",
      expires_in: 3600,
    });
  if (url.includes("chatgpt.com/backend-api/codex/responses")) {
    assert.equal(body.stream, true, "chatgpt backend requires stream:true");
    return sseResponse("chatgpt says hi", 7, 8);
  }
  if (url.includes("api.x.ai/v1/responses"))
    return jsonResponse({
      output: [{ type: "message", content: [{ type: "output_text", text: "grok says hi" }] }],
      usage: { input_tokens: 9, output_tokens: 10 },
    });
  if (url.includes("api.openai.com/v1/chat/completions")) {
    const failure = chatFailures.shift();
    if (failure) return new Response("rate limited", { status: failure.status });
    return jsonResponse({
      choices: [{ message: { content: "openai says hi" } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
  }
  if (url.includes("api.anthropic.com/v1/messages"))
    return jsonResponse({
      content: [{ type: "text", text: "anthropic says hi" }],
      usage: { input_tokens: 5, output_tokens: 6 },
    });
  if (url.includes("generativelanguage.googleapis.com/v1beta/openai/chat/completions"))
    return jsonResponse({
      choices: [{ message: { content: "gemini says hi" } }],
      usage: { prompt_tokens: 15, completion_tokens: 16 },
    });
  if (url.includes("generativelanguage.googleapis.com/v1beta/openai/models"))
    return jsonResponse({ data: [{ id: "gemini-2.5-flash" }, { id: "gemini-2.5-pro" }] });
  if (url.includes("/images/generations")) {
    assert.equal(body.response_format, "b64_json");
    return jsonResponse({ data: [{ b64_json: "aGVsbG8td29ybGQ=" }] });
  }
  if (url.endsWith("/v1/models"))
    return jsonResponse({ data: [{ id: "test-model-a" }, { id: "test-model-b" }] });
  // Slice 15: stubbed user-defined custom provider endpoints.
  if (url.includes("nebius.example.com/v1/chat/completions"))
    return jsonResponse({
      choices: [{ message: { content: "nebius says hi" } }],
      usage: { prompt_tokens: 11, completion_tokens: 12 },
    });
  if (url.includes("openrouter.example.com/v1/chat/completions"))
    return jsonResponse({
      choices: [{ message: { content: "openrouter says hi" } }],
      usage: { prompt_tokens: 13, completion_tokens: 14 },
    });
  throw new Error(`unexpected fetch in test: ${url}`);
}

async function putPrefs(body: unknown) {
  const response = await app.request("/api/preferences", {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}
async function connectKey(body: unknown) {
  const response = await app.request("/api/models/connect", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}
async function testTier(tier: "cheap" | "strong") {
  const response = await app.request("/api/models/test", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ tier }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}
async function oauthConnect(provider: "chatgpt" | "grok") {
  const start = await app.request(`/api/models/oauth/${provider}/start`, {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  assert.equal(start.status, 201);
  const { url, state } = (await start.json()) as { url: string; state: string };
  assert.ok(url.includes("auth."), `authorize url looks like OAuth: ${url}`);
  const finish = await app.request(`/api/models/oauth/${provider}/finish`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ code: "test-code", state }),
  });
  return { status: finish.status, json: (await finish.json()) as Record<string, unknown>, state };
}

before(async () => {
  globalThis.fetch = stubFetch as typeof fetch;
  directory = await mkdtemp(join(tmpdir(), "openapply-models-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    encryptionKey: randomBytes(32).toString("base64"),
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  ({ app } = await createApp(db, config));
  const response = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  token = ((await response.json()) as { token: string }).token;
});
after(async () => {
  globalThis.fetch = realFetch;
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("preferences reject a scan interval below 6 hours", async () => {
  const { status } = await putPrefs({ scan_interval_hours: 5 });
  assert.equal(status, 422);
});

test("preferences accept a scan interval of 12 hours", async () => {
  const { status, json } = await putPrefs({ scan_interval_hours: 12 });
  assert.equal(status, 200);
  assert.equal(json.scan_interval_hours, 12);
});

test("gateway routes cheap and strong tiers to different providers", async () => {
  seen.length = 0;
  assert.equal(
    (await connectKey({ provider: "openai", api_key: "test-openai-key-123", model_id: "gpt-5" }))
      .status,
    201,
  );
  assert.equal(
    (
      await connectKey({
        provider: "anthropic",
        api_key: "test-anthropic-key-123",
        model_id: "claude-sonnet-4-5",
      })
    ).status,
    201,
  );
  await putPrefs({
    cheap_provider: "openai",
    cheap_model: "gpt-5",
    strong_provider: "anthropic",
    strong_model: "claude-sonnet-4-5",
  });

  const cheap = await testTier("cheap");
  assert.equal(cheap.status, 200);
  assert.equal(cheap.json.ok, true);
  assert.equal(cheap.json.text, "openai says hi");
  const cheapCall = seen.at(-1);
  assert.ok(cheapCall?.url.includes("api.openai.com/v1/chat/completions"));
  assert.equal(cheapCall?.body.model, "gpt-5");
  assert.equal(cheapCall?.headers.Authorization, "Bearer test-openai-key-123");

  const strong = await testTier("strong");
  assert.equal(strong.status, 200);
  assert.equal(strong.json.text, "anthropic says hi");
  const strongCall = seen.at(-1);
  assert.ok(strongCall?.url.includes("api.anthropic.com/v1/messages"));
  assert.equal(strongCall?.headers["x-api-key"], "test-anthropic-key-123");
  assert.equal(strongCall?.body.model, "claude-sonnet-4-5");
});

test("google provider connects and routes through its OpenAI-compatible endpoint", async () => {
  seen.length = 0;
  const googleKey = ["test", "google", "key", "123456"].join("-");
  assert.equal(
    (
      await connectKey({
        provider: "google",
        api_key: googleKey,
        model_id: "gemini-2.5-flash",
      })
    ).status,
    201,
  );
  await putPrefs({
    cheap_provider: "google",
    cheap_model: "gemini-2.5-flash",
    strong_provider: "openai",
    strong_model: "gpt-5",
  });
  const cheap = await testTier("cheap");
  assert.equal(cheap.status, 200);
  assert.equal(cheap.json.text, "gemini says hi");
  const call = seen.at(-1);
  assert.ok(call?.url.includes("generativelanguage.googleapis.com/v1beta/openai/chat/completions"));
  assert.equal(call?.body.model, "gemini-2.5-flash");
  assert.equal(call?.headers.Authorization, `Bearer ${googleKey}`);
});

test("image generation returns bytes through the provider's images endpoint", async () => {
  seen.length = 0;
  const openaiKey = ["test", "openai", "key", "123"].join("-");
  assert.equal(
    (
      await connectKey({
        provider: "openai",
        api_key: openaiKey,
        model_id: "gpt-5",
      })
    ).status,
    201,
  );
  const response = await app.request("/api/models/image", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ provider: "openai", prompt: "a capybara filing paperwork" }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { b64_json: string; mime: string };
  assert.equal(body.b64_json, "aGVsbG8td29ybGQ=");
  assert.equal(body.mime, "image/png");
  const call = seen.at(-1);
  assert.ok(call?.url.includes("api.openai.com/v1/images/generations"));
  assert.equal(call?.body.model, "gpt-image-1");
  assert.equal(call?.headers.Authorization, `Bearer ${openaiKey}`);
});

test("image generation validates its inputs", async () => {
  const post = (payload: unknown) =>
    app.request("/api/models/image", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
    });
  // Unknown provider.
  assert.equal((await post({ provider: "anthropic", prompt: "x" })).status, 422);
  // Empty prompt.
  assert.equal((await post({ provider: "openai", prompt: "  " })).status, 422);
  // Bad size.
  assert.equal((await post({ provider: "openai", prompt: "x", size: "1x1" })).status, 422);
});

test("chatgpt, grok, and api key reach the same gateway interface", async () => {
  assert.equal((await oauthConnect("chatgpt")).status, 201);
  assert.equal((await oauthConnect("grok")).status, 201);

  const cases = [
    {
      provider: "openai",
      model_id: "gpt-5",
      text: "openai says hi",
      usage: { input_tokens: 3, output_tokens: 4 },
    },
    {
      provider: "chatgpt",
      model_id: "gpt-5",
      text: "chatgpt says hi",
      usage: { input_tokens: 7, output_tokens: 8 },
    },
    {
      provider: "grok",
      model_id: "grok-4",
      text: "grok says hi",
      usage: { input_tokens: 9, output_tokens: 10 },
    },
  ] as const;
  for (const expected of cases) {
    await putPrefs({ cheap_provider: expected.provider, cheap_model: expected.model_id });
    const result = await testTier("cheap");
    assert.equal(result.status, 200);
    assert.deepEqual(
      {
        ok: result.json.ok,
        text: result.json.text,
        model_id: result.json.model_id,
        usage: result.json.usage,
      },
      { ok: true, text: expected.text, model_id: expected.model_id, usage: expected.usage },
    );
  }
});

test("budget governor stops strong calls over the per-cycle limit", async () => {
  await db.remove(owner, "gateway_usage", "default");
  await putPrefs({
    max_strong_model_packs_per_cycle: 1,
    scan_interval_hours: 24,
    strong_provider: "openai",
    strong_model: "gpt-5",
  });
  const first = await testTier("strong");
  assert.equal(first.status, 200);
  const second = await testTier("strong");
  assert.equal(second.json.ok, false);
  assert.equal(second.json.error_class, "BUDGET_EXCEEDED");
});

test("budget governor stops cheap calls over the per-cycle limit", async () => {
  await db.remove(owner, "gateway_usage", "default");
  await putPrefs({
    max_cheap_model_calls_per_cycle: 1,
    scan_interval_hours: 24,
    cheap_provider: "openai",
    cheap_model: "gpt-5-mini",
  });
  const first = await testTier("cheap");
  assert.equal(first.status, 200);
  const second = await testTier("cheap");
  assert.equal(second.json.ok, false);
  assert.equal(second.json.error_class, "BUDGET_EXCEEDED");
  assert.match(String(second.json.message ?? ""), /Cheap-model budget reached/);
});

test("cheap and strong budgets are tracked independently", async () => {
  await db.remove(owner, "gateway_usage", "default");
  await putPrefs({
    max_cheap_model_calls_per_cycle: 1,
    max_strong_model_packs_per_cycle: 5,
    scan_interval_hours: 24,
    cheap_provider: "openai",
    cheap_model: "gpt-5-mini",
    strong_provider: "openai",
    strong_model: "gpt-5",
  });
  assert.equal((await testTier("cheap")).status, 200);
  // Cheap budget exhausted, but strong still has room.
  const cheapAgain = await testTier("cheap");
  assert.equal(cheapAgain.json.error_class, "BUDGET_EXCEEDED");
  assert.equal((await testTier("strong")).status, 200);
});

test("model secrets never leave the vault", async () => {
  const response = await app.request("/api/models", { headers: headers() });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!body.includes("test-openai-key-123"), "api key must not appear in the account list");
  assert.ok(!body.includes("chatgpt-access"), "oauth token must not appear in the account list");
  const stored = await db.get<{ id: string; secret: string }>(owner, "credentials", "model:openai");
  assert.ok(stored, "account is stored");
  assert.ok(!stored.secret.includes("test-openai-key-123"), "stored secret must be encrypted");
});

test("oauth state is single-use", async () => {
  const start = await app.request("/api/models/oauth/grok/start", {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  const { state } = (await start.json()) as { state: string };
  const finish = (code: string) =>
    app.request("/api/models/oauth/grok/finish", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ code, state }),
    });
  assert.equal((await finish("first")).status, 201);
  assert.equal((await finish("second")).status, 409);
});

async function discover(body: unknown) {
  const response = await app.request("/api/models/discover", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

test("discover lists models for an OpenAI-style endpoint", async () => {
  const { status, json } = await discover({ provider: "openai", api_key: "test-openai-key-123" });
  assert.equal(status, 200);
  assert.deepEqual(json.models, ["test-model-a", "test-model-b"]);
});

test("discover works for a custom base URL", async () => {
  const { status, json } = await discover({
    provider: "custom",
    api_key: "test-custom-key-123",
    base_url: "https://models.example.com",
  });
  assert.equal(status, 200);
  assert.deepEqual(json.models, ["test-model-a", "test-model-b"]);
  assert.ok(
    seen.some((r) => r.url === "https://models.example.com/v1/models"),
    "custom base URL is used for discovery",
  );
});

test("discover does not persist the key", async () => {
  await discover({ provider: "xai", api_key: "test-xai-key-123" });
  const response = await app.request("/api/models", { headers: headers() });
  const { accounts } = (await response.json()) as { accounts: Array<{ provider: string }> };
  assert.ok(!accounts.some((a) => a.provider === "xai"), "discovery must not create an account");
});

test("custom provider connects with a name and base URL", async () => {
  const { status, json } = await connectKey({
    provider: "custom",
    api_key: "test-custom-key-123",
    label: "My Lab",
    base_url: "https://models.example.com",
    model_id: "test-model-a",
  });
  assert.equal(status, 201);
  const account = json.account as Record<string, unknown>;
  assert.equal(account.provider, "custom");
  assert.equal(account.label, "My Lab");
  assert.equal(account.base_url, "https://models.example.com");
});

test("custom provider requires a name and base URL", async () => {
  const missing = await connectKey({ provider: "custom", api_key: "test-custom-key-123" });
  assert.equal(missing.status, 422);
});

test("gateway retries transient 429/503 then succeeds", async () => {
  assert.equal(
    (await connectKey({ provider: "openai", api_key: "retry-test-key", model_id: "gpt-5" })).status,
    201,
  );
  await putPrefs({ cheap_provider: "openai", cheap_model: "gpt-5" });
  // Two transient failures, then success: the gateway must ride them out.
  chatFailures = [{ status: 429 }, { status: 503 }];
  const ok = await testTier("cheap");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(chatFailures.length, 0, "all injected failures were consumed by retries");
});

test("gateway gives up after three transient failures", async () => {
  await putPrefs({ cheap_provider: "openai", cheap_model: "gpt-5" });
  chatFailures = [{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }];
  const failed = await testTier("cheap");
  assert.equal(failed.status, 429);
  // Three attempts consumed, the fourth failure was never reached.
  assert.equal(chatFailures.length, 1);
  chatFailures = [];
});

// --- Slice 14: Nebius/Nemotron integration (direct gateway unit tests) ---

interface CapturedChatCall {
  url: string;
  body: Record<string, unknown>;
}

/** Stub chat-completions endpoint returning one message; captures requests. */
function stubChatFetch(message: { content?: string; reasoning_content?: string }): {
  calls: CapturedChatCall[];
  fetchImpl: typeof fetch;
} {
  const calls: CapturedChatCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });
    return new Response(
      JSON.stringify({
        choices: [{ message }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function slice14Prefs(extra: Partial<StoredPreferences> = {}): StoredPreferences {
  return {
    scan_interval_hours: 12,
    max_strong_model_packs_per_cycle: 5,
    max_cheap_model_calls_per_cycle: 200,
    cheap_provider: "openai",
    cheap_model: "gpt-5",
    strong_provider: "openai",
    strong_model: "gpt-5",
    ...extra,
  } as StoredPreferences;
}

function slice14Gateway(prefs: StoredPreferences, fetchImpl: typeof fetch): ModelGateway {
  const db = {
    get: async () => null,
    put: async (_owner: string, _kind: string, value: { id: string }) => value,
  } as unknown as Store;
  const accounts = {
    bearerToken: async (_owner: string, provider: ModelProvider) => ({
      token: "test-token-never-sent",
      account: {
        provider,
        label: "test",
        model_id: "account-default-model",
        base_url:
          provider === "openai-compatible"
            ? "https://nebius.example.com/v1"
            : "https://api.openai.com/v1",
        auth: { type: "api_key", api_key: "test-key-never-sent" },
        connected_at: new Date().toISOString(),
      } satisfies ModelAccount,
    }),
  } as unknown as ModelAccounts;
  return new ModelGateway(db, accounts, async () => prefs, fetchImpl);
}

test("reasoning_content is used when chat-completions content is empty", async () => {
  const { fetchImpl } = stubChatFetch({ content: "", reasoning_content: '{"a": 1}' });
  const gateway = slice14Gateway(slice14Prefs(), fetchImpl);
  const result = await gateway.complete("owner", {
    purpose: "test",
    messages: [{ role: "user", content: "hi" }],
    tier: "strong",
  });
  assert.equal(result.text, '{"a": 1}');
});

test("a reasoning_content fallback is loud: structured log plus a usage counter, never silent", async () => {
  // A realistic reasoning trace: deliberation, discarded phrasings, self-talk
  // about the candidate. If this ever shipped as a final answer silently,
  // a hiring manager would read the model's internal monologue.
  const trace = [
    "Let me think about this candidate's resume.",
    "The real weakness is the employment gap in 2023 — I should not highlight that.",
    "I should probably mention the Python experience here, even though it is thin.",
    'Final answer attempt: {"verdict": "ok"}',
  ].join("\n");
  const { fetchImpl } = stubChatFetch({ content: "", reasoning_content: trace });
  const stored = new Map<string, { id: string; calls: number; reasoning_fallbacks?: number }>();
  const db = {
    get: async (_o: string, _k: string, id: string) => stored.get(id) ?? null,
    put: async (_o: string, _k: string, value: { id: string; calls: number }) => {
      stored.set(value.id, value as { id: string; calls: number });
      return value;
    },
  } as unknown as Store;
  const accounts = {
    bearerToken: async () => ({
      token: "test-token-never-sent",
      account: {
        provider: "openai",
        label: "test",
        model_id: "account-default-model",
        base_url: "https://api.openai.com/v1",
        auth: { type: "api_key", api_key: "test-key-never-sent" },
        connected_at: new Date().toISOString(),
      } satisfies ModelAccount,
    }),
  } as unknown as ModelAccounts;
  const gateway = new ModelGateway(db, accounts, async () => slice14Prefs(), fetchImpl);

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    const result = await gateway.complete("owner", {
      purpose: "document:hr_authenticity_reviewer",
      instructions_ref: "hr.review.v2",
      messages: [{ role: "user", content: "hi" }],
      tier: "strong",
    });
    assert.equal(result.text, trace);
  } finally {
    console.warn = origWarn;
  }

  // Loud: exactly one structured warning naming the role and model.
  assert.equal(warnings.length, 1);
  const logged = JSON.parse(warnings[0]) as Record<string, unknown>;
  assert.equal(logged.event, "reasoning_content_fallback");
  assert.equal(logged.instructions_ref, "hr.review.v2");
  assert.equal(logged.provider, "openai");
  assert.ok(typeof logged.model_id === "string");

  // Counted: the provider usage record carries the fallback fire.
  const usage = [...stored.values()].find((v) => (v.reasoning_fallbacks ?? 0) > 0);
  assert.equal(usage?.reasoning_fallbacks, 1);
});

test("chat-completions content wins when present alongside reasoning_content", async () => {
  const { fetchImpl } = stubChatFetch({
    content: "primary answer",
    reasoning_content: "thinking trace",
  });
  const gateway = slice14Gateway(slice14Prefs(), fetchImpl);
  const result = await gateway.complete("owner", {
    purpose: "test",
    messages: [{ role: "user", content: "hi" }],
    tier: "strong",
  });
  assert.equal(result.text, "primary answer");
});

test("with no role override the gateway keeps tier-based routing", async () => {
  const { calls, fetchImpl } = stubChatFetch({ content: "ok" });
  const gateway = slice14Gateway(slice14Prefs(), fetchImpl);
  await gateway.complete("owner", {
    purpose: "document:hr_authenticity_reviewer",
    instructions_ref: "hr.review.v2",
    messages: [{ role: "user", content: "hi" }],
    tier: "strong",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[0].body.model, "gpt-5");
});

test("a role_models override routes that instructions_ref to the override provider and model", async () => {
  const { calls, fetchImpl } = stubChatFetch({ content: "ok" });
  const gateway = slice14Gateway(
    slice14Prefs({
      role_models: {
        "hr.review.v2": {
          provider: "openai-compatible",
          model: "nvidia/nemotron-3-nano-30b-a3b",
        },
      },
    }),
    fetchImpl,
  );
  const result = await gateway.complete("owner", {
    purpose: "document:hr_authenticity_reviewer",
    instructions_ref: "hr.review.v2",
    messages: [{ role: "user", content: "hi" }],
    tier: "strong",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://nebius.example.com/v1/chat/completions");
  assert.equal(calls[0].body.model, "nvidia/nemotron-3-nano-30b-a3b");
  assert.equal(result.model_id, "nvidia/nemotron-3-nano-30b-a3b");
});

test("a role_models override for one role does not change routing for another role", async () => {
  const { calls, fetchImpl } = stubChatFetch({ content: "ok" });
  const gateway = slice14Gateway(
    slice14Prefs({
      role_models: {
        // Override targets a different role than the one called below.
        "resume.ats_optimize.v2": {
          provider: "openai-compatible",
          model: "nvidia/nemotron-3-nano-30b-a3b",
        },
      },
    }),
    fetchImpl,
  );
  await gateway.complete("owner", {
    purpose: "document:hr_authenticity_reviewer",
    instructions_ref: "hr.review.v2",
    messages: [{ role: "user", content: "hi" }],
    tier: "strong",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[0].body.model, "gpt-5");
});

// --- Slice 15: user-defined custom providers ---

async function connectCustom(body: unknown) {
  const response = await app.request("/api/models/custom/connect", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}
async function customTest(body: unknown) {
  const response = await app.request("/api/models/custom/test", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}
async function disconnectProvider(provider: string) {
  const response = await app.request("/api/models/disconnect", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ provider }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}
async function listCustomProviders() {
  const response = await app.request("/api/models", { headers: headers() });
  assert.equal(response.status, 200);
  const json = (await response.json()) as {
    custom_providers: Array<Record<string, unknown>>;
  };
  return json.custom_providers;
}

test("two custom providers connect, each with its own encrypted vault credential", async () => {
  const nebius = await connectCustom({
    label: "Nebius Token Factory",
    base_url: "https://nebius.example.com/v1",
    api_key: "test-nebius-key-123",
    model_id: "nvidia/nemotron-3-nano-30b-a3b",
  });
  assert.equal(nebius.status, 201);
  const openrouter = await connectCustom({
    label: "OpenRouter",
    base_url: "https://openrouter.example.com/v1",
    api_key: "test-openrouter-key-123",
    model_id: "openai/gpt-5-mini",
  });
  assert.equal(openrouter.status, 201);
  const nebiusProvider = nebius.json.provider as Record<string, unknown>;
  const openrouterProvider = openrouter.json.provider as Record<string, unknown>;
  assert.ok(nebiusProvider.id !== openrouterProvider.id, "ids are distinct");
  assert.match(String(nebiusProvider.id), /^custom_/);
  assert.ok(!("api_key" in nebiusProvider), "the key never leaves the server");

  const listed = await listCustomProviders();
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((p) => p.label).sort(), ["Nebius Token Factory", "OpenRouter"]);

  // No secret material leaks through the list endpoint.
  const listBody = JSON.stringify(listed);
  assert.ok(!listBody.includes("test-nebius-key-123"));
  assert.ok(!listBody.includes("test-openrouter-key-123"));

  // Each provider has its own encrypted vault credential.
  for (const [provider, key] of [
    [nebiusProvider, "test-nebius-key-123"],
    [openrouterProvider, "test-openrouter-key-123"],
  ] as const) {
    const stored = await db.get<{ id: string; secret: string }>(
      owner,
      "credentials",
      `model:custom:${provider.id}`,
    );
    assert.ok(stored, `vault credential exists for ${provider.label}`);
    assert.ok(!stored.secret.includes(key), "stored credential is encrypted");
  }
});

test("custom providers require https", async () => {
  const connect = await connectCustom({
    label: "Plain HTTP",
    base_url: "http://insecure.example.com/v1",
    api_key: "test-insecure-key-123",
    model_id: "some-model",
  });
  assert.equal(connect.status, 422);
  const probe = await customTest({
    base_url: "http://insecure.example.com/v1",
    api_key: "test-insecure-key-123",
  });
  assert.equal(probe.status, 422);
});

test("custom test endpoint lists models without persisting anything", async () => {
  const before = await listCustomProviders();
  const { status, json } = await customTest({
    base_url: "https://nebius.example.com/v1",
    api_key: "test-nebius-key-123",
  });
  assert.equal(status, 200);
  assert.deepEqual(json.models, ["test-model-a", "test-model-b"]);
  assert.ok(
    seen.some((r) => r.url === "https://nebius.example.com/v1/models"),
    "the custom base URL is used for discovery",
  );
  const after = await listCustomProviders();
  assert.equal(after.length, before.length, "testing must not create a provider");
});

test("cheap tier routes to a custom provider with its URL and key", async () => {
  await db.remove(owner, "gateway_usage", "default");
  const listed = await listCustomProviders();
  const nebius = listed.find((p) => p.label === "Nebius Token Factory");
  assert.ok(nebius);
  await putPrefs({
    max_cheap_model_calls_per_cycle: 50,
    max_strong_model_packs_per_cycle: 50,
    cheap_provider: nebius.id,
    cheap_model: "nvidia/nemotron-3-nano-30b-a3b",
  });
  seen.length = 0;
  const result = await testTier("cheap");
  assert.equal(result.status, 200);
  assert.equal(result.json.text, "nebius says hi");
  const call = seen.at(-1);
  assert.ok(call?.url.includes("nebius.example.com/v1/chat/completions"));
  assert.equal(call?.headers.Authorization, "Bearer test-nebius-key-123");
  assert.equal(call?.body.model, "nvidia/nemotron-3-nano-30b-a3b");
});

test("unknown provider ids in preferences fail with 400, not a silent misroute", async () => {
  assert.equal((await putPrefs({ cheap_provider: "no-such-provider" })).status, 400);
  assert.equal((await putPrefs({ cheap_provider: "custom_ghost_ab12" })).status, 400);
  assert.equal(
    (
      await putPrefs({
        role_models: { "hr.review.v2": { provider: "custom_ghost_ab12", model: "m" } },
      })
    ).status,
    400,
  );
});

test("custom_providers cannot be smuggled in through PUT /api/preferences", async () => {
  const before = await listCustomProviders();
  const { status } = await putPrefs({
    custom_providers: [
      {
        id: "custom_smuggled_ab12",
        label: "Smuggled",
        base_url: "https://evil.example.com/v1",
        model_id: "evil-model",
        created_at: new Date().toISOString(),
      },
    ],
  });
  assert.equal(status, 200, "unknown keys are ignored, not honored");
  const after = await listCustomProviders();
  assert.deepEqual(
    after.map((p) => p.id).sort(),
    before.map((p) => String(p.id)).sort(),
    "no provider record without a vault credential",
  );
});

test("deleting a referenced custom provider is blocked; unreferenced deletion succeeds", async () => {
  const listed = await listCustomProviders();
  const nebius = listed.find((p) => p.label === "Nebius Token Factory");
  const openrouter = listed.find((p) => p.label === "OpenRouter");
  assert.ok(nebius && openrouter);

  // Nebius still backs the cheap tier: 409 with the reference named.
  await putPrefs({ cheap_provider: nebius.id, cheap_model: "nvidia/nemotron-3-nano-30b-a3b" });
  const blocked = await disconnectProvider(String(nebius.id));
  assert.equal(blocked.status, 409);
  assert.match(String(blocked.json.error), /cheap tier/);

  // OpenRouter is unreferenced: deletion succeeds and removes the credential.
  const deleted = await disconnectProvider(String(openrouter.id));
  assert.equal(deleted.status, 200);
  const remaining = await listCustomProviders();
  assert.ok(!remaining.some((p) => p.id === openrouter.id));
  assert.equal(
    await db.get(owner, "credentials", `model:custom:${openrouter.id}`),
    null,
    "vault credential is removed with the provider",
  );

  // Point the tier elsewhere, then Nebius deletes cleanly too.
  await putPrefs({ cheap_provider: "openai", cheap_model: "gpt-5-mini" });
  assert.equal((await disconnectProvider(String(nebius.id))).status, 200);
  assert.equal((await listCustomProviders()).length, 0);
});

test("disconnecting an unknown custom provider id is 404", async () => {
  const { status } = await disconnectProvider("custom_ghost_ab12");
  assert.equal(status, 404);
});

test("a role_models override to a custom provider routes that role to its endpoint", async () => {
  const connected = await connectCustom({
    label: "Nebius Role Test",
    base_url: "https://nebius.example.com/v1",
    api_key: "test-nebius-role-key-123",
    model_id: "nvidia/nemotron-3-nano-30b-a3b",
  });
  assert.equal(connected.status, 201);
  const customId = String((connected.json.provider as Record<string, unknown>).id);

  const captured: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(input instanceof Request ? input.url : input),
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const store = {
    get: async () => null,
    put: async (_o: string, _k: string, value: { id: string }) => value,
  } as unknown as Store;
  const accounts = {
    customBearerToken: async (_o: string, id: string) => ({
      token: "test-nebius-role-key-123",
      account: {
        provider: "custom",
        custom_id: id,
        label: "Nebius Role Test",
        base_url: "https://nebius.example.com/v1",
        model_id: "nvidia/nemotron-3-nano-30b-a3b",
        auth: { type: "api_key", api_key: "test-nebius-role-key-123" },
        connected_at: new Date().toISOString(),
      },
    }),
  } as unknown as ModelAccounts;
  const prefs = slice14Prefs({
    role_models: {
      "hr.review.v2": {
        provider: customId,
        model: "nvidia/nemotron-3-nano-30b-a3b",
      },
    },
  });
  const gateway = new ModelGateway(store, accounts, async () => prefs, fetchImpl);
  await gateway.complete("owner", {
    purpose: "document:hr_authenticity_reviewer",
    instructions_ref: "hr.review.v2",
    messages: [{ role: "user", content: "hi" }],
    tier: "strong",
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "https://nebius.example.com/v1/chat/completions");
  assert.equal(captured[0].headers.Authorization, "Bearer test-nebius-role-key-123");
  assert.equal(captured[0].body.model, "nvidia/nemotron-3-nano-30b-a3b");

  // Cleanup: the provider record was only needed for this routing test.
  await putPrefs({ role_models: {} });
  assert.equal((await disconnectProvider(customId)).status, 200);
});

// --- Slice 15: chat panel provider resolution (per-session, never a tier change) ---

import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import type { AgentService } from "../apps/server/src/engine/service.ts";

const CHAT_OVERRIDE = "openapply.chat_provider_override";
const chatCustomId = "custom_chatprov_ab12";
const chatCustomRecord = {
  id: chatCustomId,
  label: "Chat Test Provider",
  base_url: "https://chat.example.com/v1",
  model_id: "chat-model-1",
  created_at: new Date().toISOString(),
};

function chatTestAgent(overrides: {
  customBearer?: { token: string } | null;
  prefs?: Record<string, unknown>;
}) {
  const prefs = {
    scan_interval_hours: 12,
    cheap_provider: "openai",
    cheap_model: "gpt-5-mini",
    strong_provider: "openai",
    strong_model: "gpt-5",
    role_models: {},
    custom_providers: [chatCustomRecord],
    ...(overrides.prefs ?? {}),
  };
  const deps = {
    modelAccounts: {
      customBearerToken: async (_o: string, id: string) =>
        id === chatCustomId && overrides.customBearer !== null
          ? {
              token: overrides.customBearer?.token ?? "test-chat-custom-key",
              account: { provider: "custom", custom_id: id, ...chatCustomRecord },
            }
          : null,
      bearerToken: async (_o: string, provider: string) =>
        provider === "openai"
          ? {
              token: "test-chat-openai-key",
              account: {
                provider: "openai",
                label: "OpenAI",
                model_id: "gpt-5",
                auth: { type: "api_key", api_key: "test-chat-openai-key" },
                connected_at: new Date().toISOString(),
              },
            }
          : null,
    },
    getPreferences: async (_o: string) => prefs,
  };
  const agent = new ConversationAgent(
    { agentBackend: "sample", model: "openai/env-default" } as Config,
    {} as AgentService,
    owner,
    deps as never,
  );
  const resolve = (context?: unknown) =>
    (
      agent as unknown as {
        resolveChatModel(input: { context?: unknown }): Promise<{
          spec: string;
          auth?: { apiKey: string; baseURL?: string };
        }>;
      }
    ).resolveChatModel({ context });
  return { resolve, prefs };
}

function chatContext(provider: string, model?: string) {
  return [{ description: CHAT_OVERRIDE, value: { provider, model } }];
}

test("chat with no provider selection keeps the historical default model", async () => {
  const { resolve } = chatTestAgent({});
  const result = await resolve(undefined);
  assert.equal(result.spec, "openai/env-default");
  assert.equal(result.auth, undefined);
});

test("chat selection routes to the custom provider with its vault key and base URL", async () => {
  const { resolve, prefs } = chatTestAgent({});
  const result = await resolve(chatContext(chatCustomId, "chat-model-1"));
  assert.equal(result.spec, "openai/chat-model-1");
  assert.equal(result.auth?.apiKey, "test-chat-custom-key");
  assert.equal(result.auth?.baseURL, "https://chat.example.com/v1");
  // The selection never rewrites tier settings.
  assert.equal(prefs.cheap_provider, "openai");
  assert.equal(prefs.cheap_model, "gpt-5-mini");
});

test("chat selection falls back to the provider's model when no model is sent", async () => {
  const { resolve } = chatTestAgent({});
  const result = await resolve(chatContext(chatCustomId));
  assert.equal(result.spec, "openai/chat-model-1");
});

test("chat selection of an unknown provider fails the run", async () => {
  const { resolve } = chatTestAgent({});
  await assert.rejects(() => resolve(chatContext("custom_ghost_ab12")), /Unknown chat provider/);
});

test("chat selection of a disconnected custom provider fails the run", async () => {
  const { resolve } = chatTestAgent({ customBearer: null });
  await assert.rejects(() => resolve(chatContext(chatCustomId)), /not connected/);
});

test("chat selection of an account sign-in provider is rejected", async () => {
  const { resolve } = chatTestAgent({});
  await assert.rejects(() => resolve(chatContext("chatgpt")), /cannot drive the chat panel/);
});

test("chat selection of a built-in API-key provider resolves its vault key", async () => {
  const { resolve } = chatTestAgent({});
  const result = await resolve(chatContext("openai", "gpt-5"));
  assert.equal(result.spec, "openai/gpt-5");
  assert.equal(result.auth?.apiKey, "test-chat-openai-key");
});
