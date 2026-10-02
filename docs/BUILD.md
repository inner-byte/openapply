# Implementation slices

Version: 1.2  
Status: Approved

Execute in order.

## Slice 1 — Fork and strip

Clone OpenMuse. Rename to OpenApply. Hide Ideas, Finance, Computer, generic Goals. Disable computer compose. Keep tasks, reviews, files, browser, Google.

Exit: web and API boot.

## Slice 2 — Domain and files

Migrations for `DOMAIN.md`. File inbox. Activity shows domain events.

Exit: manual `JobPosting` and `Artifact` insert works.

## Slice 3 — Settings and gateway

Preferences including `scan_interval_hours`. Vaulted API keys. ChatGPT OAuth, Grok OAuth, and other provider connects on the same gateway. Cheap/strong smoke test.

## Slice 4 — Profile ingest

Upload resume, certificates, and other evidence. Intake, confirm UI, `memory_writer`. Evidence is not promoted until confirm.

## Slice 5 — ATS hunter and Jobs UI

Greenhouse + Lever. Scheduler. Cards, detail, official links.

## Slice 6 — Ranker and notify

Scores. In-app + Telegram.

## Slice 7 — Resume, cover, packer

T1–T10 versioned prompts in `docs/agents/prompts/`. Statement when required. Drafts cite the evidence locker. One job per run. Pack folder.

## Slice 8 — HR reviewer and approvals

Findings. Blockers block pack approve. Diff UI shows evidence used. (The detector-evasion pass was removed — see ADR-021.)

## Slice 9 — Supervised apply

`session_usher`, prefill, `submit_waiter`, manifest attach, 120-minute idle.

## Slice 10 — Browser hunter

User-started extract. `source=linkedin|indeed|government`.

## Slice 11 — Tracker

Manual states first. Gmail heuristics second.

## Slice 12 — Hardening

Isolation tests, cost caps, backup notes.

## Slice 13 — Orchestrator

Central orchestrator modeled on a parent agent: dispatches one specialist
subagent per run (one role per run), watches run states
(queued → running → done/failed), emits state updates as runs progress.
Owns the application state machine (ranked → pack workflow → notify);
the hunter scheduler becomes one of its ticks; the document pipeline
becomes an orchestrated workflow, not a route-triggered function.
Hard gates: no submit path, no 24/7 logged-in browser, cost caps per cycle.

## Slice 14 — Nebius/Nemotron integration

Nebius x NVIDIA Global AI Hackathon (Personal AI track). Route exactly one
document-pipeline role to a Nemotron model served on Nebius Token Factory,
via a per-`instructions_ref` model override (`role_models` in
`ModelSettings`). Transport fix: `chatCompletions` falls back to
`message.reasoning_content` when `content` is empty (Nemotron reasoning
models). One role per run and one `instructions_ref` per run are unchanged;
nothing is routed by default until the user connects the provider and sets
an override in Settings.

Exit: `hr.review.v2` calls reach a Nemotron model on Nebius in a
live run; gateway, runner, and docs tests pass.

## Slice 15 — User-defined custom providers

Custom/OpenAI-compatible providers are user-created records, not a single
static slot: the user can add any number (Nebius Token Factory, OpenRouter,
a lab server). Each custom provider has its own id (`custom_<slug>_<rand>`),
label, https base URL, model id, and encrypted vault credential
(`model:custom:<id>`); keys never leave the server (`GET /api/models`
returns records only).

Provider selection is switchable in both places: the Models screen tier
selectors list every connected built-in and custom provider, and the chat
panel carries a per-session override (`openapply.chat_provider_override`
agent context) that only affects that chat session's runs — tier settings
are never written by chat, and the choice resets when the thread changes.
The gateway routes custom ids through the existing OpenAI-compatible
chat-completions transport with the provider's own base URL and vault key,
recording per-provider usage attribution (id/label/calls/last-used)
alongside the tier budgets. Deleting a custom provider is blocked (409)
while a tier or role override references it; unknown ids are 404 on
disconnect and 400 in preferences; `custom_providers` cannot be written
through `PUT /api/preferences`. Base URLs must be https. Account sign-in
providers (ChatGPT/Grok) are rejected for chat — no TanStack streaming
transport exists for their proprietary protocols — while they keep working
through the gateway pipeline.

Exit: two custom providers connect with distinct vault credentials;
cheap tier routes to a custom URL with its key; referenced deletion 409 /
unreferenced 200 with credential cleanup; role override routes to the
custom endpoint; chat selection resolves per-run without touching tiers;
313/313 tests pass (16 new); root + mobile tsc clean; biome clean.

## Slice 16 — Applications dashboard

