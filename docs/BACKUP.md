# Backup and restore

Version: 1.0
Status: Approved (Slice 12)

OpenApply keeps everything in one data directory (`DATA_DIR`, default
`.openapply`). Back that directory up and you have the whole system state.

## What to back up

| Item | Where | Notes |
| --- | --- | --- |
| Database | `$DATA_DIR/` (PGlite embedded Postgres files) or external Postgres (see `DATABASE_URL`) | All jobs, applications, artifacts metadata, events, preferences |
| Files | `$DATA_DIR/files/` | Resume PDFs/DOCXs, previews, pack folders, imported attachments |
| Browser profiles | `$DATA_DIR/browser-profiles/` | Named Chromium profiles; safe to skip — they are re-created on demand |
| **Encryption key** | `TOKEN_ENCRYPTION_KEY` env value | **Critical.** OAuth tokens, API keys, and Telegram credentials are encrypted with this key. Lose it and the stored credentials are unrecoverable. Store it separately from the data backup (password manager, sealed secret). |

## What is NOT in the backup

- Model provider OAuth/API credentials in usable form: they are encrypted
  blobs. They restore only together with the same `TOKEN_ENCRYPTION_KEY`.
- The access key (`OPENAPPLY_ACCESS_KEY`) and session tokens: re-issue on
  the new machine.
- Live browser sessions: they expire; the usher re-binds on demand.

## How to back up

Embedded database (default): stop the server first so the PGlite files
are quiescent, then copy the whole data directory:

```sh
cp -r "$DATA_DIR" "$BACKUP_DIR/openapply-$(date +%F)"
```

External Postgres: use `pg_dump` per your normal procedure; the `files/`
tree still lives on disk under `$DATA_DIR` and must be copied separately.

## How to restore

1. Install the same OpenApply build on the new machine.
2. Set `DATA_DIR` to the restored directory.
3. Set `TOKEN_ENCRYPTION_KEY` to the **original** key value.
4. Set a fresh `OPENAPPLY_ACCESS_KEY`.
5. Start the server and sign in again; reconnect any model or Google
   accounts whose OAuth tokens fail to decrypt (wrong key) — the Models
   screen shows which accounts need attention.

## Restore verification

- `GET /api/health` returns `ok`.
- `GET /api/models` lists the expected connected accounts.
- `GET /api/applications` returns the expected application count.
- Open one pack preview: the PDF bytes and the preview PNG must both load
  (previews are rendered from stored bytes, so this proves `files/`
  restored intact).

## Cadence

Back up before every upgrade, and weekly while applications are active.
The encryption key needs backing up exactly once — when it is created —
and again only if it is ever rotated (rotation re-encrypts nothing;
old backups stay tied to the key that made them).
