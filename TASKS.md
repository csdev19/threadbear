# Layer 5: read tier on runner keys (branch multi-mac/5-read-tier)

Working notes for this unit; delete before landing.

## Done
- Protocol docs, API 107 entry, dev-tools/guide/on-your-mac/convex-backend docs (commit 1).
- Convex: `runnerKeys.reads`, ACCESS tier `reads`, `callerFrom`, `addRunnerKey` reads, `setRunnerReads`, revoke/replace clear it, heartbeat answers `reads`, `listRunnerKeys` shows it (commit 1).
- Tests: runner-access.test.ts (AC10), read-tier-backend.test.ts (AC12 at the backend level).
- Runner: `ConvexSync.mayReadOthers()`, ThreadIndex `mayRead` gate and refresh, `relaySource` gated, `takesOrder` owner-only, Relay `owner` dep (writes fail fast, remoteBody note, logins refused), main.ts wiring.

## Left
- tb CLI (runner/src/runner-keys.ts, cli.ts): `tb runner add --read-others` (pass `reads: true` to sync:addRunnerKey), `tb runner reads <runnerId> on|off` (sync:setRunnerReads), `tb runner list` shows `reads`, add `read-others` to the runner flag list in cli.ts and the usage text; tests in runner/test/unit/runner-keys.test.ts. docs/dev-tools.md already describes them.
- Set `BACKEND_API_VERSION`/API_VERSION gap (106) at rebase.
- Delete this file before landing.

## Next step
CLI unit.
