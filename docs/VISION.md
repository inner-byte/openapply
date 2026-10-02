# Mission, vision, and outcomes

Version: 1.2  
Status: Approved

## Mission

Give a job seeker a local system that finds relevant roles, prepares evidence-based application materials, and helps submit them under explicit human control, without storing job-site passwords or silently applying.

## Vision

A personal hiring operating system on the user’s machine: durable state, inspectable artifacts, specialist agents with isolated context, and a Chromium session the user can seize at any time.

## Principles

1. Human authority over irreversible actions.
2. Evidence over fluent language.
3. Isolated agents over one omniscient chat.
4. Artifacts over hidden prompt state.
5. Official source URLs over summaries presented as truth.
6. Local secrets stay local.
7. Prefer durable SQL and files over clever multi-agent chat.
8. Learn the person from the whole evidence locker, not from the resume file alone.
9. Detector-evasion rewrites stay inside confirmed facts.

## Non-goals

- Unofficial LinkedIn/Indeed growth bots.
- Selling user data.
- Hosted multi-tenant SaaS in v1.
- Replacing user judgment about whether a job is real.

## Horizons

| Horizon | Outcome |
| --- | --- |
| 90 days | Ingest resume and supporting evidence, rank public ATS jobs on a schedule, approve a pack that has passed a detector-evasion rewrite, supervised apply on a simple ATS page. |
| 6 months | Visible browser hunts for LinkedIn/Indeed/one government recipe; tracker; authenticity reviewer and detector-evasion pass in daily use. |
| 12 months | Multi-profile household use, broader ATS coverage, optional mobile client. |

## Success metrics

| Metric | v1 target | Measurement |
| --- | --- | --- |
| User time, shortlist to approved pack | Under 20 minutes | Event timestamps |
| Ungrounded claims in approved resumes | Zero in fixtures | Reviewer + CI |
| Detector-evasion pass on approved prose | Always, before pack approval | Reviewer artifact + CI |
| Certificate claims without a stored certificate | Zero in fixtures | Evidence-locker tests |
| Silent submits | Zero | Submit-waiter tests + audit |
| Job-site passwords stored | Zero | Security review |
| Missed ATS scans while machine is awake | Under 5 percent | Task leases |
| Official URL visible before submit | Always | UI contract test |

## Anti-metrics

Do not optimize applications per hour or logged-in crawl volume.
