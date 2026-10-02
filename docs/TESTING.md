# Test strategy

Version: 1.2  
Status: Approved

## Layers

1. Domain invariants
2. Agent contracts with provider stubs
3. ATS adapters against checked-in JSON
4. API authorization
5. Playwright smoke in sample mode
6. Manual script for live boards

## Mandatory cases

- Resume specialist cannot call Gmail tools
- Memory writer without confirm fails
- Submit waiter without approval is a no-op
- ATS hunter packet with `browser_profile_key` is rejected
- HR reviewer flags planted metric `increased revenue 387%`
- A certificate name that is not in the evidence locker cannot appear in resume, cover, or statement
- A confirmed certificate issuer and title can be cited in resume, cover, and statement
- Pack approval succeeds on an HR-reviewed pack (no detector-evasion pass; removed, ADR-021)
- Prompt packets load one `instructions_ref` file. They do not concatenate `docs/agents/prompts/`
- ChatGPT OAuth, Grok OAuth, and API-key connects all reach the same gateway interface
- Job detail includes `source_url`
- Scan interval `5` rejected; `12` accepted
- Manual state mark to `pack_review` rejected; terminal states cannot change
- Tracker never sets `submitted` without receipt evidence
- Hostile mail text is mapped to states, never obeyed
- Document runs carry no tools in their model input
- Sequential runs share no chat history
- Unknown instructions_ref fails instead of concatenating prompt files
- Cheap-model budget stops calls over the per-cycle limit
- Orchestrator runs move queued -> running -> done/failed; illegal transitions rejected
- Every pipeline specialist is a tracked run with one role and one instructions_ref
- advanceApplication moves ranked -> pack_review and notifies; other states untouched
- The orchestrator exposes no submit path
- Two custom providers connect with distinct encrypted vault credentials; keys never leave the server
- Custom provider base URLs must be https
- Unknown provider ids in preferences fail with 400, not a silent misroute
- Deleting a custom provider referenced by a tier or role override is blocked (409); unreferenced deletion removes the vault credential
- Chat provider selection affects only that chat session; tier settings are never written

## Fixtures

`tests/fixtures/hiring` only. No live board credentials in CI.
