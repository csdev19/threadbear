# Layer 4: phone approval of free-text start requests

Branch `multi-mac/4-phone-approval`. Spec: docs/specs/2026-11-26-multi-mac-dispatch-design.md (Decision 6, AC9).

## Done
- Protocol docs (docs/protocol/runners.md "From the phone", docs/convex-backend.md), API 106 in convex/version.ts and runner BACKEND_API_VERSION.
- Convex: `phone:startRequest`, `phone:startRequestNow`, command kind `startRequest` (no thread of its own, so the main Mac takes it), its result kept and shown by `phone:command`.
- Runner: `CrossRunner.startFromPhone`, the `startRequest` case in runner/src/sync.ts, wiring and the `phoneStarts` experiment check in main.ts.
- multiMacJobs experiment doc updated and `npm run experiment-docs` run.
- parity.ts and scenarios.test.ts: not needed (`requests.*` is not a thread method; no thread row changed).

## Left
- Nothing in the backend and runner. The Android side is another agent's.

## Next step
Review, then land through `tb land`.
