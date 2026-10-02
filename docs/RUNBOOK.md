# Runbook

Version: 1.2  
Status: Approved

## Boot

```bash
pnpm install --frozen-lockfile
cp .env.example .env
# set access key, encryption key, model keys
pnpm dev
pnpm dev:web
pnpm dev:browser
```

Confirm `/api/health`.

## Domain API (slice 2)

- `POST /api/jobs` — insert a job posting (`source`, `source_url`, `company_name`, `title`, ...).
  Dedupes on `content_hash` (computed when absent); a duplicate returns 200 with the existing posting.
- `GET /api/jobs`, `GET /api/jobs/:id` — list / detail. Detail returns `source_url` when stored.
- `POST /api/inbox` — multipart upload (field `file`). Accepts pdf, docx, txt, md, png, jpg,
  jpeg, webp, zip; 10 MB max; executables rejected. Raw bytes land under `$DATA_DIR/inbox/`
  and a `source_upload` artifact is registered.
- `GET /api/inbox` — list uploaded artifacts.
- `GET /api/events` — list domain events.

Domain events (`job.discovered`, `artifact.uploaded`) are mirrored into the Activity feed.

## Profile ingest (slice 4)

- `POST /api/profile/upload` — multipart upload (fields `file`, `kind`). `kind` is one of
  `resume`, `certificate`, `transcript`, `license`, `award`, `portfolio`, `publication`,
  `recommendation`, `prior_statement`, `voice_sample`. The MIME type is sniffed from magic
  bytes, never trusted from the extension. Accepted: pdf, docx, txt, md, png, jpg, jpeg,
  webp, zip; 10 MB max. The first `resume` (confirmed or still pending) becomes the
  immutable master resume; later resumes are stored as `resume` and never replace it.
- Text extraction (`apps/server/src/extract.ts`) is a layered pipeline, deterministic
  tools first: pdf via `pdftotext` per page (poppler; `pdfjs-dist` pure-JS fallback),
  docx via `word/document.xml` parse, plain text via utf-8 decode. A PDF page with
  almost no native text but an embedded image is treated as a scan: the page is
  rendered with `pdftoppm` and OCRed by the cheap-tier vision model through the
  gateway, then by `tesseract` if installed. Images (png/jpg/webp) go through the
  same OCR fallback. OCR text is flagged `ocr: true` so downstream specialists cite
  it cautiously. Pages no tool can read are reported `readable: false` with a
  warning instead of a silent empty string — the UI shows these warnings on the
  evidence item. Extraction never throws for malformed input. Recommended server
  packages: `poppler-utils` (pdftotext, pdfinfo, pdfimages, pdftoppm); optional
  `tesseract-ocr` as a local OCR fallback. Without a vision-capable cheap model,
  scanned content stays unreadable and the UI says so.
- Intake pulls contact facts from the extracted text into a `ProfileDraft`. Nothing
  is promoted yet.
- `GET /api/profile` — master resume id, evidence items, the pending draft, confirmed memory.
- `POST /api/profile/facts` — add a draft fact (`field`, `value`, `evidence_id`).
- `DELETE /api/profile/facts/:id` — forget a draft fact.
- `POST /api/profile/confirm` — promote the draft: evidence becomes confirmed, the master
  resume is bound, and `memory_writer` writes the confirmed facts. Refuses when there is no
  draft. `memory_writer` refuses any fact that is not confirmed.
- `DELETE /api/profile/evidence/:id` — forget an evidence item and its bytes. The master
  resume cannot be forgotten.

## Document Foundry (template gallery, phase 1)

- Lives in `apps/server/src/foundry/`: `model.ts` (content model + `TEMPLATES` gallery +
  per-template budgets), `sanitize.ts` (validation, budget enforcement, Typst escaping),
  `render.ts` (Typst compile + `pdftoppm` page previews), `templates/*.typ` (locked designs),
  `fixtures/demo-resume.json` (synthetic demo content — not real user data).
- The agent writes ONLY the JSON content model. It never writes `.typ`. Locked templates
  render it. Seven styles ship: `template-one` Classic Cream (the approved reference design),
  `template-two` Modern Accent, `template-three` Compact, `template-four` Executive,
  `template-five` Minimal, `template-six` Corporate Grid, `template-seven` ATS Classic.

Cover letters (`templates/cover.typ`) and statements (`templates/statement.typ`)
use one locked layout each, styled by per-template tokens (`DOC_TOKENS` in
`model.ts`: font, accent, header alignment, rule style, optional page
background and name color) — every letter and statement visually matches the
user's chosen resume template. Content budgets: cover ≤ 5 paragraphs
(≤ 1200 chars each), statement ≤ 8 paragraphs (≤ 1200 chars each); overflow
throws a cut-list, same as resumes.