A read model over applications + jobs + scores + transition events, built
from a five-persona design debate (system reviewer, AI expert, job-market
researcher, job-seeker persona, hiring manager).

- `GET /api/applications/dashboard` returns KPIs (Active, Awaiting reply,
  Interviews, Applied vs Walked-away), cards ordered by cost-of-ignoring
  (submit_ready first, then days-in-state), and per-employer aggregates.
- Buckets for sorting, states for truth: the 16-state machine collapses
  into needs_you / waiting_on_them / interviews / closed / fresh, but the
  detail view exposes the real state and its append-only transition log.
- Every state change goes through `transitionApplication`
  (`apps/server/src/transitions.ts`): stamps `state_entered_at`, appends an
  `application.state_changed` event with actor (`user` | `system` |
  `tracker`), and refuses to leave terminal states (`closed_won`,
  `closed_lost`, `withdrawn`). `ghosted` is a real state but not terminal —
  a late reply can still move it.
- Legitimacy marker (verified / likely / unknown) with stated checks, never
  a black box. No match score on the card face; one mechanically-sourced
  evidence line (the ranker's deterministic reasons, exclusion reasons
  filtered out) plus a Worth-It verdict (worth_it / marginal / skip) with a
  one-line reason.
- Stall semantics per state ("Review decaying", "No employer signal").
  Tracker-inferred transitions are flagged so the client separates them
  from confirmed ones. Human vs auto-ack reply classification.
- Ghost rule: `POST /api/applications/check-ghosting` marks
  submitted/awaiting_reply applications silent for `ghosted_after_days`
  (default 21, configurable in preferences). A recent auto-ack resets the
  silence clock.
- Cost ledger per card: approvals + transitions, so effort is visible.

Exit: 361/361 tests pass; root + mobile tsc clean; biome clean; desktop +
mobile screenshots verified.

## Slice 17 — Final product slice (user bank, onboarding, CV builder, adaptive CV)

From a second five-persona debate; the panel's recommendations were
authorized as the implementation decision.

- **Versioned Profile/Preferences**: `Profile.version`, `StoredPreferences.version`
  (bumped on every write). New preference fields: `qualification_level`
  (`none_manual` | `vocational` | `graduate` | `postgraduate` |
  `experienced_professional`), `avatar`, `onboarding_completed`,
  `ghosted_after_days` (default 21).
- **Onboarding** (`apps/mobile/src/onboarding.tsx`): promise-first, three
  questions (name, countries, target work + qualification level). "OpenApply
  never applies without your word." / "No CV needed to start." Skippable;
  the rest lives in Settings. Shown on first run via `onboarding_completed`.
- **Avatars** (`apps/mobile/src/avatars.tsx`): 8 abstract OpenApply-owned SVG
  marks, no fake human faces. Stored server-side in preferences; picker in
  onboarding and Settings. `Mascot`'s dead `variant` prop now renders the
  chosen mark.
- **CV interview builder** (`apps/server/src/cv-interview.ts`,
  `apps/server/src/cv-routes.ts`, `apps/mobile/src/cv-interview.tsx`):
  deterministic question bank (no LLM-generated questions), every answer a
  quoted triple (statement, confirmed, asked_at). Completeness-gated
  sign-off; contradictions quarantined until resolved; drafting blocks on
  quarantine. Fidelity: never upgrades titles, one concrete detail per role.
- **Adaptive CV** (`apps/server/src/adaptive-cv.ts`): rule-based template
  selection from an explicit feature table (industry × seniority × channel),
  one-line human reason, every selection logged as `cv.template_selected`.
  Mutation surface enumerated (section order, bullets-per-role, evidence
  prominence); anything else throws. The outcome-optimized learning loop is
  dead — the coaching view (`GET /api/cv/coaching`) is descriptive only,
  ghosted outcomes censored, n<5 returns insufficient_data, read-only.
- **Chat progress** (`apps/mobile/src/chat-progress-state.ts`,
  `apps/mobile/src/chat-progress.tsx`): slim state-derived status line, no
  fake percentages, distinct non-animated "waiting for you" state,
  run-ID failures, "nothing is sent without your approval" reminder.
- **Reviewer fixes** (backend/client/infra audits): terminal-state
  immutability in `transitionApplication`; all pack-pipeline writes stamp
  `state_entered_at` and emit `application.state_changed`; receipt guard
  checks the mail body; Worth-It filters exclusion reasons; ghost clock
  respects auto-acks; `close_reason` written on terminal marks; password
  fields refused server-side in prefill.

Exit: full test suite green; root + mobile tsc clean; biome clean;
desktop + mobile screenshots verified.
