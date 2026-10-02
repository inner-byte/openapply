# Domain model

Version: 1.2  
Status: Approved

## UserProfile

Confirmed facts only.

- `id`, `display_name`, `headline`
- `work_authorization_text`
- `locations_allowed[]`, `languages[]`
- `education[]`, `experience[]`, `skills[]`, `projects[]`, `certifications[]`
- `links[]`
- `master_resume_artifact_id`
- `evidence_artifact_ids[]`
- `voice_samples[]`
- `statement_samples[]`
- `forgotten_fact_ids[]`
- `updated_at`

Extracted facts land in a `ProfileDraft` until confirmed. Forgotten facts must not re-enter drafts.

`certifications[]` is filled from confirmed certificate, license, and award evidence. A drafting agent may not cite a credential that is not in this list or in `evidence_artifact_ids[]`.

## EvidenceItem

Stored file plus confirmed fields. Kinds: `certificate`, `transcript`, `license`, `award`, `portfolio`, `publication`, `recommendation`, `statement_sample`.

- `artifact_id`, `kind`, `title`, `issuer`, `issued_on`, `expires_on`
- `credential_id`, `url`
- `summary` (user-confirmed)
- `skill_tags[]`

## Preference

- `scan_interval_hours` (6–24, default 12)
- `countries[]`, `role_levels[]`
- `titles_include[]`, `titles_exclude[]`, `keywords[]`
- `exclude_companies[]`
- `work_modes[]`
- `salary_floor`, `salary_currency`
- `sources_enabled[]`
- `max_strong_model_packs_per_cycle` (default 5)
- `notify_channels[]`
- `timezone`

## JobPosting

- `id`, `source`, `source_url`, `apply_url`
- `company_name`, `title`, `location_text`, `remote_type`
- `posted_at`, `raw_text`
- `requirements[]`, `qualifications[]`, `salary_text`
- `content_hash`, `first_seen_at`, `last_seen_at`, `is_active`

`source` enum: `greenhouse`, `lever`, `ashby`, `linkedin`, `indeed`, `government`, `company_board`, `rss`, `web_read`, `manual`

Dedup: `content_hash` or `(source, external_id)`.

## CompanyBrief

- `job_id`, `summary`, `evidence_urls[]`, `generated_at`, `agent_run_id`

## Application

- `id`, `job_id`, `state`, `pack_id`
- `browser_profile_key`
- `last_form_snapshot_artifact_id`
- `submitted_at`, `close_reason`

## Artifact

- `id`, `kind`, `parent_id`, `application_id`
- `mime`, `sha256`, `byte_size`, `storage_path`
- `agent_role`, `model_id`, `created_at`

Kinds: `source_upload`, `linkedin_export`, `extracted_profile`, `master_resume`, `certificate`, `transcript`, `license`, `award`, `portfolio`, `publication`, `recommendation`, `statement_sample`, `job_snapshot`, `company_brief`, `resume_draft`, `cover_draft`, `statement_draft`, `hr_review`, `resume_final_candidate`, `cover_final_candidate`, `statement_final_candidate`, `resume_approved`, `cover_approved`, `statement_approved`, `pack_manifest`, `form_snapshot`, `receipt`

## AgentRun

- `id`, `role`, `status`
- `job_id`, `application_id`
- `input_artifact_ids[]`, `output_artifact_ids[]`
- `model_logical_name`, `model_id`, `usage_json`
- `error_class`, `error_message`
- `started_at`, `ended_at`

## Approval

- `id`, `application_id`
- `target` (`resume`, `cover`, `statement`, `pack`, `submit`, `outbound_email`)
- `status` (`pending`, `approved`, `rejected`)
- `decided_at`, `note`

## Event

- `id`, `type`, `payload_json`, `notify_bool`, `created_at`, `delivered_channels[]`

## State machine

```text
discovered
  -> ranked
  -> shortlisted
  -> pack_drafting
  -> pack_review
  -> pack_approved
  -> session_needed
  -> prefilled
  -> submit_ready
  -> submitted
  -> awaiting_reply
  -> interviewing
  -> closed_won | closed_lost | withdrawn
```

Illegal: `submit_ready` without pack approval and submit approval.
Illegal: `pack_review` without resume and cover candidate artifacts.
Illegal: `pack_review` for a statement-required application without a statement candidate.

## Invariants

- I1 Master resume is never updated in place.
- I2 Approved resume descends from master or user source upload.
- I3 ATS hunter packets contain no `browser_profile_key`.
- I4 Submit waiter requires `Approval(target=submit, approved)`.
- I5 Job detail returns `source_url` when stored.
- I6 A credential claim in resume, cover, or statement maps to a confirmed `EvidenceItem`.
- I7 Removed (ADR-021): the detector-evasion pass and its notes artifact were
  removed. HR review findings remain the factual-integrity gate.
