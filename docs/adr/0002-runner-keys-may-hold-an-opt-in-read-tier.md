# 0002. Runner keys may hold an opt-in read tier

- **Status:** proposed (2026-11-26), in [the multi-Mac dispatch spec](../specs/2026-11-26-multi-mac-dispatch-design.md). Not implemented.

## Context

A runner-key Mac's app lists only its own threads. Listing and reading other Macs' threads is
owner-only (`otherRunnersList`, `otherRunnersThreads`, `threadIndexSince`, `remoteTail`,
`remoteMessages`, `remoteThread`, `picturesAtSeqs` in `convex/runnerAccess.ts`). All runner keys are
equal: the `Caller` type has no per-key capability. The owner wants the laptop to show every Mac's
threads, the "Runs on" picker and replies from the jobs it asks for.

## Decision

A runner key may carry a `reads` flag, set only by the owner (`tb runner add --read-others`, or a
grant on an existing key). With it, the key may call a fixed allowlist of read functions: the runner
list, the thread index, and thread rows, messages, tail and pasted pictures. Tool output
(`remoteBody`), accounts (`remoteAccounts`) and pools (`remotePools`) stay owner-only. Revoking or
replacing the key clears the flag. Without the flag, nothing changes.

## Alternatives rejected

- **Open the reads to every runner key.** Rejected because the mini's and any cloud runner's keys would
  read every transcript too.
- **Read through a phone-style token stored in the Mac app.** Rejected for now, because a token on disk
  is just as readable by the laptop's agents. It would only differ if kept in the Keychain, limited to a
  signed app, and Threadbear is rebuilt locally on every update. Unverified.
- **Read only the threads the laptop asked for.** Rejected as the default because the owner's goal is
  to see every Mac. It stays a fallback if the main Mac's threads prove too sensitive.

## Consequences

- A leaked laptop key reads every Mac's thread transcripts, including the main Mac's. This is an
  accepted risk: the transcripts are the owner's own, and a paired browser on the laptop already
  exposes the same through the website's token.
- Text read from other Macs reaches the laptop's agents. It must be shown as information, not as
  instructions.
- `runner/test/unit/runner-access.test.ts` gains a third tier, and its "Mac mini's key can't … read the
  other runners' threads" case stays true for a key without the flag.

## Non-goals

Writing, messaging or starting anything on another Mac through this flag (see
[ADR 0001](0001-cross-mac-work-from-a-runner-key-mac-runs-as-named-jobs.md)); reading tool output,
accounts or pools.

## Reopen when

- A secret is found in a transcript that the laptop should not have seen. Narrow the flag to the
  threads the laptop asked for.
- Runner keys move to agent-proof storage. The flag could then widen.
