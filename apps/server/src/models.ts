import { createHash, randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "../../../packages/integrations/src/vault.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

/**
 * Model account connects, per docs/MODELS.md and ADR-016.
 *
 * API keys and OAuth tokens live in the vault (encrypted with TOKEN_ENCRYPTION_KEY).
 * They never enter agent prompts or the Expo client: only the summary list leaves
 * this service.
 *
 * The ChatGPT and Grok OAuth paths reuse the public OAuth clients that the
 * community reverse-engineered from the Codex CLI / Grok CLI login flows
 * (auth.openai.com and auth.x.ai, PKCE S256). These are unofficial, undocumented
 * backends: they work today but can break if the vendors change them.
 */

export const apiKeyProviders = [
  "openai",
  "anthropic",
  "xai",
  "google",
  "openai-compatible",
  "custom",
] as const;
export const oauthProviders = ["chatgpt", "grok"] as const;
export const modelProviders = [...apiKeyProviders, ...oauthProviders] as const;
export type ModelProvider = (typeof modelProviders)[number];

export interface ApiKeyAuth {
  type: "api_key";
  api_key: string;
}
export interface OAuthAuth {
  type: "oauth";
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  account_id?: string;
}
export interface ModelAccount {
  provider: ModelProvider;
  label: string;
  model_id: string;
  base_url?: string;
  auth: ApiKeyAuth | OAuthAuth;
  connected_at: string;
}
export interface ModelAccountSummary {
  provider: ModelProvider;
  label: string;
  model_id: string;
  base_url?: string;
  auth_type: "api_key" | "oauth";
  connected_at: string;
}

/** A user-defined custom provider account (Slice 15). The vault credential
 *  id is `model:custom:<custom_id>`; the human-readable record (label,
 *  base_url, model_id) lives in the owner's preferences `custom_providers`
 *  list. The key never leaves the vault. */
export interface CustomModelAccount extends ModelAccount {
  provider: "custom";
  custom_id: string;
  base_url: string;
}

const defaultModels: Record<ModelProvider, string> = {
  openai: "gpt-5",
  anthropic: "claude-sonnet-4-5",
  xai: "grok-4",
  google: "gemini-2.5-flash",
  "openai-compatible": "",
  custom: "",
  chatgpt: "gpt-5.6-luna",
  grok: "grok-4",
};
const defaultLabels: Record<ModelProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  xai: "xAI",
  google: "Google",
  "openai-compatible": "Custom endpoint",
  custom: "Custom",
  chatgpt: "ChatGPT",
  grok: "Grok",
};
export const defaultBaseUrls: Partial<Record<ModelProvider, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  xai: "https://api.x.ai/v1",
  // Gemini's OpenAI-compatible endpoint; chat completions live under /openai/.
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
};
/** Default image models for providers with an OpenAI-style images endpoint. */
const imageDefaultModels: Partial<Record<ModelProvider, string>> = {
  openai: "gpt-image-1",
  xai: "grok-2-image",
};

interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  extraAuthorize: Record<string, string>;
}
/** Public OAuth clients reused from the vendors' own CLI login flows. */
const oauthConfigs: Record<(typeof oauthProviders)[number], OAuthConfig> = {
  chatgpt: {
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    redirectUri: "http://localhost:1455/auth/callback",
    scopes: ["openid", "profile", "email", "offline_access"],
    extraAuthorize: { id_token_add_organizations: "true", codex_cli_simplified_flow: "true" },
  },
  grok: {
    authorizeUrl: "https://auth.x.ai/oauth2/authorize",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    redirectUri: "http://127.0.0.1:56121/callback",
    scopes: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
    extraAuthorize: { plan: "generic" },
  },
};

interface OAuthState {
  id: string;
  provider: (typeof oauthProviders)[number];
  verifier: string;
  expiresAt: number;
}
interface StoredCredential {
  id: string;
  secret: string;
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
/** Best-effort ChatGPT account id from the access-token JWT payload. */
function chatGptAccountId(accessToken: string): string | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    for (const key of ["chatgpt_account_id", "account_id", "https://api.openai.com/account_id"]) {
      if (typeof payload[key] === "string") return payload[key] as string;
    }
  } catch {
    /* not a JWT; account id stays unknown */
  }
  return undefined;
}

