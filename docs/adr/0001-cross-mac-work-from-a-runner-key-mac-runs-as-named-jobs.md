# 0001. Cross-Mac work from a runner-key Mac runs as owner-defined named jobs

- **Status:** proposed (2026-11-26), in [the multi-Mac dispatch spec](../specs/2026-11-26-multi-mac-dispatch-design.md). Not implemented.

## Context

The main Mac holds the owner key and may start or message threads on any Mac. Every other Mac holds a
runner key that reaches only its own threads (docs/protocol/keys.md, "Runner keys", added 5 Nov 2026
after a security review). A runner-key Mac can ask for a thread elsewhere only by filing a request that a
human approves in the main Mac's app (`convex/relay.ts` `fileRequest` / `decideRequest`,
`runner/src/cross-runner.ts`).

The owner wants the laptop (runner key) to start agent work on the Mac mini, such as "check out a
branch, run the e2e suite, capture screenshots, post them on the PR", without approving each one.

Three facts constrain the answer:

- The runner key is a file (`secrets/convex-key`) on the Mac where agents run, and Full-access threads
  are not kept out of it (`runner/src/secrets-guard.ts`). Any power on the key is the power of every
  Full-access agent on that Mac, including one steered by injected text.
- A relay create with no permission mode starts a Full-access thread (`convex/relay.ts:317`).
- The main Mac cannot resolve or realpath a folder on another Mac, so a rule on folders is a rule on text.

## Decision

A runner key never gains the right to queue work on another Mac. It files requests, and the main Mac
carries them out. The main Mac starts a request with no human only when it names a **job** the owner
defined: a target runner id, a repo allowlist, typed parameters, a pinned access mode, an hourly cap and
a brief template. Jobs are written with the owner key and only read by runner keys. The backend
validates the parameters when the request is filed, and the main Mac fills the brief from the template.
A free-text request always waits for a human, in the main Mac's app or on the phone.

## Alternatives rejected

- **A grant on the laptop's key to message and start threads on named Macs.** Rejected because any
  Full-access agent on the laptop could use it to run arbitrary commands on those Macs. The backend also
  cannot cap the mode or tell an agent from the owner.
- **Auto-approve requests by a metadata rule** ("from the laptop, to the mini, folder under ~/code").
  Rejected because the brief stays free text, so an injected brief runs unreviewed.
- **Give the laptop the owner key.** Rejected because it undoes the 5 Nov split, and `tb runner
  rotate-owner` refuses while another Mac holds it.
- **A GitHub Actions self-hosted runner on the mini.** Not rejected for plain CI, but it does not cover
  agent work (judgement, screenshots, a report back), and on a public repo it needs trigger restrictions.

## Consequences

- An injected laptop agent can still run any *defined* job with valid parameters, up to its hourly cap.
  The jobs, the mini's credentials and branch protection on the job repos bound the damage.
- The main Mac must be on for any cross-Mac start. It is the single point for this path.
- New code sits in the security path: request validation, the main Mac's job starter, and the phone
  approval path. Each one needs tests that fail closed.
- The fork diverges from upstream's key model until upstream takes or rejects the proposal.

## Non-goals

Messaging an existing thread on another Mac from a runner-key Mac; jobs triggered by GitHub events;
any change to what the owner key or the phone may do, except the phone approving free-text requests.

## Reopen when

- Runner keys move out of agent-readable storage (a Keychain item limited to the runner binary, or a
  mediator that needs a human gesture). A grant on the key would then be worth reconsidering.
- Upstream ships its own cross-Mac dispatch model.
- The job list grows past what one owner can review, a sign that the jobs have become free text in
  disguise.
