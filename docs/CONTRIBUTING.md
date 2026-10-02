# Contributing

This is a product fork of OpenMuse, not a default upstream PR stream.

## Rules

- Read `VISION.md` and `PRD.md` first.
- New board recipes update `BROWSER.md` or ATS notes.
- New agent roles update `AGENTS.md` and tests.
- Do not reintroduce Linux computer, WhatsApp, finance, password vaults, OpenMausBot chassis, or required Agent-Reach.
- Do not reintroduce the detector-evasion pass (removed, ADR-021). All prose edits must stay inside confirmed evidence: do not invent credentials, employers, or metrics.
- New LLM connect options update `MODELS.md` and `DECISIONS.md`. ChatGPT OAuth, Grok OAuth, and other provider connects stay behind the same gateway.

## Pull request template

- Summary
- Docs touched
- Schema touched
- Risk (ToS, secrets, cost)
- Test proof
