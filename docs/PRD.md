# Product requirements document

Version: 1.2  
Status: Approved  
Product: OpenApply

## 1. Problem

Job search is split across boards, ATS pages, resumes, cover letters, and follow-up. Generic AI copy is easy to reject. Autonomous apply bots violate major board terms and hide what was sent.

## 2. Solution

OpenApply is a single-owner local app, forked from OpenMuse, that:

- stores a confirmed candidate profile, including resume and supporting evidence
- discovers jobs from public ATS feeds on a user-defined schedule
- optionally extracts jobs from a user-started Chromium session
- drafts tailored resume, cover letter, and statement materials with specialist agents
- runs an HR authenticity review
- requires human approval before final materials and before submit
- prefills forms in a persistent Chromium profile
- tracks state and notifies via in-app inbox, email, and Telegram

## 3. Personas

- Active seeker: intern through senior, multi-country, has a resume or export.
- Career switcher: needs grounding so the system cannot invent experience.
- Operator: same human in v1; starts scans, approves packs, takes the browser.

## 4. In scope (v1)

- OpenMuse chassis: API, durable tasks, reviews, files, Chromium worker, Google OAuth, in-app notifications.
- Preferences including scan interval 6–24 hours, default 12.
- Profile ingest from notes, resume upload, LinkedIn export, certificates, transcripts, licenses, awards, portfolios, publications, recommendations, and prior statements.
- Public ATS: Greenhouse and Lever required; Ashby if time.
- Optional public-page read via Jina-style adapter for company briefs.
- Job cards and detail pages with official source and apply URLs.
- Resume, cover, and statement specialists; prompt tools T1–T10 as named tools. Drafts lean on the evidence locker.
- HR authenticity reviewer: every claim checked against confirmed evidence; blockers stop the pack.
- Versioned artifacts and packs.
- Supervised Chromium apply on supported pages.
- User-started browser hunts for LinkedIn, Indeed, and one government class.
- Tracker: manual status first; Gmail-assisted later in v1 if time.
- Notifications: in-app, Telegram official bot, Gmail.
- Models: API keys for OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and OpenAI-compatible base URLs. Account connect for ChatGPT (OpenAI OAuth), Grok (xAI OAuth), and other providers behind the same gateway.
- Audit log.

## 5. Out of scope (v1)

- OpenMuse Linux computer
- WhatsApp
- Ideas, finance, generic life goals
- Firefox
- Job-site password storage
- Headless logged-in LinkedIn/Indeed crawling on a timer
- Paid application checkout
- Autonomous CAPTCHA solving
- Multi-tenant SaaS
- CopilotKit Intelligence as a required dependency
- OpenMausBot as chassis
- Agent-Reach as a required runtime
- Boss直聘 recruiter greeting / auto-apply CLIs

## 6. User stories

1. I upload a PDF and confirm extracted facts before they become memory.
2. I upload certificates and other proof, confirm them, and later drafts use those details.
3. I add voice samples so drafts can match how I write.
4. I connect ChatGPT, Grok, or another LLM, or I paste an API key.
5. I set scan cadence and receive public ATS jobs without chatting.
6. I click a card and see requirements, rank reasons, company brief, and official links.
7. I start a visible LinkedIn or Indeed hunt and stored jobs keep `source` accurate.
8. I shortlist a job and receive resume, cover, statement when needed, and an HR critique grounded in my facts and certificates.
9. I reject any claim that is not in my profile or evidence locker.
10. Approved prose has been through HR review and still contains only my facts.
11. I log in myself when the browser session is cold.
12. The system never submits until I approve.
13. I can take the browser at any point.
14. I get Telegram and inbox events when a pack is waiting or a scan finished.

## 7. Functional requirements

- FR-1 Preferences constrain Hunter and Ranker.
- FR-2 Scan interval is an integer, 6–24, default 12.
- FR-3 Public ATS hunter may run unattended while the app is up.
- FR-4 Logged-in board access requires a user-approved browser session.
- FR-5 Job detail always shows `source_url` and `apply_url` when known.
- FR-6 Master resume is immutable.
- FR-7 Memory writer commits only after explicit confirm.
- FR-8 Resume agent cannot access Google tokens or `WORKER_TOKEN`.
- FR-9 Submit waiter is a no-op without approval.
- FR-10 Unexpected portal file requests pause the workflow.
- FR-11 HR reviewer refuses ungrounded metrics and ungrounded credentials.
- FR-12 Model keys and OAuth tokens never enter agent prompts.
- FR-13 Notifications do not include full resume text or certificate images by default.
- FR-14 Audit events are append-only.
- FR-15 Job descriptions are hostile input (prompt-injection aware).
- FR-16 Drafting roles may cite only confirmed resume facts and confirmed evidence-locker items.
- FR-17 Removed (ADR-021): the detector-evasion pass was removed. HR review
  blockers stop the pack; wording must still change nothing factual.
- FR-18 The user can connect ChatGPT by OAuth, Grok by OAuth, another supported provider, or an API key. Cheap and strong tiers are chosen from connected accounts.
- FR-19 A statement is a first-class artifact when the job or the user asks for one.

## 8. Non-functional requirements

- NFR-1 PGlite allows one API process; split processes require Postgres.
- NFR-2 Data directory and browser profiles are sensitive.
- NFR-3 Configurable max strong-model packs per scan cycle.
- NFR-4 Task leases recover interrupted work.
- NFR-5 Failed model calls do not create approved packs.
- NFR-6 Default bind is localhost.
- NFR-7 Approval-waiting tasks survive process restart.
- NFR-8 Provider OAuth refresh tokens are vaulted and are never sent to the Expo client.

## 9. Acceptance demo

On a clean machine:

1. Connect ChatGPT, Grok, another provider, or an API key. Set preferences and a 12-hour scan.
2. Upload resume and at least one certificate. Confirm memory.
3. Ingest at least one Greenhouse or Lever job.
4. Generate pack, show which evidence was used, show HR notes, approve.
5. Open Chromium, user login if needed, prefill, approve submit on a fixture or user-owned page.
6. Restart API; application state is unchanged.