DOCX mirror (`docx.ts` + `docx_render.py`, python-docx): the same sanitized
JSON + tokens render to `.docx` for all 7 templates (resume, cover, letter
and statement). Typst escapes are reversed on the DOCX path (`forDocx`),
since `\@`-style escapes are Typst-only. DOCX previews come from the real
bytes: LibreOffice headless converts the generated `.docx` to PDF, then
`pdftoppm` rasterizes pages — the same "preview from the original source"
rule as PDF. The original `.docx` stays downloadable.
- Budgets (`TEMPLATE_BUDGETS`) keep pages uncrowded: overflow throws `FoundryError` with a
  cut-list so the agent revises instead of silently shrinking type.
- Previews are rendered FROM the generated PDF bytes (`pdftoppm`), the same bytes the user
  downloads — never a mockup.
- Invariants in `tests/foundry.test.ts`: Typst injection escaping, budget cut-list,
  unknown-template rejection, PDF+preview render.
- Optional-field compatibility (production fix 2026-09-26): the doc-runner
  schemas allow empty education `location`/`dates`, but the Foundry's strict
  `clean()` rejected them. `cleanOptional()` in `sanitize.ts` now maps
  absent/blank to `""` (nothing invented; templates render nothing) while
  still stripping control characters and enforcing max length on real
  values. Regression test: "empty education location/dates sanitize to
  empty, nothing invented".
- System dependency: Typst binary (`TYPST_BIN` env; default
  `~/workspace/.local-bin/typst-x86_64-unknown-linux-musl/typst`). Install from the
  official GitHub release; `poppler-utils` already covers `pdftoppm`.

## Packer + pack review (Document Foundry implementation stage)

- `apps/server/src/foundry/packer.ts` — `buildPack()`: renders resume (+ cover /
  statement when supplied) through the Foundry, stores the real PDF/DOCX bytes
  under `dataDir/packs/<packId>/`, rasterizes page previews FROM those bytes
  (PDF via `pdftoppm`; DOCX via LibreOffice headless → PDF → `pdftoppm`),
  registers `resume_final_candidate` / `cover_final_candidate` /
  `statement_final_candidate` + `pack_manifest` domain artifacts, moves the
  application to `pack_review`, records `pack.built`.
- Format is a decision-time option per document (`formats: { resume: "docx" }`);
  default is PDF everywhere. Content JSON stays format-agnostic.
