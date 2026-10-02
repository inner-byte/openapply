# Architecture decision records

## ADR-001 Adopt OpenMuse as chassis

Status: Accepted

Fork OpenMuse for UI, Hono API, durable tasks, review gates, Chromium worker, Google OAuth, and file artifacts.

Consequence: Chromium-only worker limits and single-owner auth.

## ADR-002 Isolated specialist agents

Status: Accepted

Control plane routes typed packets. Specialists do not share a context window.

## ADR-003 No Linux computer in v1

Status: Accepted

`apps/computer` stays disabled. No v1 hiring capability needs a jail shell.

## ADR-004 No WhatsApp

Status: Accepted

Telegram official bot, Gmail, and in-app only.

## ADR-005 Strip life-agent features

Status: Accepted

Remove or hide Ideas, Finance, generic Goals, Computer/Terminal.

## ADR-006 Chromium only

Status: Accepted

No Firefox adapter in v1.

## ADR-007 User-configured scan interval

Status: Accepted

6–24 hours, default 12. Unattended runs are public ATS only.

## ADR-008 No job-site passwords

Status: Accepted

Persist encrypted browser profiles only. User logs in via takeover.

## ADR-009 No background logged-in crawling

Status: Accepted

LinkedIn, Indeed, and government extraction run in a user-approved session.

## ADR-010 Authenticity reviewer

Status: Accepted. Detector-evasion scope is ADR-015.

HR reviewer enforces grounding, voice, and specificity. Wording changes that make prose less generic are in scope. New facts are not.

## ADR-011 Pluggable OpenAI and Anthropic protocols

Status: Accepted. Extended by ADR-016.

Gateway supports Chat Completions, Responses API, Anthropic Messages, and OpenAI-compatible base URLs. Account connect is specified in ADR-016.

## ADR-012 Dashboard is source-linked

Status: Accepted

Agent summaries never replace official posting URLs.

## ADR-013 Agent-Reach is an optional read sidecar

Status: Accepted

Do not merge https://github.com/Panniantong/Agent-Reach as a platform.

Allowed later: Jina-style public page read, RSS boards, optional Boss/LinkedIn read plugins behind the same `JobPosting` contract.

Forbidden: required runtime, recruiter greeting, cookie-upload CLIs, giving resume agents shell access to `agent-reach`.

Steal patterns: ordered backends, doctor health, stop on account-risk.

## ADR-014 OpenMausBot is not the chassis

Status: Accepted

https://github.com/milind-soni/OpenMausBot is a multi-CLI agent messenger. It has no hiring domain, stores credentials in a local config model that does not meet our vault bar, and would discard OpenMuse tasks/reviews/browser.

Optional later: permission-card UX reference only.

## ADR-015 Detector-evasion pass is in scope

Status: Superseded by ADR-021 (2026-10-01)

The HR authenticity reviewer blocks ungrounded metrics, missing skills, invented credentials, and voice mismatch. It also rewrites resume, cover, and statement candidates so they read as the user's writing rather than generic model prose. That rewrite includes a detector-evasion pass aimed at commercial AI-writing detectors.

The pass may change rhythm, wording, and structure. It may not add employers, dates, certificates, metrics, or other facts that are not in confirmed evidence.

## ADR-016 Connect ChatGPT, Grok, and other LLMs

Status: Accepted

Extends ADR-011.

The user must be able to attach a model without being limited to one vendor API key. v1 connect options:

- API key plus model id (OpenAI, Anthropic, or an OpenAI-compatible base URL)
- ChatGPT account connect (OpenAI OAuth)
- Grok account connect (xAI OAuth)
- Further providers behind the same connect card and gateway, without a chassis change

Cheap and strong tiers are chosen from connected accounts. OAuth refresh tokens and API keys stay in the vault. They never enter agent prompts or the Expo client.

## ADR-017 Evidence locker, not resume-only memory

Status: Accepted

The profile stores the master resume and the supporting record agents are allowed to learn from: certificates, transcripts, licenses, awards, portfolios, publications, recommendations, and prior statements or essays.

Intake writes a `ProfileDraft`. Nothing becomes memory until the user confirms. Resume, cover, and statement specialists must use this locker when they lean on a credential or detail. A certificate, date, or issuer that was not stored and confirmed cannot appear in a draft.


## ADR-018 Nebius/Nemotron integration for the hackathon

Status: Accepted

Context: the Nebius x NVIDIA Global AI Hackathon (Personal AI track)
requires a real runtime inference call on Nebius Token Factory (or AI
Cloud) with at least one NVIDIA open-source model. OpenApply's gateway
already speaks OpenAI-compatible endpoints (ADR-011, ADR-016), so the
integration is a per-role model override, not a new transport.

