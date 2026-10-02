# OpenApply

A local, single-owner hiring workspace. It finds public jobs, drafts evidence-based application materials, and submits only after you approve. You can take the browser at any time.

OpenApply is a product fork of [OpenMuse](https://github.com/CopilotKit/OpenMuse) (MIT). It is not a fork of OpenMausBot. Agent-Reach is not part of the runtime.

| | |
| --- | --- |
| Upstream | https://github.com/CopilotKit/OpenMuse |
| Pinned commit | [`f5534c77a8c8740cf792ca73b1f7737829fb7518`](https://github.com/CopilotKit/OpenMuse/commit/f5534c77a8c8740cf792ca73b1f7737829fb7518) (`main`, 2026-09-24) |
| License | AGPL-3.0 (OpenApply); MIT for upstream OpenMuse code (see LICENSE.upstream) |
| Install | Self-hosted. One owner per install in v1. |
| Client | Expo web on localhost. The same app is the later iOS and Android client. |
| Docs | [docs/README.md](docs/README.md) is the source of truth. Chat transcripts are not. |
| Status | Slices 1–15 built and verified (353 tests passing). Slice 14 adds Nebius/Nemotron routed to the HR review role (the detector-evasion pass was removed per ADR-021). Slice 15: user-defined custom providers. Providers: OpenAI, Anthropic, xAI (Grok), Google (Gemini), ChatGPT/Grok OAuth, image generation, plus any OpenAI-compatible endpoint. Parallel computer isolation per role. |

Do not move this pin forward without an entry in [docs/DECISIONS.md](docs/DECISIONS.md). Rebrand only through [docs/PRODUCT_NAME.md](docs/PRODUCT_NAME.md) and one rename pull request.

## What v1 keeps

From OpenMuse: the Expo client, Hono API, durable tasks, review gates, file artifacts, Playwright Chromium worker, Google OAuth, and in-app notifications.

On top of that:

- A confirmed profile plus an evidence locker (resume, certificates, transcripts, licenses, awards, portfolios, publications, recommendations, prior statements)
- Scheduled public ATS scans (Greenhouse and Lever)
- Resume, cover letter, and statement drafts grounded in that evidence
- An HR authenticity review with evidence grounding
- Human approval before final materials and before submit
- Model access by API key (OpenAI, Anthropic, xAI/Grok, Google/Gemini), ChatGPT OAuth, Grok OAuth, or any OpenAI-compatible endpoint on the same gateway
- Image generation through connected providers
- Parallel computer isolation: per-role worker credentials and Chromium profiles, snapshot-before-action after browser takeover

## What v1 does not use

- OpenMausBot as a chassis
- Agent-Reach as a required runtime
- The OpenMuse Linux computer (`apps/computer` stays disabled)
- WhatsApp, Ideas, Finance, generic Goals, and the Computer screen
- Firefox, stored job-site passwords, and silent or headless logged-in board crawls
- CopilotKit Intelligence as a required dependency

## Docs

Read [docs/README.md](docs/README.md) in order. Start with [docs/VISION.md](docs/VISION.md), [docs/PRD.md](docs/PRD.md), and [docs/BUILD.md](docs/BUILD.md).

Prompt files are one run each. Do not merge them. The index is [docs/agents/prompts/README.md](docs/agents/prompts/README.md).

## Boot

From a checkout of this fork, after slice 1:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
# set the app access key, TOKEN_ENCRYPTION_KEY, and any API keys
pnpm dev
pnpm dev:web
pnpm dev:browser
```

Confirm `/api/health`.

Live drafts need a connected model: an API key, ChatGPT (OpenAI OAuth), Grok (xAI OAuth), or another provider on the same gateway. Keys and OAuth tokens stay in the vault. They never enter agent prompts.

`DATA_DIR` and browser profiles are sensitive. Back them up together. PGlite allows one API process. Details are in [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Nebius / NVIDIA integration (hackathon)

OpenApply connects to Nebius Token Factory as a user-defined custom provider —
no code change needed:

1. In Models, add a custom provider: name it (e.g. "Nebius"), set the base URL
   to your Token Factory endpoint, paste the API key, and pick the NVIDIA model
   (e.g. `nvidia/nemotron-3-nano-30b-a3b`).
2. In Models → role overrides, set `hr.review.v2` to the Nebius provider. The
   HR evidence-grounding review — a legitimate reasoning role — then runs on
   the NVIDIA open-source model.
3. Build a pack on the synthetic fixture data and check the `hr_review`
   artifact: it carries the provider/model attribution, and gateway usage
   records the call.

The per-role `role_models` override works with any connected provider, so the
same flow applies to OpenRouter, a lab server, or any OpenAI-compatible
endpoint. Pre-existing work: the OpenMuse chassis (MIT) plus Slices 1–13 of
the OpenApply pipeline predate the hackathon; the Nebius/Nemotron routing,
custom-provider UI, and per-role computer isolation were built during the
hackathon period.

## Deploy on Render

[render.yaml](render.yaml) deploys three services: the API, the web app, and a private browser. The API answers `/` with JSON, so the UI is its own static site.

### First run

1. In the Render dashboard, choose **New > Blueprint** and point it at this repo. Wait until `openapply-api`, `openapply-web`, and `openapply-browser` are live.
2. On `openapply-api`, open **Environment** and copy `OPENAPPLY_ACCESS_KEY`.
3. Open the `openapply-web` URL and sign in with that key.
4. Connect a model in **Models** (API key, ChatGPT OAuth, Grok OAuth, or a custom provider), then send a message.

The deploy form asks for two values you provide. Render generates the other two.

| Variable | Set by | If it is missing |
|---|---|---|
| `CPK_INTELLIGENCE_API_KEY` | You. Run `npx copilotkit@latest login`, then `npx copilotkit@latest project select`. Keep it on the server. | Chat cannot open a thread. |
| `OPENAI_API_KEY` | You. Used by the default `openai/gpt-5`. Change `MODEL` and supply the matching provider key for another vendor. | The model call fails. |
| `OPENAPPLY_ACCESS_KEY` | Render | You cannot sign in. |
| `TOKEN_ENCRYPTION_KEY` | Render | The API refuses to start in live mode. |

Health check: `https://<openapply-api>/api/health`.

### Services

| Service | Plan | What it runs |
|---|---|---|
| `openapply-api` | Standard, with a 1 GB disk at `/var/data` | The Hono API and the in-process task worker. `DATA_DIR` is `/var/data/openapply`. |
| `openapply-web` | Static site | The Expo web export. `EXPO_PUBLIC_API_URL` is baked in at build time. |
| `openapply-browser` | Private service, Standard, 1 GB disk at `/data` | Playwright and Chromium. The API calls it on the private network. |

**Standard** is the smallest plan that stays up. At 512 MB the process runs out of memory before it binds a port, because PGlite loads an embedded Postgres build.

**The disk** holds the database, PDFs, and the signing key. A redeploy without it wipes that data.

**Live mode** is required. Render binds `0.0.0.0`, and sample mode rejects any host that is not loopback. The Blueprint sets `WORKSPACE_MODE=live`.

**Browsing is included, and you can take it out.** `openapply-browser` is a private service, so it has no public URL. The API reaches it at `http://openapply-browser:8790` with a token Render generates. If the private hostname is not `openapply-browser`, set `BROWSER_WORKER_URL` to `http://<that-host>:8790`. To deploy without it, delete the `openapply-browser` service and the `BROWSER_WORKER_URL` and `WORKER_TOKEN` entries on `openapply-api`. Chat, drafts, and tasks still run. Page reads, screenshots, and **Take control** do not.

## Contributing

This fork does not default to upstream pull requests. Read [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) before opening a change. Behavior changes update the docs in the same pull request.

## License

OpenApply is licensed under the **GNU Affero General Public License v3.0**
([LICENSE](LICENSE)). If you modify OpenApply and run it on a network server,
you must offer all users the Corresponding Source of your version.

This is a fork of [OpenMuse](https://github.com/CopilotKit/OpenMuse), whose
code remains under its MIT license — see [LICENSE.upstream](LICENSE.upstream)
and keep the upstream copyright notice with the pin above.
