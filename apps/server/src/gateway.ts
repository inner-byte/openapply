import type { StoredPreferences } from "../../../packages/domain/src/openapply.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import type { ModelAccount, ModelAccounts, ModelProvider } from "./models.ts";
import { defaultBaseUrls, modelProviders } from "./models.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Model gateway, per docs/MODELS.md.
 *
 * One interface for every connect:
 *   complete({purpose, system, messages, json_schema?, tier}) -> {text, json?, usage, model_id}
 *
 * Transports are hand-rolled fetch calls, not vendor SDKs: the official SDKs are
 * thin wrappers over these same REST endpoints, and no official SDK speaks the
 * ChatGPT-subscription or Grok-subscription backends, so a shared HTTP core keeps
 * every connect behind one interface.
 *
 * Protocols:
 * - OpenAI Chat Completions: API-key OpenAI, xAI, and OpenAI-compatible endpoints
 * - Anthropic Messages: API-key Anthropic
 * - OpenAI Responses API: ChatGPT OAuth (chatgpt.com/backend-api/codex) and
 *   Grok OAuth (api.x.ai/v1/responses)
 *
 * Failures map to the MODELS.md error classes: PROVIDER_ERROR, SCHEMA_INVALID
 * (invalid JSON retries once), BUDGET_EXCEEDED (per-tier per-cycle governor).
 */

export type GatewayTier = "cheap" | "strong";
export type GatewayErrorClass =
  | "PROVIDER_ERROR"
  | "SCHEMA_INVALID"
  | "BUDGET_EXCEEDED"
  | "VISION_UNSUPPORTED"
  | "NOT_CONFIGURED";

export class GatewayError extends AppError {
  constructor(
    public readonly errorClass: GatewayErrorClass,
    message: string,
    status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503 = 502,
  ) {
    super(message, status);
    this.name = "GatewayError";
  }
}

export interface ContentImage {
  mime: string;
  base64: string;
}

export interface CompleteMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** Attached images. Only sent to providers that accept vision input. */
  images?: ContentImage[];
}
export interface CompleteInput {
  purpose: string;
  system?: string;
  messages: CompleteMessage[];
  json_schema?: { name: string; schema: Record<string, unknown> };
  tier: GatewayTier;
  /**
   * Slice 14: the versioned prompt ref that originated this call (set by the
   * document runner). The gateway uses it to honor a per-role model override
   * from preferences (`role_models`); every other caller omits it and keeps
   * plain tier routing.
   */
  instructions_ref?: string;
}
export interface CompleteResult {
  text: string;
  json?: unknown;
  usage: { input_tokens: number; output_tokens: number };
  model_id: string;
}

interface TransportRequest {
  system?: string;
  messages: CompleteMessage[];
  json_schema?: { name: string; schema: Record<string, unknown> };
  max_tokens: number;
}
interface TransportResult {
  text: string;
  usage: { input_tokens: number; output_tokens: number };
  /**
   * Slice 14: true when the transport fell back to `reasoning_content`
   * because `content` was empty. Callers must log and count every fire —
   * a silent fallback can ship a model's private deliberation as a final
   * answer.
   */
  reasoningFallbackFired?: boolean;
}
type FetchImpl = typeof fetch;

class UnauthorizedError extends Error {}

const maxTokensPerTier: Record<GatewayTier, number> = { cheap: 2000, strong: 4000 };
const timeoutPerTier: Record<GatewayTier, number> = { cheap: 60000, strong: 120000 };

