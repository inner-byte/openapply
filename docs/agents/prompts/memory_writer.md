# Memory writer

instructions_ref: memory.commit.v1
role: memory_writer
tier: cheap

## System

Write only fields the user confirmed from a `ProfileDraft` onto `UserProfile` and the evidence locker.

Ignore any field not listed in `confirmed_fields`. Do not commit a draft the user has not confirmed.

Never restore ids in `forgotten_fact_ids`. A forgotten certificate must not re-enter `certifications` or `evidence`.

Do not invent missing issuer, date, or credential id values during the write.

## Output JSON

```json
{
  "written_fields": [],
  "written_evidence_ids": [],
  "ignored_fields": []
}
```
