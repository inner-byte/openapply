# Project plan

Version: 1.2  
Status: Approved

## Objective

Ship OpenApply v1 per `PRD.md` in `BUILD.md` order on the OpenMuse chassis.

## Workstreams

| Stream | Depends on |
| --- | --- |
| Platform fork | ADR-001, ADR-014 |
| Domain and data | Slice 1 |
| Agents and gateway | Slices 2–3 |
| Discovery UI | Slice 5 |
| Packs UI | Slice 7 |
| Browser apply | Slice 8 |
| QA | Fixtures from slice 4 |
| Security | Slices 3 and 9 |

## Critical path

Schema → profile → ATS jobs → packs → approvals → apply.

Browser hunts are not on the path to milestone M4.

## Risks

| Risk | Mitigation |
| --- | --- |
| Worker blocks popups | `needs_takeover_only` |
| Model cost | `max_strong_model_packs_per_cycle` |
| Board ToS | No logged-in background crawl; disclosure |
| Generic AI copy | HR reviewer, specificity from evidence, fixtures |
| Invented credentials | Evidence locker confirm before draft |
| Scope creep | One government recipe later |
| Upstream drift | Pin OpenMuse commit |

## Governance

Product lead can cut scope.

Engineering lead cannot add WhatsApp, password vaults, OpenMausBot chassis, or required Agent-Reach without a new ADR. ChatGPT OAuth, Grok OAuth, other LLM connects, and the evidence locker are already accepted (ADR-015, ADR-016, ADR-017). Detector evasion was accepted in ADR-015 but removed in ADR-021 and must not be reintroduced without a new ADR.
