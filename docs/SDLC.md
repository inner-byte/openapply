# Development workflow

Version: 1.1  
Status: Approved

## Assumed team

Product lead, engineering lead, one or two full-stack engineers, QA, part-time security reviewer.

## Branching

- `main` is locally releasable
- `feat/<ticket>-<slug>`
- `fix/<ticket>-<slug>`
- `docs/<slug>`

## Definition of ready

Story, affected docs, schema impact, agent impact, test names.

## Definition of done

Code and docs in the same PR when behavior changes.

Invariant tests added.

No new secret in logs.

QA checklist updated if user-visible.

## Environments

| Name | Purpose |
| --- | --- |
| sample | OpenMuse sample mode |
| local-live | real models, user data dir |
| ci | fixtures, no live LinkedIn |

## Release

Tag `v0.x`. `CHANGELOG.md` required.

`v1.0` only after slices 1–9 pass the PRD demo.
