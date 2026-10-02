# OpenApply documentation

| Field | Value |
| --- | --- |
| Product | OpenApply |
| Upstream | CopilotKit/OpenMuse (MIT) |
| Status | Approved for implementation |
| Audience | Engineering, product, QA, security |
| Chassis decision | OpenMuse only. OpenMausBot is not a fork base. |

This directory is the source of truth. Chat transcripts are not.

## Read order

1. [PRODUCT_NAME.md](./PRODUCT_NAME.md)
2. [VISION.md](./VISION.md)
3. [PRD.md](./PRD.md)
4. [DECISIONS.md](./DECISIONS.md)
5. [ARCHITECTURE.md](./ARCHITECTURE.md)
6. [DOMAIN.md](./DOMAIN.md)
7. [AGENTS.md](./AGENTS.md)
8. [agents/prompts/README.md](./agents/prompts/README.md)
9. [FILES.md](./FILES.md)
10. [BROWSER.md](./BROWSER.md)
11. [MODELS.md](./MODELS.md)
12. [SECURITY.md](./SECURITY.md)
13. [UI.md](./UI.md)
14. [SDLC.md](./SDLC.md)
15. [PLANNING.md](./PLANNING.md)
16. [ROADMAP.md](./ROADMAP.md)
17. [BUILD.md](./BUILD.md)
18. [TESTING.md](./TESTING.md)
19. [RUNBOOK.md](./RUNBOOK.md)
20. [CONTRIBUTING.md](./CONTRIBUTING.md)

## Owners

| Area | Primary | Backup |
| --- | --- | --- |
| Vision, PRD | Product lead | Engineering lead |
| Architecture, domain, agents | Engineering lead | Staff engineer |
| Security | Security owner | Engineering lead |
| Delivery | Engineering manager | Engineering lead |
| QA | QA lead | Engineering lead |

## Change control

- Behavior change requires a docs update in the same pull request.
- Schema change updates `DOMAIN.md` and `BUILD.md`.
- Agent contract change updates `AGENTS.md`, `agents/prompts/`, and `TESTING.md`.
- New third-party repo requires an ADR in `DECISIONS.md`.
