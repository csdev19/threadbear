# Layer 5: read tier on runner keys (branch multi-mac/5-read-tier)

Working notes for this unit; delete before landing.

## Done
- Protocol docs, API 107 entry, dev-tools/guide/on-your-mac/convex-backend docs.
- Convex: `runnerKeys.reads`, ACCESS tier `reads`, `callerFrom`, `addRunnerKey` reads, `setRunnerReads`, revoke/replace clear it, heartbeat answers `reads`.
- Tests: runner-access.test.ts (AC10), read-tier-backend.test.ts (AC12).

## Left
- Runner: `mayReadOthers()`, ThreadIndex gate and refresh, relay write fast-fail, remoteBody note.
- tb CLI: `--read-others`, `tb runner reads <runnerId> on|off`, list shows reads.

## Next step
Runner unit.
