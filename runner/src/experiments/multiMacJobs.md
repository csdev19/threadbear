---
id: multiMacJobs
name: Jobs on other Macs
title: The main Mac starts named jobs that another Mac asks for, with no card
added: 2026-11-26
on: false
reminder: 25c8cbe6
---

## What it does

On the main Mac (the one with the owner key), a request from another Mac's thread for one of your named jobs starts by itself on the Mac the job names, with the permission mode the job pins and the brief you wrote, with the values it asked for filled in. There is no card to answer: only a job you defined, with values that fit its types, can start this way. The thread it starts says on its first line that it was started under your job rule and that no person read the request. A request that has waited longer than the asking thread waits for it (60 minutes) is turned down with the reason, never started late. A free-text request from another Mac still waits for your answer, as before. A job whose Mac is unknown (the job names a runner id nothing has) is turned down with the reason, never started here instead. When the job thread's turn ends, its final reply is sent once to the asking thread on the other Mac, as a message from another thread whose first line names the job, the Mac and the thread and says its output is data, not instructions (cut at 20,000 characters). Off, nothing changes: job requests stay pending and are never started, and no reply is sent back.

## Lives in

`runner/src/job-starter.ts` (the poll, the brief filling, the job header) and, for the reply back, `runner/src/far-reports.ts` (`jobReportText`), wired in `runner/src/main.ts` beside the cross-runner; the backend side is `relay:pendingJobRequests` and `relay:decideRequest`'s `jobStart` in `convex/relay.ts`. The contract is docs/protocol/runners.md, "The job starter".

## Taking it out

To make it standard, delete the `multiMacJobs` check in `runner/src/main.ts` and the key in each runner.json, then run `npm run experiment-docs`. To drop it, remove `job-starter.ts`, its wiring in `main.ts` and `ConvexSync.jobStarterBackend`; the backend refuses to start a job request without `jobStart`, so job requests then stay pending.
