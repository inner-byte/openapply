# Architecture

Version: 1.2  
Status: Approved

## 1. Style

Modular monolith at the API. Isolated agent runs. Separate Chromium worker. Not a mesh of long-lived chatting agents.

## 2. Context

```text
Seeker UI (localhost Expo web)
        |
        v
OpenApply API (Hono + CopilotKit runtime + job control plane)
        |
        +-- Store (PGlite or PostgreSQL)
        +-- File volume
        +-- Vault
        +-- Task worker
        +-- Agent runner
        +-- Model gateway --> API keys, ChatGPT OAuth, Grok OAuth, other providers
        +-- Browser worker (Playwright Chromium)
        +-- Google APIs
        +-- Telegram Bot API
        +-- Public ATS HTTP
        +-- Optional WebRead (Jina-style)
```

## 3. Process model

v1 default: one API process with `TASK_WORKER_ENABLED=true`, one browser worker, web UI.

PGlite cannot be opened by two processes. Use Postgres if API and worker split.

## 4. Control plane

Authenticates the owner, validates policy, creates leases, persists domain rows, starts agent runs, records approvals, gates browser actions, emits events.

The control plane must not draft resume, cover, or statement prose. Drafting agents receive confirmed profile fields and evidence artifact ids, not provider tokens.

## 5. Trust boundaries

| Zone | Trust |
| --- | --- |
| UI | Untrusted input |
| API | Trusted for policy |
| Agent run | Untrusted; allowlisted tools |
| Browser worker | Semi-trusted executor |
| Model provider | External (API key or user OAuth: ChatGPT, Grok, others) |
| Google / Telegram | External |

## 6. Paths

### Scheduled ATS scan

Scheduler → Hunter → adapters → upsert jobs → Ranker → Event → Notifier

### Pack

Shortlist → Resume run → Cover run → Statement run when required → HR review (grounding) → Packer → `pack_review` → user

### Apply

Pack approval → Session usher → user login if needed → Prefill → submit approval → click or takeover → receipt

## 7. Upstream mapping

| OpenMuse | OpenApply |
| --- | --- |
| `apps/mobile` | Reskinned Jobs, Packs, Applications, Settings |
| `apps/server` | Job routes + agent runner |
| `apps/worker` | Keep; extend upload and apply idle timeout |
| `apps/computer` | Unused |
| `packages/domain` | Extended |
| Google integrations | Kept |
| Chat | Operator surface only |

## 8. Observability

Each `AgentRun` stores role, model id, usage, duration, artifact ids, and error class. Activity screen shows these rows.
