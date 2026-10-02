# File and artifact system

Version: 1.2  
Status: Approved

## Layout

```text
$data_dir/
  inbox/
  files/{artifact_id}
  packs/{application_id}/
    manifest.json
    resume.pdf
    cover.pdf
    statement.pdf
    hr_review.md
  browser-profiles/
  vault/
```

`statement.pdf` is omitted when the application did not ask for a statement. Evidence bytes live under `files/{artifact_id}` and are listed in the manifest.

## Ingest

Accepted: `pdf`, `docx`, `txt`, `md`, `png`, `jpg`, `jpeg`, `webp`, `zip` (LinkedIn export).
Certificate scans and photos are evidence, not a second master resume.
Rejected: executables and oversized files.

Pipeline: store raw → sniff MIME → extract text → ProfileDraft (facts plus evidence fields) → user confirm → promote artifacts → `memory_writer`.

Evidence kinds stored as their own artifacts: certificate, transcript, license, award, portfolio, publication, recommendation, prior statement. The master resume stays immutable. Agents read both.

## Generation

Never overwrite `master_resume`. Each PDF render is a new artifact.

## Manifest

```json
{
  "schema_version": "1",
  "application_id": "",
  "job_id": "",
  "artifacts": {
    "resume": "uuid",
    "cover": "uuid",
    "statement": "uuid",
    "hr_review": "uuid",
    "master_resume": "uuid",
    "evidence": ["uuid"]
  },
  "hashes": {
    "resume": "sha256:"
  }
}
```

## Browser upload

Prefill attaches only manifest paths. Unknown file kind pauses the task.

## Privacy

Do not send full resumes, statements, or certificate images over Telegram. Deletion tombstones metadata and unlinks bytes. Audit rows remain.