- Routes (`apps/server/src/packs.ts`): `POST /api/packs`, `GET /api/packs`,
  `GET /api/packs/:id`, signed `…/previews/:docId/pN.png`,
  signed `…/documents/:docId/content` (the original file for download),
  `POST /api/packs/:id/approve` (writes `Approval(target=pack)` — the gate for
  Slice 9 submit), `POST /api/packs/:id/request-changes` (back to
  `pack_drafting` with the user's note). Preview/content URLs are HMAC-signed
  and listed in the signed-route allowlist in `app.ts`.
- Mobile (`apps/mobile/src/pack-review.tsx`): Apps tab → Packs list → review
  sheet with document tabs, clean page previews, "Page X of Y", previous/next,
  "Open PDF/DOCX" for the original file, Request changes (notes) / Approve
  pack. Nothing submits anywhere from this screen.

## ATS hunter + Jobs UI (slice 5)

- `apps/server/src/hunter/ats.ts` — public fetchers for Greenhouse
  (`boards-api.greenhouse.io/v1/boards/<token>/jobs`) and Lever
  (`api.lever.co/v0/postings/<site>`). Laws enforced: only those two hosts over
  HTTPS are fetchable (`assertAllowlistedUrl`); packets carrying
  `browser_profile_key` are rejected (unattended scans are public ATS only);
  job HTML is hostile input and is stripped to inert plain text (`htmlToText`).
- Board refs live in preferences as `ats_boards`, e.g.
  `greenhouse:stripe:Stripe` or `lever:netflix`. Empty by default — no boards,
  no scans.
- `apps/server/src/hunter/scheduler.ts` — `HunterScheduler` ticks every
  15 min and scans each owner at most once per `scan_interval_hours` (6–24h;
  state in `hunter_state`). Started in the API process only (`index.ts`); the
  standalone task worker (`worker-entry.ts`) does not run it. Manual trigger:
  `POST /api/hunter/scan`; state: `GET /api/hunter/state`.
- Dedup is `(source, external_id)` with `content_hash` fallback
  (`insertJobPosting` refreshes re-seen postings in place; only genuinely new
  postings emit `job.discovered`). Each scan records `hunter.scan_completed`.
- Mobile (`apps/mobile/src/jobs.tsx`): Jobs tab → job cards (title, company,
  location, source chip) → detail sheet with full description, requirements,
  qualifications, and official links (`source_url` always shown; `apply_url`
  when present). Boards are configured in Settings.

## Design decisions

### Orchestrator (Slice 13 — built 2026-09-26, per Ahmad's go-ahead)

`apps/server/src/orchestrator/`: `runs.ts` (run registry:
`agent_runs` records, queued → running → done/failed, illegal
transitions rejected) and `orchestrator.ts` (the `Orchestrator` class).

- **Dispatch**: `runSpecialist(owner, {role, instructions_ref,
  application_id?}, fn)` is the single dispatch point. One role and one
  instructions_ref per run; each transition emits `agent.run_started`,
  `agent.run_completed`, or `agent.run_failed`. Specialist errors are
  recorded on the run AND rethrown.
- **Ticks** (15 min, started in the API process): the hunter tick (due
  owners each get one tracked `hunter_ats` run — the old HunterScheduler
  timer is retired; `scanOwner`/`getState` remain) and the pipeline tick
  (every `ranked` application advances one step). Budget exhaustion stops
  a tick quietly; the next window retries.
- **State machine**: `advanceApplication` moves `ranked` → pack workflow
  (shortlisted → pack_drafting → HR review → pack_review) → in-app +
  Telegram notify. Every other state is left alone: pack approval,
  prefill, and submit stay user-driven.
- **Pipeline as workflow**: `docs/pipeline.ts` takes an optional
  `runRole` hook; the orchestrator passes one that routes resume, cover,
  statement, HR review, and packer each through
  `runSpecialist`. `POST /api/applications/:id/build-pack` now calls
  `orchestrator.buildPackWorkflow`.
- **Routes**: `GET /api/orchestrator/runs`, `GET /api/orchestrator/runs/:id`,
  `GET /api/orchestrator/state`, `POST /api/orchestrator/tick`,
  `POST /api/orchestrator/applications/:id/advance`.
  `POST /api/hunter/scan` now dispatches a tracked hunter run.
- **Hard gates by construction**: the orchestrator exposes no submit
  method; ticks never open browser sessions; cost caps live in the
  gateway.
- **Atomic pack claim** (production fix 2026-09-26): `buildApplicationPack`
  claims the application with a compare-and-swap to `pack_drafting` — ranked
  → pack_drafting, shortlisted → pack_drafting, or takeover of a
  pack_drafting claim older than 30 min (crashed run). Concurrent manual +
  tick builds cannot both proceed; the loser gets 409 "already in
  progress". The claim is released back to `shortlisted` on HR blockers and
  on any failure, so a failed build never wedges the app and never retries
  in a hot loop.
- **Autonomous review updates**: `advanceApplication` notifies the owner on
  all three outcomes — `pack-ready` (pack_review), `hr-blocked` (finding
  count + first issue, app stays shortlisted for evidence + rebuild), and
  `pack-failed` (error message, app back to shortlisted, error rethrown).
  In-app always; Telegram when connected. Notifications name title +
  company only, never prose or secrets.

Tests: `tests/orchestrator.test.ts` 11/11 — run lifecycle + events,
failure recording + rethrow, illegal transitions, every pipeline
specialist tracked as its own run, ranked → pack_review + notify,
non-ranked untouched, no submit path, hunter tick dispatches a tracked
run, concurrent builds (one wins / one 409s / single resume call), stale
claim takeover vs fresh claim protection, hr_blocked notify + shortlisted,
failure notify + shortlisted + rethrow.

### Orchestrator (deferred — Ahmad, 2026-09-25)

Ahmad decided the system needs a central orchestrator modeled on how Meyau
itself works: a parent orchestrator that dispatches one specialist agent per
run (mirroring the docs/AGENTS.md law "one role per run", like one
subagent per task), watches run states (queued → running → done/failed), and
emits state updates as agents run — the same way Meyau reports subagent
progress.

- The orchestrator owns the application state machine and advances work
  autonomously: ranked → build pack → HR review → pack review → notify.
- The existing hunter scheduler becomes one of its ticks; the Slice 7
  document pipeline becomes an orchestrated workflow instead of a
  route-triggered function.
- Hard gates stay with the orchestrator: never submit without
  `Approval(target=submit)`, never run a logged-in browser 24/7, cost caps
  per cycle (`max_strong_model_packs_per_cycle`).
- Target: Slice 12 (hardening) or its own slice, after the Slice 9 demo path
  is complete. Not designed or built before then.

## HR reviewer and approvals (slice 8)

One more specialist run sits between the document drafts and the packer,
emitting Foundry JSON (v2 prompt contract):

- `hr.review.v2` (`apps/server/src/docs/hr-review.ts` → `runHrReview`): the
  HR authenticity reviewer checks every claim against confirmed evidence —
  certificates map to confirmed `EvidenceItem`s, clichés and invented
  metrics fail, and any `severity: "blocker"` finding forces
  `can_approve: false`. Blockers stop the pipeline with findings returned to
  the user (`{status: "hr_blocked", findings}`) — missing evidence produces a
  question, never an invention. The application stays `shortlisted`.

(The detector-evasion wording pass, `hr.detector_evasion.v2`, was removed —
see ADR-021. Its `detector_evasion_notes` artifact kind, pack-approval gate,
prompt, and tests were removed with it.)

Artifacts: `hr_review` (findings + reviewed candidates) with
`application_id`; events `hr.reviewed`.

**Approval gate (TESTING.md invariant):** `POST /api/packs/:id/approve`
approves an HR-reviewed pack and records `Approval(target=pack)`.
Pack approval never submits.

Mobile: the job-sheet "Application pack" section shows HR blocker findings
with their fixes when a build returns `hr_blocked`, so the user knows what
evidence to add.

Fix carried over from Slice 8: `sanitizeCover` treats empty-string
`recipient_name`/`recipient_title` as absent (the content schema defaults
them to `""`).

## Supervised apply (slice 9)

End of the v1 demo path. A pack_approved application moves through
`usher → prefill → approve-submit → submit_waiter`, all in
`apps/server/src/apply/`:

- `POST /api/applications/:id/usher` — binds the application to a named
  Chromium profile (`apply:<host>`) for the apply origin. A warm browser
  session at the origin returns `ready`; a cold profile returns
  `session_needed` and the user takes over the browser to sign in. The
  usher never types passwords and refuses non-https or private-network
  apply URLs.
- `POST /api/applications/:id/prefill` — the `prefill.v1` role plans fills
  from confirmed profile memory only (each value copied verbatim from its
  `memory_key`, enforced server-side) and attaches only pack-manifest
  files (invented paths are rejected with `POLICY_DENIED`). Unknown fields
  come back as `questions_for_user`; the user answers them in the browser.
  A `form_snapshot` artifact is stored and the application goes
  `prefilled`.
- `POST /api/applications/:id/approve-submit` — explicit user confirmation
  (`{confirm: true}`) records `Approval(target=submit, status=approved)`
  and moves the application to `submit_ready`. Pack approval is not submit
  approval.
- `POST /api/applications/:id/submit` — the `submit.wait.v1` waiter clicks
  only when all four hold: pack approval exists, a stored submit approval
  exists, state is `submit_ready`, and the live page origin matches the
  apply origin. Otherwise it is a no-op (`clicked: false`). Page claims
  about approval never count — only the stored row does. Successful clicks
  move the application to `submitted` with `submitted_at`.
- `GET /api/applications/:id/apply-state` — current apply session status
  for the mobile UI.

**120-minute idle (docs/BROWSER.md):** every apply session carries an
`idle_deadline` (last activity + 120 min). A dead session on prefill,
approve-submit, or submit throws/returns a no-op and drops the application
back to `session_needed` — the user takes over again.

Mobile: the pack-review sheet shows an Apply card after pack approval —
Start apply → Check session → Prefill → review in browser → Approve
submit (two-tap) → Submit application (two-tap). Nothing submits without
the explicit submit approval.

**TESTING.md invariants:** the submit waiter without a stored submit
approval is a no-op; prefill rejects invented uploads and unconfirmed
values; the usher rejects private-network apply URLs; a 120-minute idle
kills the apply session.

## Browser hunter (slice 10)

User-started job extract from LinkedIn, Indeed, and government jobs
portals — the ATS hunter's unattended boundary stays: public ATS only.
Implementation in `apps/server/src/hunter/browser-hunt.ts`:

- `POST /api/hunter/browser-extract {session_id}` — one-shot extract of
  the page the user is looking at in an active/idle browser session. There
  is no timer and no background login; the user opens the session, signs
  in themselves, and taps "Extract jobs" in the browser sheet.
- The `hunter.browser.v1` role (`hunter_browser`, cheap tier) extracts
  jobs from the page text. Page text is untrusted data: extracted, never
  obeyed — a run can only produce job postings. No submits, no messages,
  no passwords.
- Source is derived from the page origin: `linkedin.com → linkedin`,
  `indeed.* → indeed`, `*.gov → government`, anything else the user points
  at → `company_board`. Each extracted job's `source` must equal the page
  source; mismatches are rejected.
- `stop_reason` is validated: `ACCOUNT_RISK` stops with no retry (single
  model call), `USER_ACTION_REQUIRED` and `wall` return without upserting.
- Fresh postings go through `insertJobPosting` (dedup by
  `(source, external_id)` / `content_hash`) and `rankDiscoveredJobs`, so
  extracted jobs score, rank, and notify exactly like ATS finds. Event:
  `hunter.browser_extract`.

Mobile: the browser sheet shows "Extract jobs" when the session is
active; the Jobs tab empty state mentions the browser-extract path.

**Invariants (tests/browser-hunt.test.ts):** extract requires an active
user-approved session; account risk stops with no retry; walls and
user-action stops never upsert; page-origin source mismatches are
rejected; hostile page text is extracted, never obeyed; fresh postings
flow into the rank pipeline.

## Tracker (slice 11)

Manual states first. Gmail heuristics second.

- `POST /api/applications/:id/state {state, note?}` — deterministic manual
  mark. Only `submitted`, `awaiting_reply`, `interviewing`, `closed_won`,
  `closed_lost`, `withdrawn` can be set by hand; early pipeline states are
  system-driven and rejected. Terminal states cannot change. Marking
  `submitted` manually is an explicit user mark (counts as evidence).
  Every transition records `application.state_changed` with `actor: "user"`.
  Tracker-inferred transitions carry `inferred: true` and
  `reply_kind: "human" | "auto"` (auto-ack vs real reply); manual marks carry
  `inferred: false`.
- `POST /api/tracker/scan-mail {query?}` — user-started Gmail scan (never
  automatic: no timer, no background login). The `tracker.v1` role
  (`tracker`, cheap tier) maps each message onto
  `{application_id, previous_state, new_state, evidence}`. One role per
  run, one instructions_ref.
- Server guards: mail text is untrusted — mapped, never obeyed (a run can
  only propose state transitions, never sends mail or applies);
  `submitted` requires receipt evidence (confirmation/reference markers);
  terminal states never change; unknown application ids and stale
  previous_states are rejected. Each mail matches at most one application
  by company/title heuristics. Event: `application.state_changed` with
  `actor: tracker`.

Mobile: the job detail sheet shows the application status, "Mark as"
buttons for the trackable states, and a "Scan Gmail for updates" button.

**Invariants (tests/tracker.test.ts):** manual mark to `awaiting_reply`
records the event; manual mark to `submitted` allowed; manual mark to
`pack_review` rejected; terminal states cannot change; interview mail maps
to `interviewing`; rejection mail maps to `closed_lost`; `submitted`
without receipt evidence rejected; receipt evidence accepted; hostile
mail instructions mapped, never obeyed; unmatched mail skips the model;
terminal applications are never matched.

## Document pipeline (slice 7)

- Prompts: the seven resume builders (T1, T2, T5, T6, T7, T9, T10), the cover
  specialist, and the statement specialist are at v2 — their output contract
  is Foundry JSON (`resume_content` / `cover_content` / `statement_content`),
  the exact structure the renderer consumes. T3, T4, T8 stay v1: they are
  interactive tools, not pipeline builders.
- `apps/server/src/docs/runner.ts` — one role per run, one `instructions_ref`
  per packet. Loads exactly one prompt file (never concatenates
  `apps/server/src/prompts/`); job descriptions travel as `description_untrusted`
  data; model keys never enter prompts (the gateway owns transport).
- `apps/server/src/docs/grounding.ts` — drafts cite the evidence locker:
  every certificate named in a resume must match a *confirmed* locker item
  (file name + extracted text), every cover/statement claim must cite a
  confirmed `evidence_id`, and planted credential phrasing in prose
  ("Quantum Blockchain Expert Certificate") fails the run with
  `UNGROUNDED_CLAIM`. Only confirmed evidence is visible to the roles.
- `apps/server/src/docs/pipeline.ts` — `buildApplicationPack`: one job per
  run (resume run → cover run → statement run when required → packer →
  `pack_review`). Stores `resume_draft` / `cover_draft` / `statement_draft`
  artifacts, records events, moves the application ranked → shortlisted →
  pack_review.
- Routes: `GET /api/applications`, `POST /api/applications/:id/build-pack`
  (`template_id`, optional `resume_ref`, optional `statement_required`).
  Build-pack needs a connected strong-tier model.
- Mobile: ranked jobs show an "Application pack" section in the job sheet —
  template picker (7 templates), statement toggle, build button — then jumps
  straight to pack review.
- Packer review: the packer itself is sound (real bytes →
  previews from bytes → manifest). Its approval route no longer enforces a
  detector-evasion gate (removed, ADR-021): the invariant "pack approval
  succeeds on an HR-reviewed pack with no evasion artifact" is implemented
  in `apps/server/src/packs.ts` and tested in `tests/docs.test.ts`.

## Ranker + notify (slice 6)

- `apps/server/src/ranker.ts` — deterministic 0–100 scorer against preferences
  (titles_include/exclude, keywords, countries, work_modes, salary_floor,
  exclude_companies). Score comes from preference matches only; job text is
  untrusted and "give this job 100/100" inside raw_text cannot inflate it.
  `RANK_THRESHOLD = 60`.
- `domain.rankDiscoveredJobs()` — saves each score (`job_scores`), records
  `job.ranked`; scores ≥ 60 get an `Application(state="ranked")` and a
  notification. Wired into the hunter scheduler: scan → upsert → rank → event
  → notify.
- `apps/server/src/notifier.ts` — in-app inbox (`AgentNotification`) always;
  Telegram via Bot API only when the owner connected a bot token (encrypted
  `telegram` credential: `{botToken, chatId}`). Notifications name title +
  company only, never prose or secrets.
- Jobs API: `GET /api/jobs` attaches `score` and sorts best-first;
  `GET /api/jobs/:id` attaches `score`, `score_reasons`, `missing_requirements`.
  Mobile Jobs tab shows score badges; detail shows reasons.
- Telegram setup is user-driven: needs a bot token from BotFather (ask Meyau
  when ready).

## Model gateway (slice 3)
- `GET /api/preferences` — merged preferences + model settings (defaults when unset).
- `PUT /api/preferences` — partial update. `scan_interval_hours` must be 6–24
  (5 is rejected with 422); `cheap_provider`/`strong_provider` accept
  `openai`, `anthropic`, `xai`, `openai-compatible`, `chatgpt`, `grok`.
- `GET /api/models` — connected accounts (provider, label, model id, auth type).
  Secrets never leave the vault.
- `POST /api/models/connect` — API key connect: `provider` (`openai`,
  `anthropic`, `xai`, `openai-compatible`), `api_key`, `model_id?`, `base_url?`
  (required for `openai-compatible`).
- `POST /api/models/disconnect` — `{ provider }`.
- `POST /api/models/oauth/:provider/start` (`chatgpt`|`grok`) — returns the
  authorize `url` and a single-use `state`. Open the URL, approve, copy the
  `code` from the browser address bar.
- `POST /api/models/oauth/:provider/finish` — `{ code, state }` exchanges the
  code and stores the tokens in the vault.
- `POST /api/models/test` — `{ tier: "cheap"|"strong" }` runs a one-word
  completion through the tier's account. Returns `{ ok, text, model_id, usage }`
  or `{ ok: false, error_class, message }` (`NOT_CONFIGURED`, `PROVIDER_ERROR`,
  `BUDGET_EXCEEDED`).

OAuth tokens and API keys are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY`
(`credentials` records `model:<provider>`). The Models screen in Connections
covers the same flows: API key form, account sign-in, tier pickers, budget, test.

## Gemini free-tier quota (live finding 2026-09-26)

- The Gemini free tier is capped at **20 requests/day per project per model**
  (quota id `GenerateRequestsPerDayPerProjectPerModel`, metric
  `generativelanguage.googleapis.com/generate_content_free_tier_requests`).
  Google's live `RESOURCE_EXHAUSTED` detail is the source of truth — the
  exhausted dimension is **per-day**, not per-minute, so no retry pacing can
  recover it; only waiting for the daily reset or switching models helps.
- The cap is **per model**: when `gemini-2.5-flash` was exhausted, switching
  the strong tier to `gemini-2.5-flash-lite` gave a fresh quota and the
  pipeline ran end to end on it. Verify with
  `POST /api/models/test { tier: "strong" }` before burning pack calls.
- Retry storms make this worse: every rejected request still counts against
  the quota. Prefer one verification call over tight retry loops.

## Model output nulls (live finding 2026-09-26)

- `gemini-2.5-flash-lite` emits explicit `null` for unknown optional fields
  (e.g. `recipient_title`); `gemini-2.5-flash` omits them. Zod `.optional()`
  and `.default()` do not accept `null`, so this failed HR-review and packer
  validation with "expected string, received null".
- Fix: `apps/server/src/docs/schemas.ts` normalizes null to undefined via
  `optString()` / `optStringDefault("")` preprocessors on every optional
  string in the doc-runner output schemas. No data is invented; null becomes
  absent/empty per each field's existing convention.
- Regression test: "explicit null optionals normalize instead of failing
  (flash-lite emits nulls)" in `tests/docs.test.ts`.

## Migrations

`apps/server/src/db.ts` runs ordered migrations tracked in `schema_migrations`.
`001_job_postings_dedup` enforces the `content_hash` dedup invariant with a partial unique index.
Add new migrations at the end of the list; never edit an applied one.

## Data

Treat `DATA_DIR` as sensitive. Back up directory and database together.

## PGlite

One API process only.

## Stuck approval

User can return days later. UI loads artifacts from disk.

## Cold browser

State is `session_needed`. User takeover, login, resume.

## Provider outage

Runs fail `PROVIDER_ERROR`. Packs stay unapproved.

Transient 429/503 from a provider is retried with exponential backoff (3 attempts,
4s/8s) inside the gateway before the run fails — added 2026-09-26 after the live
Gemini key hit rate limits mid-pack. Anything else fails fast so bad requests
never burn quota on retries. (tests/models.test.ts: "gateway retries transient
429/503 then succeeds", "gateway gives up after three transient failures".)

A second, separate retry layer exists for chat/agent runs: the TanStack
adapters retry transient model failures up to `MODEL_MAX_RETRIES` (2,
`apps/server/src/config.ts`), failing fast on 400/401/403. It sits on a
different call path than the gateway (gateway `complete()` serves the
document pipeline; the adapters serve chat/agent runs), so the two layers
never stack on the same call. Both replay only the failed model call —
never committed tool work — and both are bounded, so there is no retry
storm.

## Board restriction

Disable that source in Settings. Keep ATS hunter running.

## Browser worker extensions (live check 2026-09-26)

Implemented in `apps/worker/src/browser.ts`, `server.ts`, `index.ts`
(server: `apps/server/src/browser.ts`; mobile: `apply.tsx`, `details.tsx`):

- **Named profiles:** origin-scoped keys like `apply:example.com`; one
  profile per origin, reusable across session UUIDs; concurrent use of one
  profile returns `409 PROFILE_IN_USE`.
- **Session idle classes:** apply 120 min, hunt 60 min, manager/default
  30 min; explicit override 5–720 min.
- **File chooser:** 1–5 files from a real `input[type=file]`, contained in
  the pack directory (traversal rejected); PDF/DOC/DOCX/TXT/PNG/JPG only;
  empty and >25 MiB files rejected.
- **Submit endpoint:** constrained submit-control click; reports
  `SUBMIT_NOT_FOUND` instead of clicking blindly; implicit `<button>`
  inside a form counts as a submit control.
- **Fill:** worker accepts the server's `{action:"fill", field, value}` shape.
- **PDF downloads:** direct PDF navigations open Chromium's built-in viewer
  (no download event), so the worker intercepts document navigations to
  `.pdf` URLs at the route layer, fetches the bytes, validates the `%PDF-`
  header, and stores them as downloads (10 MiB and 20-download limits
  enforced). Non-PDF attachments still flow through the download event.
- **SSRF guard:** literal private IPs (including `169.254.169.254`) are
  blocked before proxying, even in trusted-upstream mode.
- **Environment overrides:** `CHROMIUM_EXECUTABLE_PATH`,
  `CHROMIUM_NO_SANDBOX=1`, `WORKER_UPSTREAM_PROXY`,
  `CHROMIUM_IGNORE_CERT_ERRORS=1` (development-only, for TLS-intercepting
  sandboxes).

Live-verified 2026-09-26: real Chromium 152 session, HTTPS navigation,
named apply profile, file attach on Blueimp, fill + submit on HTTPBin,
PDF capture on W3C dummy.pdf. Extension tests 9/9, lifecycle 1/1,
Docker integration 1/1.

Browser UI discloses: popup/dialog, websocket/takeover, and
arbitrary-JavaScript limitations.

## Hardening (slice 12)

**Isolation tests** (`tests/isolation.test.ts`): the gateway's
`CompleteInput` has no tools field, so document roles are structurally
tool-less — the resume specialist cannot call Gmail tools (TESTING.md
mandatory case, now tested). Sequential runs share no chat history; each
run's messages are built fresh from its own payload. One role per run:
the packet carries exactly one role and one instructions_ref, and unknown
refs fail instead of concatenating prompt files. Every prompt file in
`apps/server/src/prompts/` (20+) parses with role/tier/instructions_ref
frontmatter, and every runner-registered ref resolves.

**Cost caps**: the gateway budget governor now covers both tiers.
`max_cheap_model_calls_per_cycle` (default 200) joins
`max_strong_model_packs_per_cycle` (default 5); both count calls per
`scan_interval_hours` window in `gateway_usage` and throw
`BUDGET_EXCEEDED` (429) when exhausted. Cheap and strong budgets are
tracked independently. Tests in `tests/models.test.ts`: cheap cap stops
over-limit calls; independence of the two budgets.

**Backup notes**: `docs/BACKUP.md` — back up `$DATA_DIR` (PGlite files +
`files/` tree) with the server stopped; `TOKEN_ENCRYPTION_KEY` is backed
up once, separately, because every stored credential is undecryptable
without it. Restore verification steps included.

## Nebius/Nemotron integration (slice 14)

- `ModelSettings.role_models` maps an `instructions_ref` to
  `{ provider, model }` (provider validated against the connected-provider
  enum). The document runner passes its role's `instructions_ref` with every
  model call; the gateway routes that role's calls to the override
  provider/model instead of the tier mapping. Nothing is routed by default —
  `role_models` is empty until set in Settings (`PUT /api/preferences`).
- `chatCompletions` falls back to `message.reasoning_content` when
  `message.content` is empty: Nemotron reasoning models on Nebius may return
  the answer there. Without this the pipeline would see empty text and fail
  with `SCHEMA_INVALID`. Transport-only; prompts, schemas, grounding, and
  approval gates are untouched. The fallback is never silent: every fire
  emits a structured `reasoning_content_fallback` server log (role,
  provider, model) and increments a `reasoning_fallbacks` counter on the
  `gateway_provider_usage` record, so a reasoning trace standing in for a
  final answer is visible, not shipped as quiet deliberation.
- Intended routing: `hr.review.v2` → Nemotron on Nebius (evidence-grounding
  quality review; the reviewer blocks unsupported claims, which suits a
  reasoning model, and it has the smallest blast radius of the
  document roles). One-role-per-run and one-instructions_ref-per-run are
  unchanged. (The earlier candidate target, `hr.detector_evasion.v2`, was
  removed — see ADR-021.)
- Connecting Nebius Token Factory later (needs the Builder Program API key):
  1. Models → API key connect: provider `openai-compatible`, base URL from
     the Token Factory dashboard (e.g.
     `https://api.tokenfactory.nebius.com/v1`), model id e.g.
     `nvidia/nemotron-3-nano-30b-a3b`. Model IDs are case-sensitive —
     confirm the exact id in the Token Factory Playground.
  2. `POST /api/models/test { tier: "strong" }` to verify the account.
  3. Set the override: `PUT /api/preferences` with
     `role_models: { "hr.review.v2": { provider: "openai-compatible",
     model: "<confirmed nemotron id>" } }`.
  4. Run one pack build on synthetic data; check the run's `hr_review`
     artifact for the Nemotron `model_id` and the gateway usage record.
     That is the hackathon evidence that a real runtime inference call
     happened.

## User-defined custom providers (slice 15)

The Models screen's "Custom providers" section adds as many
OpenAI-compatible endpoints as you like — this supersedes the single
`openai-compatible` slot from slice 14 for new connections. Each provider
gets its own name, https base URL, API key (encrypted in the vault, never
returned to clients), and model id. "Test connection" lists the endpoint's
`/v1/models` without storing anything. Tier selectors then offer every
connected provider, and the chat panel's Provider picker switches the
model for that chat session only (resets when you switch threads; tier
settings are never touched).

Examples (replace with your own values):
- Nebius Token Factory: base URL e.g.
  `https://api.tokenfactory.nebius.com/v1`, model id e.g.
  `nvidia/nemotron-3-nano-30b-a3b` (case-sensitive — confirm the exact id
  in the Token Factory Playground). Needs the Builder Program API key.
- OpenRouter: base URL `https://openrouter.ai/api/v1`, model id e.g.
  `openai/gpt-5-mini`. Needs an OpenRouter API key.

Deleting a provider is blocked (409) while a tier or a role override
still points at it — repoint it at another provider in Models first. Base
URLs must be https. Account sign-in providers (ChatGPT/Grok) cannot drive
the chat panel yet.
