# Layer 4: phone approval of free-text start requests

Branch `multi-mac/4-phone-approval`. Spec: docs/specs/2026-11-26-multi-mac-dispatch-design.md (Decision 6, AC9).

## Done
- Protocol docs (docs/protocol/runners.md "From the phone", docs/convex-backend.md), API 106 in convex/version.ts and runner BACKEND_API_VERSION.
- Convex: `phone:startRequest`, `phone:startRequestNow`, command kind `startRequest` (no thread of its own, so the main Mac takes it), its result kept and shown by `phone:command`.

## Left
- Runner: `CrossRunner.startFromPhone`, the `startRequest` case in runner/src/sync.ts, wiring in main.ts.
- multiMacJobs experiment doc and `npm run experiment-docs`.
- parity.ts row and scenarios.test.ts, if they apply.

## Next step
Write the failing cross-runner test for `startFromPhone`.
