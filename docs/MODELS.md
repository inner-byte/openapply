# Model gateway

Version: 1.2  
Status: Approved

## Protocols

1. OpenAI Chat Completions
2. OpenAI Responses API
3. Anthropic Messages
4. OpenAI-compatible base URL + key + model id

## Connect

The user picks how to attach a provider. All of these are in scope:

| Connect | Examples |
| --- | --- |
| API key + model id | OpenAI, Anthropic, xAI, Google (Gemini via its OpenAI-compatible endpoint), or a custom OpenAI-compatible endpoint (name + base URL) |
| Account OAuth | ChatGPT (OpenAI), Grok (xAI) |
| Other providers | Same connect card and gateway. No chassis change. |

OAuth tokens and API keys live in the vault. Agent packets receive model output only, never credentials.

Model discovery: `POST /api/models/discover` lists the models an API key can
reach (OpenAI-style `/v1/models`; a curated fallback for Anthropic, which
exposes no list endpoint; Gemini lists via `<base>/models`). The key is used for that one call and never stored.
The Models sheet offers "Fetch available models" after the key is entered, so
the model is picked from a list instead of typed from memory.

## Image generation

`POST /api/models/image` generates an image through an OpenAI-style
`/images/generations` endpoint: `{ provider, prompt, model?, size? }` →
`{ b64_json, mime }`. Works with OpenAI, xAI, `openai-compatible`, and
user-defined custom providers (OAuth accounts and the Anthropic/Google native
image APIs are not supported — their image APIs differ). The Models sheet has
a "Generate an image" section; the key never leaves the server.

## Settings

- `cheap_provider` / `cheap_model`
- `strong_provider` / `strong_model`
- Connected accounts: ChatGPT, Grok, and any other provider the user has linked
- Keys and OAuth refresh tokens in vault
- Timeout and max tokens per tier

## Routing

| Work | Tier |
| --- | --- |
| Extract, rank, notify, summarize | cheap |
| Resume, cover, statement, HR review, company brief | strong |

## Interface

```text
complete({
  purpose,
  system,
  messages,
  json_schema?,
  tier: "cheap" | "strong"
}) -> { text, json?, usage, model_id }
```

## Failure

Provider errors → `PROVIDER_ERROR`.
Invalid JSON retries once, then `SCHEMA_INVALID`.
Budget governor stops further strong runs in the cycle.

## OAuth implementation

The ChatGPT and Grok connects reuse the vendors' own public CLI login clients
(PKCE S256). These are unofficial, undocumented backends: they work today but can
break if the vendors rotate the client or change the endpoints. API keys are the
stable path.

| | ChatGPT | Grok |
| --- | --- | --- |
| Authorize | `https://auth.openai.com/oauth/authorize` | `https://auth.x.ai/oauth2/authorize` |
| Token | `https://auth.openai.com/oauth/token` | `https://auth.x.ai/oauth2/token` |
| Public client id | `app_EMoamEEZ73f0CkXaXp7hrann` (Codex CLI) | `b1a00492-073a-47ea-816f-4c329264a828` ("Grok Build") |
| Redirect | `http://localhost:1455/auth/callback` | `http://127.0.0.1:56121/callback` |
| Inference | `https://chatgpt.com/backend-api/codex/responses` (+ `ChatGPT-Account-Id`, `originator: codex_cli_rs`) | `https://api.x.ai/v1/responses` |

The public clients only allow their own loopback redirects, so the connect is
two steps: `POST /api/models/oauth/:provider/start` returns the authorize URL,
the user approves in the browser, then pastes the `code` from the browser
address bar into `POST /api/models/oauth/:provider/finish`. OAuth state is
single-use and expires after 10 minutes. Tokens refresh proactively (60s skew)
and once more on a 401 before the call fails.

## ChatGPT model namespace (verified live 2026-09-25)

The ChatGPT Codex backend (`chatgpt.com/backend-api/codex/responses`) does **not**
accept standard API model IDs. It uses its own namespace: `gpt-5`, `gpt-5-codex`,
`gpt-5.5` are all rejected with "not supported when using Codex with a ChatGPT
account". Verified working against a real ChatGPT account: **`gpt-5.6-luna`**
(the current default). The backend also requires `stream: true`; the gateway
sends streaming requests for `chatgpt` and parses the SSE stream
(`response.output_text.delta` events, usage from `response.completed`).

## Budget governor

Strong-tier calls count against `max_strong_model_packs_per_cycle` inside a
rolling window of `scan_interval_hours`. Only completed calls count. Over the
limit, `complete()` raises `BUDGET_EXCEEDED`.

## Tier defaults

Timeouts: 60s cheap, 120s strong. Max tokens: 2000 cheap, 4000 strong.

## Prompts

Store under [agents/prompts/](./agents/prompts/README.md). Packets reference `instructions_ref`. Do not merge prompt files into one system prompt.