function truncate(value: unknown, length = 300): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export class ModelGateway {
  constructor(
    private readonly db: Store,
    private readonly accounts: ModelAccounts,
    private readonly getPreferences: (owner: string) => Promise<StoredPreferences>,
    private readonly fetchImpl: FetchImpl = fetch,
  ) {}

  async complete(owner: string, input: CompleteInput): Promise<CompleteResult> {
    if (!input.messages.length) throw new GatewayError("PROVIDER_ERROR", "No messages", 422);
    const prefs = await this.getPreferences(owner);
    // Slice 14: per-role model override, keyed by instructions_ref. No role is
    // routed anywhere by default — role_models is empty until the user
    // connects a provider and sets an override in Settings.
    const override =
      input.instructions_ref && prefs.role_models
        ? prefs.role_models[input.instructions_ref]
        : undefined;
    const provider =
      override?.provider ?? (input.tier === "cheap" ? prefs.cheap_provider : prefs.strong_provider);
    const configuredModel =
      override?.model ?? (input.tier === "cheap" ? prefs.cheap_model : prefs.strong_model);
    if (!provider)
      throw new GatewayError(
        "NOT_CONFIGURED",
        `No ${input.tier} model is connected. Connect one in Models first.`,
        409,
      );
    await this.checkBudget(owner, prefs, input.tier);
    // Slice 15: the provider may be a built-in id or a user-defined custom
    // provider id (`custom_<slug>_<rand>`). Custom providers resolve to their
    // own vault credential and base URL; anything else unknown stays a 409.
    const isCustomProvider = !(modelProviders as readonly string[]).includes(provider);
    const bearer = isCustomProvider
      ? await this.accounts.customBearerToken(owner, provider)
      : await this.accounts.bearerToken(owner, provider as ModelProvider);
    if (!bearer)
      throw new GatewayError("NOT_CONFIGURED", "The selected model account is not connected.", 409);
    const model_id = configuredModel || bearer.account.model_id;
    const request: TransportRequest = {
      system: input.system,
      messages: input.messages,
      json_schema: input.json_schema,
      max_tokens: maxTokensPerTier[input.tier],
    };
    const run = () =>
      this.dispatchWithAuthRetry(owner, provider, bearer, model_id, request, input.tier);
    const wantsVision = input.messages.some((m) => m.images && m.images.length > 0);
    let result: TransportResult;
    let json: unknown;
    // Slice 14: a reasoning_content fallback must never fire silently. Track
    // it across the invalid-JSON retry so a fire on either attempt is logged
    // and counted.
    let reasoningFallbackFired = false;
    try {
      result = await run();
      reasoningFallbackFired = reasoningFallbackFired || result.reasoningFallbackFired === true;
      if (input.json_schema) {
        json = parseJson(result.text);
        if (json === undefined) {
          // Invalid JSON retries once, then SCHEMA_INVALID.
          result = await run();
          reasoningFallbackFired = reasoningFallbackFired || result.reasoningFallbackFired === true;
          json = parseJson(result.text);
          if (json === undefined)
            throw new GatewayError(
              "SCHEMA_INVALID",
              `The model did not return valid JSON for ${input.purpose}.`,
            );
        }
      }
    } catch (error) {
      if (error instanceof GatewayError && error.errorClass === "PROVIDER_ERROR" && wantsVision) {
        const detail = error.message.toLowerCase();
        if (/image|vision|multimodal|unsupported media|invalid content/.test(detail))
          throw new GatewayError(
            "VISION_UNSUPPORTED",
            `The ${input.tier} model (${model_id}) does not accept images. Connect a vision-capable model for OCR.`,
            409,
          );
      }
      throw error;
    }
    await this.recordCall(
      owner,
      prefs,
      input.tier,
      {
        id: provider,
        label: bearer.account.label,
      },
      reasoningFallbackFired,
    );
    if (reasoningFallbackFired) {
      // Never silent: a reasoning trace can contain the model's private
      // deliberation. Log which role/model fired so it can be audited.
      console.warn(
        JSON.stringify({
          event: "reasoning_content_fallback",
          timestamp: new Date().toISOString(),
          instructions_ref: input.instructions_ref ?? null,
          purpose: input.purpose,
          provider,
          model_id,
        }),
      );
    }
    return { text: result.text, json, usage: result.usage, model_id };
  }

  /** Minimal completion to prove a connected account actually works. */
  async testTier(
    owner: string,
    tier: GatewayTier,
  ): Promise<{ ok: true; text: string; model_id: string; usage: CompleteResult["usage"] }> {
    const result = await this.complete(owner, {
      purpose: "connectivity check",
      system: "You are a connectivity check. Reply with exactly: OK",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      tier,
    });
    return { ok: true, text: result.text, model_id: result.model_id, usage: result.usage };
  }

  private async dispatchWithAuthRetry(
    owner: string,
    provider: string,
    bearer: { token: string; account: ModelAccount },
    model_id: string,
    request: TransportRequest,
    tier: GatewayTier,
  ): Promise<TransportResult> {
    // Transient 429/503 from the provider is retried with exponential backoff
    // (max 3 attempts). Anything else — including auth failures after refresh —
    // fails fast so a bad request never burns quota on retries.
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.dispatchOnce(owner, provider, bearer, model_id, request, tier);
      } catch (error) {
        lastError = error;
        const status = error instanceof GatewayError ? error.status : 0;
        if (status !== 429 && status !== 503) throw error;
        if (attempt < 2) await sleep(4000 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  private async dispatchOnce(
    owner: string,
    provider: string,
    bearer: { token: string; account: ModelAccount },
    model_id: string,
    request: TransportRequest,
    tier: GatewayTier,
  ): Promise<TransportResult> {
    try {
      return await this.dispatch(provider, bearer, model_id, request, tier);
    } catch (error) {
      if (error instanceof UnauthorizedError && bearer.account.auth.type === "oauth") {
        // Custom providers are API-key only, so this cast only ever sees a
        // built-in OAuth provider id here.
        const refreshed = await this.accounts.forceRefresh(owner, provider as ModelProvider);
        if (refreshed)
          return this.dispatch(
            provider,
            {
              token: refreshed.auth.type === "oauth" ? refreshed.auth.access_token : bearer.token,
              account: refreshed,
            },
            model_id,
            request,
            tier,
          );
      }
      throw error;
    }
  }

  private dispatch(
    provider: string,
    bearer: { token: string; account: ModelAccount },
    model_id: string,
    request: TransportRequest,
    tier: GatewayTier,
  ): Promise<TransportResult> {
    // Slice 15: user-defined custom providers are OpenAI-compatible endpoints
    // with their own base URL and vault key. They reuse the chat-completions
    // transport instead of duplicating it.
    if (!(modelProviders as readonly string[]).includes(provider)) {
      const base = bearer.account.base_url;
      if (!base)
        throw new GatewayError("NOT_CONFIGURED", "This custom provider needs a base URL.", 409);
      return this.chatCompletions(
        `${base}/chat/completions`,
        { Authorization: `Bearer ${bearer.token}` },
        model_id,
        request,
        tier,
      );
    }
    switch (provider as ModelProvider) {
      case "openai":
      case "xai":
      case "google":
      case "openai-compatible":
      case "custom": {
        const base = bearer.account.base_url ?? defaultBaseUrls[provider as ModelProvider];
        if (!base) throw new GatewayError("NOT_CONFIGURED", "This endpoint needs a base URL.", 409);
        return this.chatCompletions(
          `${base}/chat/completions`,
          { Authorization: `Bearer ${bearer.token}` },
          model_id,
          request,
          tier,
        );
      }
      case "anthropic": {
        const base = (bearer.account.base_url ?? defaultBaseUrls.anthropic ?? "").replace(
          /\/v1\/?$/,
          "",
        );
        return this.anthropicMessages(`${base}/v1/messages`, bearer.token, model_id, request);
      }
      case "chatgpt": {
        const oauth = bearer.account.auth;
        const headers: Record<string, string> = {
          Authorization: `Bearer ${bearer.token}`,
          originator: "codex_cli_rs",
        };
        if (oauth.type === "oauth" && oauth.account_id)
          headers["ChatGPT-Account-Id"] = oauth.account_id;
        return this.responsesApi(
          "https://chatgpt.com/backend-api/codex/responses",
          headers,
          model_id,
          request,
          tier,
          true, // the ChatGPT Codex backend requires stream:true
        );
      }
      case "grok":
        return this.responsesApi(
          "https://api.x.ai/v1/responses",
          { Authorization: `Bearer ${bearer.token}` },
          model_id,
          request,
          tier,
        );
    }
  }

  private async post(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    tier: GatewayTier,
  ): Promise<unknown> {
    const response = await this.requestRaw(url, headers, body, tier);
    try {
      return await response.json();
    } catch {
      throw new GatewayError("PROVIDER_ERROR", "Model returned an unreadable response.");
    }
  }

  private async postText(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    tier: GatewayTier,
  ): Promise<string> {
    const response = await this.requestRaw(url, headers, body, tier);
    return response.text();
  }

  private async requestRaw(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    tier: GatewayTier,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutPerTier[tier]),
      });
    } catch (error) {
      throw new GatewayError(
        "PROVIDER_ERROR",
        `Model request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 401) throw new UnauthorizedError("unauthorized");
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const status = response.status === 429 ? 429 : response.status === 503 ? 503 : 502;
      throw new GatewayError(
        "PROVIDER_ERROR",
        `Model request failed (${response.status}): ${truncate(detail) || response.statusText}`,
        status,
      );
    }
    return response;
  }

  private async chatCompletions(
    url: string,
    headers: Record<string, string>,
    model: string,
    request: TransportRequest,
    tier: GatewayTier,
  ): Promise<TransportResult> {
    const messages = request.messages.map(({ role, content, images }) => {
      if (!images || images.length === 0) return { role, content };
      return {
        role,
        content: [
          { type: "text", text: content },
          ...images.map((img) => ({
            type: "image_url",
            image_url: { url: `data:${img.mime};base64,${img.base64}` },
          })),
        ],
      };
    });
    if (request.system) messages.unshift({ role: "system", content: request.system });
    const data = (await this.post(
      url,
      headers,
      {
        model,
        messages,
        max_completion_tokens: request.max_tokens,
        ...(request.json_schema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: request.json_schema.name,
                  schema: request.json_schema.schema,
                  strict: true,
                },
              },
            }
          : {}),
      },
      tier,
    )) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    // Slice 14: Nemotron reasoning models may put the answer in
    // reasoning_content with content empty. Fall back to it so the pipeline
    // does not see empty text (which would fail with SCHEMA_INVALID), but
    // flag the fire: the caller logs and counts every fallback, because a
    // reasoning trace can contain private deliberation that must never ship
    // silently as a final answer.
    // Transport-only: prompts, schemas, grounding, and approvals are untouched.
    const message = data.choices?.[0]?.message;
    const reasoningFallbackFired = !message?.content && !!message?.reasoning_content;
    const text = message?.content || message?.reasoning_content || "";
    return {
      text,
      reasoningFallbackFired,
      usage: {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        output_tokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  private async anthropicMessages(
    url: string,
    apiKey: string,
    model: string,
    request: TransportRequest,
  ): Promise<TransportResult> {
    let system = request.system ?? "";
    if (request.json_schema)
      system += `\n\nRespond with exactly one JSON object matching this JSON Schema, and no other text:\n${JSON.stringify(request.json_schema.schema)}`;
    const data = (await this.post(
      url,
      { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      {
        model,
        max_tokens: request.max_tokens,
        ...(system ? { system } : {}),
        messages: request.messages
          .filter((m) => m.role !== "system")
          .map(({ role, content, images }) =>
            !images || images.length === 0
              ? { role, content }
              : {
                  role,
                  content: [
                    ...(content ? [{ type: "text", text: content }] : []),
                    ...images.map((img) => ({
                      type: "image",
                      source: { type: "base64", media_type: img.mime, data: img.base64 },
                    })),
                  ],
                },
          ),
      },
      "cheap",
    )) as {
      content?: { type?: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (data.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    return {
      text,
      usage: {
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
      },
    };
  }

  private async responsesApi(
    url: string,
    headers: Record<string, string>,
    model: string,
    request: TransportRequest,
    tier: GatewayTier,
    stream = false,
  ): Promise<TransportResult> {
    const input = request.messages.map(({ role, content, images }) => {
      if (!images || images.length === 0) return { role, content };
      return {
        role,
        content: [
          ...(content ? [{ type: "input_text", text: content }] : []),
          ...images.map((img) => ({
            type: "input_image",
            image_url: `data:${img.mime};base64,${img.base64}`,
          })),
        ],
      };
    });
    if (request.system) input.unshift({ role: "system", content: request.system });
    const body = {
      model,
      input,
      store: false,
      ...(stream ? { stream: true } : {}),
      ...(request.json_schema
        ? {
            text: {
              format: {
                type: "json_schema",
                name: request.json_schema.name,
                schema: request.json_schema.schema,
                strict: true,
              },
            },
          }
        : {}),
    };
    if (!stream) {
      const data = (await this.post(url, headers, body, tier)) as {
        output?: { type?: string; content?: { type?: string; text?: string }[] }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (data.output ?? [])
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content ?? [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text ?? "")
        .join("");
      return {
        text,
        usage: {
          input_tokens: data.usage?.input_tokens ?? 0,
          output_tokens: data.usage?.output_tokens ?? 0,
        },
      };
    }
    return parseResponsesSse(await this.postText(url, headers, body, tier));
  }

  private async checkBudget(
    owner: string,
    prefs: StoredPreferences,
    tier: "cheap" | "strong",
  ): Promise<void> {
    const usage = await this.db.get<{
      window_start: string;
      strong_calls: number;
      cheap_calls: number;
    }>(owner, "gateway_usage", "default");
    const windowMs = prefs.scan_interval_hours * 3600 * 1000;
    const fresh = usage && Date.now() - Date.parse(usage.window_start) < windowMs ? usage : null;
    const limit =
      tier === "strong"
        ? prefs.max_strong_model_packs_per_cycle
        : prefs.max_cheap_model_calls_per_cycle;
    const used = tier === "strong" ? (fresh?.strong_calls ?? 0) : (fresh?.cheap_calls ?? 0);
    if (fresh && used >= limit)
      throw new GatewayError(
        "BUDGET_EXCEEDED",
        `${tier === "strong" ? "Strong-model" : "Cheap-model"} budget reached (${limit} per ${prefs.scan_interval_hours}h). Raise the limit in Settings or wait for the next window.`,
        429,
      );
  }

  private async recordCall(
    owner: string,
    prefs: StoredPreferences,
    tier: "cheap" | "strong",
    provider?: { id: string; label: string },
    reasoningFallbackFired?: boolean,
  ): Promise<void> {
    const usage = await this.db.get<{
      window_start: string;
      strong_calls: number;
      cheap_calls: number;
    }>(owner, "gateway_usage", "default");
    const windowMs = prefs.scan_interval_hours * 3600 * 1000;
    const fresh = usage && Date.now() - Date.parse(usage.window_start) < windowMs ? usage : null;
    await this.db.put(owner, "gateway_usage", {
      id: "default",
      window_start: fresh ? fresh.window_start : new Date().toISOString(),
      strong_calls: (fresh?.strong_calls ?? 0) + (tier === "strong" ? 1 : 0),
      cheap_calls: (fresh?.cheap_calls ?? 0) + (tier === "cheap" ? 1 : 0),
    });
    // Slice 15: per-provider attribution, so usage can be traced to the exact
    // account — built-in or user-defined custom — that served the call.
    if (provider) {
      const seen = await this.db.get<{
        calls: number;
        reasoning_fallbacks?: number;
      }>(owner, "gateway_provider_usage", provider.id);
      await this.db.put(owner, "gateway_provider_usage", {
        id: provider.id,
        provider_id: provider.id,
        label: provider.label,
        calls: (seen?.calls ?? 0) + 1,
        // Slice 14: count every reasoning_content fallback fire per provider
        // so a reasoning model silently standing in for final answers is
        // visible in usage, not just in server logs.
        reasoning_fallbacks: (seen?.reasoning_fallbacks ?? 0) + (reasoningFallbackFired ? 1 : 0),
        last_used_at: new Date().toISOString(),
      });
    }
  }
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Parse a Responses API SSE stream: accumulate output_text deltas, take usage from response.completed. */
function parseResponsesSse(body: string): TransportResult {
  let text = "";
  let input_tokens = 0;
  let output_tokens = 0;
  for (const chunk of body.split("\n\n")) {
    const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) continue;
    const event = parseJson(dataLine.slice(5).trim()) as
      | {
          type?: string;
          delta?: string;
          response?: { usage?: { input_tokens?: number; output_tokens?: number } };
        }
      | undefined;
    if (!event) continue;
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
    } else if (event.type === "response.completed") {
      input_tokens = event.response?.usage?.input_tokens ?? input_tokens;
      output_tokens = event.response?.usage?.output_tokens ?? output_tokens;
    }
  }
  return { text, usage: { input_tokens, output_tokens } };
}
