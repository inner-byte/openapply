# Browser strategy

Version: 1.1  
Status: Approved

## Worker

Reuse the OpenMuse Playwright Chromium worker:

- persistent profiles
- takeover console
- server-only `WORKER_TOKEN`
- public HTTP(S) destination checks

## Uses

1. Optional public snapshots for company briefs when WebRead is off.
2. User-started hunts on LinkedIn, Indeed, government portals.
3. Apply prefill and supervised submit.

## Non-uses

- Headless 12/24-hour logged-in polling of LinkedIn or Indeed
- Password typing from storage
- Paid CAPTCHA solvers

## Session policy

| Situation | Behavior |
| --- | --- |
| Cold profile | `session_needed` + takeover |
| CAPTCHA, 2FA, popup | `USER_ACTION_REQUIRED` |
| Unexpected origin | Block |
| Apply idle | Default 120 minutes in `prefilled` or `submit_ready` |
| Hunt | User started; extract visible jobs; stop on wall |
| Account-risk page | `ACCOUNT_RISK`, no retry loop |

## Parallel computer isolation

Borrowed from OpenDots' per-Dot computers, adapted to our worker:

- **Per-role credentials.** Every actor uses its own derived worker credential —
  `HMAC-SHA256(WORKER_TOKEN, "openapply-worker:<role>")` — sent with an
  `x-worker-role` header. Roles: `hunter`, `apply`, `chat`, `system`. The worker
  accepts the master token or the matching derived token; the master token
  never leaves the server config.
- **Per-role profiles.** Each role gets its own Chromium profile namespace
  (`chat`, `hunter`, `apply:<host>`, …), so roles never share cookies, logins,
  or storage. The session record keeps the role; worker responses cannot
  clobber it.
- **Snapshot-before-action.** The apply adapter re-reads the page before
  filling fields and before the submit click, so a user takeover mid-flow can
  never leave the agent acting on stale coordinates.

## Required worker extensions

- File chooser from pack paths
- Configurable idle timeout by session class
- Named profiles per origin
- UI disclosure of worker limits (no popups, dialogs, websockets, no JS eval)

Pages that need popups or websockets are `needs_takeover_only`.

## Optional WebRead

Public URL → Markdown via Jina-style adapter. Output is `job_snapshot` or `company_brief`, never a submit.

## Settings copy

Automated use of LinkedIn, Indeed, and some government sites can restrict accounts even when the user is present. Submit stays gated. Account safety is not guaranteed.