Decision: add `role_models` (instructions_ref -> {provider, model}) to
`ModelSettings`. The document runner passes its role's instructions_ref
with every model call; the gateway honors the override for that role's
calls while tier mapping, budgets, retries, and recordCall stay unchanged.
Route exactly one role — `hr.detector_evasion.v2` — because it is a
bounded, wording-only rewrite with its own artifact
(`detector_evasion_notes`) and low blast radius. Grounding, evidence-ID
checks, and approval gates are untouched; one role per run and one
instructions_ref per run are preserved.

Also fix `chatCompletions` to fall back to `message.reasoning_content`
when `content` is empty, since Nemotron reasoning models may return their
answer there; otherwise the pipeline would see empty text and fail with
SCHEMA_INVALID.

Consequence: no role is routed by default. The user connects Nebius in
Models (provider `openai-compatible` + Token Factory base URL + API key)
and sets the override; until then behavior is identical to Slice 13.

## ADR-019 User-defined custom providers

Status: Accepted

Context: the Models screen had one static "Custom" slot, so a second
OpenAI-compatible endpoint (Nebius plus OpenRouter, or a lab server) had
nowhere to live. ADR-016's provider enum cannot grow per user, and the
chat panel had no provider choice at all.

Decision: user-defined custom providers are first-class records in
`ModelSettings.custom_providers` (id/label/https base_url/model_id), each
with its own encrypted vault credential under `model:custom:<id>`. Tiers
and `role_models` reference providers by id string; unknown ids fail with
HTTP 400 on write (owner-aware validation in
`DomainService.assertKnownProviders`) instead of failing Zod shape checks
first. `custom_providers` is excluded from the public `PUT
/api/preferences` input — records are created only through
`POST /api/models/custom/connect`, which also stores the key, so a record
can never exist without its credential. Deletion is guarded: 409 while a
tier or role override references the id, 404 for unknown ids. The gateway
routes custom ids through the existing OpenAI-compatible
chat-completions transport with the provider's own base URL and vault
key, and records per-provider usage attribution (id/label/calls/last-used)
alongside the tier budgets. Chat selection is a per-run agent-context
override (`openapply.chat_provider_override`), resolved server-side
through the vault in `ConversationAgent`; it never writes preferences and
resets when the chat thread changes. OAuth-backed providers
(ChatGPT/Grok) are rejected for chat — no TanStack streaming transport
exists for their proprietary protocols — while they keep working through
the gateway pipeline.

Consequence: no limit on custom providers; the legacy single "custom"
slot stays for backwards compatibility. Nothing routes anywhere until
the user connects providers and selects them.

## ADR-020 Upstream merge, September 2026 (14 of 18 commits)

Status: Accepted

Context: upstream OpenMuse `main` moved 18 commits past our fork pin
`f5534c7` (2026-09-24). None touch OpenApply's provider core
(`gateway.ts`, `models.ts`, the `openapply.ts` domain), so Slices 14/15 are
conflict-free. The adopt/skip call was made on long-term product merit,
not hackathon scoping: the aim is fewer hassles, fewer workarounds, and
less manual work over time.

Decision: hand-apply 14 commits; skip 4.

Adopted:

- #86 Render deploy blueprint — adapted to `render.yaml` with OpenApply
  names (`openapply-api`, `openapply-web`, `openapply-browser`,
  `DATA_DIR=/var/data/openapply`, `OPENAPPLY_ACCESS_KEY`); not copied
  blindly. README gains a matching "Deploy on Render" section.
- #92 Scheme-less worker URL — `browserWorkerUrl()` accepts bare
  `host:port`, so `BROWSER_WORKER_URL=127.0.0.1:8790` works; `readConfig`
  uses it and warns on failure.
- #18 Provider retries — `MODEL_MAX_RETRIES = 2` on every TanStack adapter
  call (5 spots, including the explicit-vault-credential auth path: the
  same bounded transient-only retry, since 400/401/403 still fail fast and
  the retry only replays the failed model call, never committed tool work).
- #65 Step-limit note — `stepLimitNote` option and exported
  `reportStepLimit()`; a run that hits the step cap now reports a
  continuation note instead of stopping silently.
- #57 Shadowed-env warning — `shadowedEnvKeys()` lists file-config keys
  the process environment overrides, surfaced at startup.
- #55 Provider identity — exported `unknownProvider()` replaces the
  inline "Unknown provider" throw; `.env.example` documents the
  `openai/` prefix rule for gateway model IDs.
- #56 Empty-string rendering — `!!` coercion at the five upstream
  `{error && ...}` / `{result && ...}` sites, plus the same bug class in
  local-only `thread-artifacts.tsx` (adaptation).
