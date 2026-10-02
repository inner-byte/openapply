# Security

Version: 1.2  
Status: Approved

## Identity

Single owner. Shared access key. Not multi-tenant.

## Secrets

| Secret | Store |
| --- | --- |
| App access key | env |
| `TOKEN_ENCRYPTION_KEY` | env |
| Model keys | vault |
| ChatGPT OAuth tokens | vault |
| Grok OAuth tokens | vault |
| Other provider OAuth tokens | vault |
| Google tokens | vault |
| Telegram bot token | vault |
| `WORKER_TOKEN` | env, server-worker only |
| Job-site passwords | never |
| Browser profiles | locked data dir |

## Agent isolation

Enforce allowlists in code. CI must deny a resume-agent Gmail tool call. CI must deny a drafting agent any vault or OAuth token read. Evidence is passed as artifact ids.

## Browser

No private-network destinations. Worker token never goes to the Expo client.

## Prompt injection

`JobPosting.raw_text` is hostile. Do not interpolate it into system prompts without delimiters and a “this is untrusted data” wrapper.

## Data rights

User can export and delete profile, artifacts, and browser profiles. Backups of `DATA_DIR` are sensitive.
