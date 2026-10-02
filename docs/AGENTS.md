# Agent system

Version: 1.2  
Status: Approved

## Laws

1. One role per run.
2. Fresh context. No shared chat history between roles.
3. Tools are an allowlist.
4. Outputs are artifacts plus JSON.
5. Missing evidence produces a question, not an invention.

## Runner packet

```json
{
  "run_id": "uuid",
  "role": "resume_specialist",
  "schema_version": "1",
  "policy": {
    "can_use_browser": false,
    "can_write_profile": false,
    "max_output_tokens": 4000
  },
  "artifact_ids": [],
  "instructions_ref": "resume.ats_optimize.v1"
}
```

## Roles

| Role | May | Must not |
| --- | --- | --- |
| `intake` | Extract ProfileDraft | Commit memory |
| `memory_writer` | Write confirmed fields | Run without confirm |
| `hunter_ats` | Public HTTP allowlist | Use browser profile |
| `hunter_browser` | Snapshot/read/scroll in approved session | Run 24/7 logged-in |
| `ranker` | Score jobs | Write prose docs |
| `company_researcher` | Cited brief | Hide official URL |
| `resume_specialist` | T1–T10 on one job, using confirmed evidence | Invent credentials or read Gmail or vault |
| `cover_specialist` | One cover, using confirmed evidence | Merge into resume run or invent credentials |
| `statement_specialist` | One statement grounded in evidence and voice samples | Invent credentials or merge into the resume run |
| `hr_authenticity_reviewer` | Critique and revise candidates against confirmed evidence | Fabricate metrics or credentials |
| `packer` | Manifest + folder | Call models for new prose |
| `session_usher` | Bind profile to origin | Type passwords |
| `prefill` | Fill known fields, attach manifest files | Guess unknown uploads |
| `submit_waiter` | Click after approval | Submit without approval |
| `tracker` | Map mail/page/manual marks | Apply |
| `notifier` | Deliver events | Generate packs |

## HR reviewer checklist

- Claim-to-evidence map for every bullet
- Certificate, license, award, and date claims map to a confirmed `EvidenceItem`
- Voice match to `voice_samples` and prior statements
- Specificity drawn from the evidence locker, not generic filler
- Clichés and template phrases
- Skills absent from profile
- Metrics absent from confirmed facts
- Alignment to the actual job

Blockers prevent `pack_approved`. Missing evidence still produces a question, not an invention.

(The detector-evasion wording pass, formerly `hr.detector_evasion.v2`, was removed — see ADR-021 in DECISIONS.md.)

Prompt files live in [apps/server/src/prompts/](../apps/server/src/prompts/README.md). One `instructions_ref` per run. Do not concatenate prompt files.

## Prompt tools T1–T10

| Id | Name |
| --- | --- |
| T1 | ATS-optimized builder |
| T2 | Resume from scratch |
| T3 | Review + rewrite |
| T4 | Bullet optimizer |
| T5 | Role-specific resume |
| T6 | Career switch |
| T7 | Fresher builder |
| T8 | Alignment notes between resume and cover (not a merged run) |
| T9 | LinkedIn export alignment |
| T10 | Keyword booster, still grounded |

## Error classes

`SCHEMA_INVALID`, `UNGROUNDED_CLAIM`, `POLICY_DENIED`, `PROVIDER_ERROR`, `BROWSER_BLOCKED`, `USER_ACTION_REQUIRED`, `BUDGET_EXCEEDED`, `ACCOUNT_RISK`.