- #41 Monitor-state rework — pause-after-commit only (reconcile commits
  the monitor `paused` status after the failure outcome lands),
  `resumingMonitor` fencing on resume/retry, `lastHash` from
  `task.state.lastHash` with fallback to the monitor record, and the
  error-clearing CAS on resume/retry that fences out stale failure
  reconciles.
- #60 Failure streaks — `failureStreak` in task state; each streak of
  failures gets its own alerts after a resume (notification key now
  `watch-error:<taskId>:<streak>:<retry|paused>`).
- #64 Browser-offline probe — `BrowserService.reachable()` probes the
  configured worker's `/health` (15s promise cache, injectable clock);
  the workspace route maps a non-answering configured browser connection
  to `"unavailable"` instead of showing it ready. The per-browser
  reachability variant from the PR discussion was not adopted — the
  merged commit probes the configured worker.
- #37 Prepared-action replay guard — `prepare()` returns a succeeded
  proposal directly (409 on reviewed-but-terminal states), emits the
  approval event only when `awaiting_review`; the model worker returns
  the receipt without reopening approval when the action already
  succeeded.
- #29 Evidence identity — browser-read evidence gets `id: randomUUID()`
  while the session stays keyed on `sessionId`.
- #52 Run records — the "runs" row is written inside the run (correct
  `startedAt`) instead of before it, so a failed start no longer leaves
  a phantom running row.
- #51 Text reply — `TEXT_MESSAGE_CHUNK` also feeds the run text, so a
  model that streams chunk events instead of content events no longer
  yields an empty reply.

Skipped:

- #42 Jev generative UI — product decision, deferred. 4,446 lines plus a
  new TypeSafe dependency, ~2.4MB demo binaries, and the heaviest
  conflicts (conversation.ts, tanstack-agent.ts, agent.ts, chat.tsx).
  Revisit after the hackathon submission; nothing else in this merge
  depends on it.
- Windows test skip, example.com test hardening, composer focus CSS —
  no product value for OpenApply.

Retry-layer interaction (#18 vs gateway): the gateway's 429/503 retry
(3 attempts, `dispatchWithAuthRetry`) and the TanStack `MODEL_MAX_RETRIES`
(2) are separate layers on separate call paths — gateway `complete()`
serves the document pipeline; the TanStack adapters serve chat/agent
runs. Both are bounded; both fail fast on 400/401/403; retries replay
only the failed model call, never committed tool work (test-pinned).
No retry storm. (Also noted in RUNBOOK "Provider outage".)

Consequence: the fork pin stays at `f5534c7` until this merge is
committed — the tree is a selective hand-merge, not upstream HEAD.
`live-env.sh` keeps its exact contents (demo phase, not published); it
is `.gitignore`d only, never modified, rotated, or deleted.

## ADR-021 Remove the detector-evasion pass; keep Nemotron routing for a legitimate role

Status: Accepted (2026-10-01)

Context: ADR-015 accepted a detector-evasion wording pass
(`hr.detector_evasion.v2`) aimed at commercial AI-writing detectors. A
five-agent review panel (system reviewer, AI expert, job-market researcher,
job-seeker persona, hiring manager) converged on 2026-09-30: the pass's
"no new facts" rule was prompt-based rather than mechanical (a rewrite can
drift from "assisted" to "drove" to "led"), detector avoidance has
speculative upside but severe trust and factual-integrity risk, and the
feature's framing itself reads as deceptive to hiring managers. The
Nemotron/Nebius integration (Slice 14) had been built around this role, but
the routing mechanism itself — per-`instructions_ref` `role_models`
overrides — is product-valuable independent of the evasion target.

Decision:
- Remove `hr.detector_evasion.v2` entirely: pipeline stage, `runDetectorEvasion`,
  `evasionOutputSchema`, the `detector_evasion_notes` artifact kind, the
  pack-approval gate, the prompt file, the runner registry entry, tests, and
  fixtures. This supersedes ADR-015.
- Keep the general `role_models` routing and the `reasoning_content`
  fallback. Repoint the recommended Nemotron override to `hr.review.v2` —
  the evidence-grounding quality review is a legitimate role for a
  reasoning model and has the smallest blast radius of the document roles.
- Harden the `reasoning_content` fallback: every fire emits a structured
  `reasoning_content_fallback` server log (role, provider, model) and
  increments a `reasoning_fallbacks` counter on the `gateway_provider_usage`
  record, so a reasoning trace can never silently ship as a final answer.

Consequence: pack approval now succeeds on an HR-reviewed pack with no
evasion artifact. Nothing is routed to Nemotron by default; the override
must still be set explicitly after a real Nebius provider is connected.