export class ModelAccounts {
  private readonly refreshing = new Map<string, Promise<ModelAccount | null>>();
  constructor(
    private readonly db: Store,
    private readonly config: Config,
  ) {}
  private requireKey(): string {
    if (!this.config.encryptionKey)
      throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
    return this.config.encryptionKey;
  }
  private credentialId(provider: ModelProvider): string {
    return `model:${provider}`;
  }
  private async save(owner: string, account: ModelAccount): Promise<void> {
    await this.db.put<StoredCredential>(owner, "credentials", {
      id: this.credentialId(account.provider),
      secret: encryptSecret(JSON.stringify(account), this.requireKey()),
    });
  }
  async get(owner: string, provider: ModelProvider): Promise<ModelAccount | null> {
    const stored = await this.db.get<StoredCredential>(
      owner,
      "credentials",
      this.credentialId(provider),
    );
    if (!stored) return null;
    return JSON.parse(decryptSecret(stored.secret, this.requireKey())) as ModelAccount;
  }
  async list(owner: string): Promise<ModelAccountSummary[]> {
    const summaries: ModelAccountSummary[] = [];
    for (const provider of modelProviders) {
      const account = await this.get(owner, provider);
      if (account)
        summaries.push({
          provider: account.provider,
          label: account.label,
          model_id: account.model_id,
          base_url: account.base_url,
          auth_type: account.auth.type,
          connected_at: account.connected_at,
        });
    }
    return summaries;
  }
  async connectApiKey(
    owner: string,
    input: {
      provider: string;
      api_key: string;
      model_id?: string;
      base_url?: string;
      label?: string;
    },
  ): Promise<ModelAccountSummary> {
    if (!(apiKeyProviders as readonly string[]).includes(input.provider))
      throw new AppError(`API-key connect supports: ${apiKeyProviders.join(", ")}`, 422);
    const provider = input.provider as (typeof apiKeyProviders)[number];
    if (!input.api_key || input.api_key.length < 8)
      throw new AppError("API key looks too short", 422);
    let base_url = input.base_url?.trim() || defaultBaseUrls[provider];
    if (provider === "openai-compatible" || provider === "custom") {
      if (!base_url) throw new AppError("base_url is required for a custom endpoint", 422);
      if (!/^https?:\/\//.test(base_url))
        throw new AppError("base_url must be an http(s) URL", 422);
      base_url = base_url.replace(/\/+$/, "");
    }
    if (provider === "custom" && !input.label?.trim())
      throw new AppError("A name is required for a custom provider", 422);
    const model_id = input.model_id?.trim() || defaultModels[provider];
    if (!model_id) throw new AppError("model_id is required", 422);
    const account: ModelAccount = {
      provider,
      label: input.label?.trim() || defaultLabels[provider],
      model_id,
      base_url,
      auth: { type: "api_key", api_key: input.api_key },
      connected_at: new Date().toISOString(),
    };
    await this.save(owner, account);
    return {
      provider: account.provider,
      label: account.label,
      model_id: account.model_id,
      base_url: account.base_url,
      auth_type: "api_key",
      connected_at: account.connected_at,
    };
  }
  async disconnect(owner: string, provider: string): Promise<void> {
    if (!(modelProviders as readonly string[]).includes(provider))
      throw new AppError("Unknown model provider", 422);
    await this.db.remove(owner, "credentials", this.credentialId(provider as ModelProvider));
  }

  private customCredentialId(id: string): string {
    return `model:custom:${id}`;
  }

  private async uniqueCustomProviderId(owner: string, label: string): Promise<string> {
    const slug =
      label
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24) || "provider";
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = `custom_${slug}_${randomBytes(2).toString("hex")}`;
      const existing = await this.db.get<StoredCredential>(
        owner,
        "credentials",
        this.customCredentialId(id),
      );
      if (!existing) return id;
    }
    throw new AppError("Could not generate a unique provider id; try again.", 500);
  }

  /** Connect one more user-defined custom provider (Slice 15). There is no
   *  one-provider limit: each connect mints a stable unique id and its own
   *  vault credential. New custom providers require https. */
  async connectCustomProvider(
    owner: string,
    input: {
      label?: string;
      base_url?: string;
      api_key?: string;
      model_id?: string;
    },
  ): Promise<{
    id: string;
    label: string;
    base_url: string;
    model_id: string;
    connected_at: string;
  }> {
    const label = input.label?.trim();
    if (!label) throw new AppError("A name is required for a custom provider", 422);
    if (label.length > 80) throw new AppError("Provider name is too long (max 80 characters)", 422);
    const base_url = input.base_url?.trim().replace(/\/+$/, "");
    if (!base_url || !/^https:\/\//.test(base_url))
      throw new AppError("base_url must be an https URL", 422);
    if (!input.api_key || input.api_key.length < 8)
      throw new AppError("API key looks too short", 422);
    const model_id = input.model_id?.trim();
    if (!model_id) throw new AppError("model_id is required", 422);
    const id = await this.uniqueCustomProviderId(owner, label);
    const account: CustomModelAccount = {
      provider: "custom",
      custom_id: id,
      label,
      model_id,
      base_url,
      auth: { type: "api_key", api_key: input.api_key },
      connected_at: new Date().toISOString(),
    };
    await this.db.put<StoredCredential>(owner, "credentials", {
      id: this.customCredentialId(id),
      secret: encryptSecret(JSON.stringify(account), this.requireKey()),
    });
    return { id, label, base_url, model_id, connected_at: account.connected_at };
  }

  async getCustomAccount(owner: string, id: string): Promise<CustomModelAccount | null> {
    const stored = await this.db.get<StoredCredential>(
      owner,
      "credentials",
      this.customCredentialId(id),
    );
    if (!stored) return null;
    const account = JSON.parse(
      decryptSecret(stored.secret, this.requireKey()),
    ) as CustomModelAccount;
    if (account.custom_id !== id) return null;
    return account;
  }

  /** A usable bearer token for a user-defined custom provider. */
  async customBearerToken(
    owner: string,
    id: string,
  ): Promise<{ token: string; account: CustomModelAccount } | null> {
    const account = await this.getCustomAccount(owner, id);
    if (!account || account.auth.type !== "api_key") return null;
    return { token: account.auth.api_key, account };
  }

  /**
   * Generate an image through an OpenAI-style `/images/generations` endpoint.
   * Works with API-key providers that expose a base URL (openai, xai,
   * openai-compatible, and user-defined custom providers). OAuth accounts and
   * the Anthropic/Google native APIs are not supported — their image APIs
   * differ. The key never leaves the server; only the image bytes do.
   */
  async generateImage(
    owner: string,
    input: { provider: string; prompt: string; model?: string; size?: string },
  ): Promise<{ b64_json: string; mime: string }> {
    const prompt = input.prompt?.trim() ?? "";
    if (!prompt || prompt.length > 4000)
      throw new AppError("An image prompt of 1-4000 characters is required", 422);
    const size = input.size?.trim() || "1024x1024";
    if (!["1024x1024", "1536x1024", "1024x1536", "1024x1792", "1792x1024"].includes(size))
      throw new AppError("Unsupported image size", 422);

    let token: string;
    let base: string | undefined;
    let model: string | undefined = input.model?.trim() || undefined;
    if (input.provider.startsWith("custom_")) {
      const bearer = await this.customBearerToken(owner, input.provider);
      if (!bearer) throw new AppError("That custom provider is not connected", 409);
      token = bearer.token;
      base = bearer.account.base_url;
      model = model || bearer.account.model_id;
    } else {
      const imageProviders = ["openai", "xai", "openai-compatible"] as const;
      if (!(imageProviders as readonly string[]).includes(input.provider))
        throw new AppError(
          `Image generation supports: ${imageProviders.join(", ")} and custom providers`,
          422,
        );
      const provider = input.provider as (typeof imageProviders)[number];
      const bearer = await this.bearerToken(owner, provider);
      if (!bearer) throw new AppError("That provider is not connected", 409);
      token = bearer.token;
      base = bearer.account.base_url ?? defaultBaseUrls[provider];
      model = model || imageDefaultModels[provider];
    }
    if (!base) throw new AppError("This provider needs a base URL", 422);
    if (!model) throw new AppError("An image model id is required", 422);
    const url = `${base.replace(/\/+$/, "")}/images/generations`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, prompt, size, n: 1, response_format: "b64_json" }),
        signal: AbortSignal.timeout(120000),
      });
    } catch (e) {
      throw new AppError(
        `Could not reach the image endpoint: ${e instanceof Error ? e.message : String(e)}`,
        502,
      );
    }
    if (!res.ok)
      throw new AppError(
        `The provider refused the image request (HTTP ${res.status}).`,
        res.status === 401 ? 401 : 502,
      );
    const body = (await res.json().catch(() => null)) as {
      data?: Array<{ b64_json?: string; url?: string }>;
    } | null;
    const first = body?.data?.[0];
    if (!first || (!first.b64_json && !first.url))
      throw new AppError("The provider returned no image", 502);
    if (first.b64_json) return { b64_json: first.b64_json, mime: "image/png" };
    // Some endpoints return a URL instead of bytes; fetch it server-side so
    // the key stays server-side and the client gets plain bytes.
    const imageUrl = first.url;
    if (!imageUrl) throw new AppError("The provider returned no image", 502);
    const img = await fetch(imageUrl, { signal: AbortSignal.timeout(60000) });
    if (!img.ok) throw new AppError("Could not download the generated image", 502);
    const bytes = Buffer.from(await img.arrayBuffer());
    return {
      b64_json: bytes.toString("base64"),
      mime: img.headers.get("content-type")?.split(";")[0] || "image/png",
    };
  }

  async deleteCustomProvider(owner: string, id: string): Promise<void> {
    await this.db.remove(owner, "credentials", this.customCredentialId(id));
  }

  /** Test a custom endpoint's key without storing anything: GET
   *  {base_url}/v1/models. Reuses the OpenAI-compatible discovery transport. */
  async discoverCustomModels(input: {
    base_url?: string;
    api_key?: string;
  }): Promise<{ models: string[] }> {
    const base_url = input.base_url?.trim();
    if (!base_url || !/^https:\/\//.test(base_url))
      throw new AppError("base_url must be an https URL", 422);
    return this.discoverModels({
      provider: "openai-compatible",
      api_key: input.api_key ?? "",
      base_url,
    });
  }

  /** List the models an API key can reach, without storing anything.
   *  Uses the provider's OpenAI-style `/models` endpoint. Anthropic exposes no
   *  list endpoint, so a curated fallback is returned there. */
  async discoverModels(input: {
    provider: string;
    api_key: string;
    base_url?: string;
  }): Promise<{ models: string[] }> {
    if (!(apiKeyProviders as readonly string[]).includes(input.provider))
      throw new AppError(`Model discovery supports: ${apiKeyProviders.join(", ")}`, 422);
    const provider = input.provider as (typeof apiKeyProviders)[number];
    if (!input.api_key || input.api_key.length < 8)
      throw new AppError("API key looks too short", 422);
    if (provider === "anthropic")
      return { models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"] };
    let base = input.base_url?.trim() || defaultBaseUrls[provider];
    if (provider === "openai-compatible" || provider === "custom") {
      if (!base) throw new AppError("base_url is required for a custom endpoint", 422);
      if (!/^https?:\/\//.test(base)) throw new AppError("base_url must be an http(s) URL", 422);
      base = base.replace(/\/+$/, "");
    }
    if (!base) throw new AppError("No base URL for this provider", 422);
    // Gemini's OpenAI-compatible base already ends in /openai: its models
    // list lives at <base>/models, not <base>/v1/models.
    const url =
      provider === "google"
        ? `${base.replace(/\/+$/, "")}/models`
        : /\/v1\/?$/.test(base)
          ? `${base.replace(/\/+$/, "")}/models`
          : `${base}/v1/models`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${input.api_key}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new AppError(
        `Could not reach the models endpoint: ${e instanceof Error ? e.message : String(e)}`,
        502,
      );
    }
    if (!res.ok)
      throw new AppError(
        `The provider refused the models request (HTTP ${res.status}).`,
        res.status === 401 ? 401 : 502,
      );
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new AppError("The models endpoint did not return JSON.", 502);
    }
    const data = (body as { data?: Array<{ id?: string }> }).data;
    if (!Array.isArray(data)) throw new AppError("Unexpected models response shape.", 502);
    const models = data
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return { models };
  }
  /** Begin an OAuth connect. The user opens `url`, approves, then pastes the `code`
   *  from the browser address bar into `finish` (the vendors' public clients only
   *  allow their own loopback redirect URIs). */
  async oauthStart(owner: string, provider: string): Promise<{ url: string; state: string }> {
    if (!(oauthProviders as readonly string[]).includes(provider))
      throw new AppError(`OAuth connect supports: ${oauthProviders.join(", ")}`, 422);
    const typed = provider as (typeof oauthProviders)[number];
    const cfg = oauthConfigs[typed];
    const { verifier, challenge } = pkcePair();
    const state = base64url(randomBytes(16));
    await this.db.put<OAuthState>(owner, "oauth_states", {
      id: state,
      provider: typed,
      verifier,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      scope: cfg.scopes.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...cfg.extraAuthorize,
    });
    return { url: `${cfg.authorizeUrl}?${params}`, state };
  }
  async oauthFinish(
    owner: string,
    provider: string,
    input: { code: string; state: string },
  ): Promise<ModelAccountSummary> {
    if (!(oauthProviders as readonly string[]).includes(provider))
      throw new AppError(`OAuth connect supports: ${oauthProviders.join(", ")}`, 422);
    const typed = provider as (typeof oauthProviders)[number];
    const cfg = oauthConfigs[typed];
    const saved = await this.db.take<OAuthState>(owner, "oauth_states", input.state);
    if (!saved || saved.provider !== typed || saved.expiresAt < Date.now())
      throw new AppError("This sign-in expired or was already used. Start again.", 409);
    if (!input.code.trim()) throw new AppError("Paste the code from the browser address bar", 422);
    const tokens = await this.exchangeCode(cfg, input.code.trim(), saved.verifier);
    const account: ModelAccount = {
      provider: typed,
      label: defaultLabels[typed],
      model_id: defaultModels[typed],
      auth: {
        type: "oauth",
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
        account_id: typed === "chatgpt" ? chatGptAccountId(tokens.access_token) : undefined,
      },
      connected_at: new Date().toISOString(),
    };
    await this.save(owner, account);
    return {
      provider: account.provider,
      label: account.label,
      model_id: account.model_id,
      auth_type: "oauth",
      connected_at: account.connected_at,
    };
  }
  private async exchangeCode(
    cfg: OAuthConfig,
    code: string,
    verifier: string,
  ): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    const response = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: cfg.clientId,
        code,
        redirect_uri: cfg.redirectUri,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new AppError(
        `Sign-in failed (${response.status}). The code may have expired; start again.`,
        502,
      );
    const tokens = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!tokens.access_token) throw new AppError("Sign-in did not return an access token", 502);
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in ?? 3600,
    };
  }
  /** Refresh an OAuth account proactively (60s skew) or force it after a 401. Single-flight. */
  async refreshAccount(owner: string, provider: ModelProvider): Promise<ModelAccount | null> {
    const account = await this.get(owner, provider);
    if (account?.auth.type !== "oauth" || !account.auth.refresh_token) return account;
    if (account.auth.expires_at - Date.now() > 60000) return account;
    return this.refreshLocked(owner, provider, account);
  }
  /** Always attempt a refresh (used after a 401). Returns null when it fails. */
  async forceRefresh(owner: string, provider: ModelProvider): Promise<ModelAccount | null> {
    const account = await this.get(owner, provider);
    if (account?.auth.type !== "oauth" || !account.auth.refresh_token) return null;
    return this.refreshLocked(owner, provider, account);
  }
  private refreshLocked(
    owner: string,
    provider: ModelProvider,
    account: ModelAccount,
  ): Promise<ModelAccount | null> {
    const key = `${owner}:${provider}`;
    const active = this.refreshing.get(key);
    if (active) return active;
    const task = this.doRefresh(owner, provider, account).finally(() =>
      this.refreshing.delete(key),
    );
    this.refreshing.set(key, task);
    return task;
  }
  private async doRefresh(
    owner: string,
    provider: ModelProvider,
    account: ModelAccount,
  ): Promise<ModelAccount | null> {
    const auth = account.auth as OAuthAuth;
    const cfg = oauthConfigs[provider as (typeof oauthProviders)[number]];
    try {
      const response = await fetch(cfg.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: cfg.clientId,
          refresh_token: auth.refresh_token ?? "",
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) return null;
      const tokens = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!tokens.access_token) return null;
      const updated: ModelAccount = {
        ...account,
        auth: {
          type: "oauth",
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token ?? auth.refresh_token,
          expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          account_id: auth.account_id,
        },
      };
      await this.save(owner, updated);
      return updated;
    } catch {
      return null;
    }
  }
  /** A usable bearer token for the account, refreshing OAuth tokens when needed. */
  async bearerToken(
    owner: string,
    provider: ModelProvider,
  ): Promise<{ token: string; account: ModelAccount } | null> {
    const account = await this.refreshAccount(owner, provider);
    if (!account) return null;
    const token =
      account.auth.type === "api_key" ? account.auth.api_key : account.auth.access_token;
    return { token, account };
  }
}
