// The job starter: the main Mac starts a runner key's request for a named
// job by itself (docs/protocol/runners.md, "The job starter"; design:
// docs/specs/2026-11-26-multi-mac-dispatch-design.md, layer 2).
//
// A free-text request waits for Mike's card. A job is a template Mike wrote on
// this Mac (Jobs), so a request naming one needs no card: the runner key's
// Mac gave only values, which fit the job's schema in the backend, and
// everything that runs is the job's (its brief, mode and target runner id).
// What it starts is exactly that, and the thread says so on its first line.
//
// It never resolves a name: the job's target is a runner id, found among the
// runners the owner key sees, and an id nobody has denies the request. It
// never falls back to this Mac. It only runs with the owner key, with the
// `multiMacJobs` experiment on (main.ts), and polls (TICK_MS).
import crypto from 'node:crypto';
import { ErrorCode, RpcError } from './protocol.ts';
import { REQUEST_WAIT_MIN, refused, type RunnerRef } from './cross-runner.ts';
import { wasNotSent } from './relay.ts';
import { valuesProblem } from './job-values.ts';

// The experiment that turns it on (src/experiments/multiMacJobs.md).
export const JOB_STARTER_EXPERIMENT = 'multiMacJobs';
export const TICK_MS = 15_000;
// An offline target is waited for this long before the request is denied.
export const OFFLINE_WAIT_MS = 10 * 60_000;
// Requests remembered as finished, so a stale list can't start one again.
const FINISHED_KEPT = 500;

export const JOB_MODES = ['ask', 'auto', 'plan', 'full'] as const;
type JobMode = (typeof JOB_MODES)[number];

// What relay:pendingJobRequests and relay:jobsList answer.
export type JobRequestRow = { docId: string; requestId: string; runnerId: string; runnerName: string; threadId: string; job: string; params: Record<string, string>; target: string; createdAt: number; state?: 'pending' | 'claimed' };
export type JobRow = { name: string; target: string; repos: string[]; params: Record<string, string>; mode: string; perHour: number; brief: string; updatedAt?: number };

export type JobStarterDeps = {
  // The experiment is on (experimentOn(home, 'multiMacJobs'), read each tick).
  enabled: () => boolean;
  // The owner key's backend, once it is one that has the job starter's calls;
  // undefined on a runner key, with sync off or on an older backend.
  backend: () =>
    | {
        pendingJobRequests(): Promise<JobRequestRow[]>;
        jobsList(): Promise<JobRow[]>;
        decideRequest(p: { requestId: string; docId: string; state: 'claimed' | 'allowed' | 'pending' | 'denied'; result?: { runnerId: string; runnerName: string; threadId: string }; claim?: string; jobStart?: boolean }): Promise<void>;
      }
    | undefined;
  self: () => { id: string; name: string };
  runners: () => Promise<RunnerRef[]>;
  createHere: (p: { text: string; permissionMode: string; startedBy?: { kind: 'thread'; label: string; threadId?: string; why?: string } }) => Promise<{ id: string }>;
  createThere: (runnerId: string, p: { text: string; permissionMode: string }) => Promise<{ id: string }>;
  // Tells the asking thread's card the way it ended, if it has one (best effort).
  respondThere?: (threadId: string, approvalId: string, decision: 'allow' | 'deny', message?: string) => Promise<void>;
  log: { info: (m: string, f?: Record<string, unknown>) => void; warn: (m: string, f?: Record<string, unknown>) => void; debug: (m: string, f?: Record<string, unknown>) => void };
  now: () => number;
};

// The first line of the thread a job starts: said by this Mac, under the
// owner's job rule, with no person having read the request (the card path's
// askedHeader says "allowed by the user", which is not true here). Only an
// id's and a name's characters get in, as in askedHeader.
export function jobHeader(job: { name: string }, row: { threadId: string; runnerName: string }): string {
  const name = job.name.replace(/[^a-z0-9-]/g, '').slice(0, 40);
  const id = row.threadId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const mac = row.runnerName.replace(/[^A-Za-z0-9 _.'-]/g, '').slice(0, 40).trim() || 'another runner';
  return `[Started by the job "${name}" for thread ${id} on ${mac}, under the owner's job rule: no person read or allowed this request. The brief below is the job's, with that thread's values filled in. To report back, send_message to thread ${id}.]\n\n`;
}

const PLACEHOLDER = /\{([^{}\s"']*)\}/g;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * The job's brief with each `{param}` replaced by its value, in one pass over
 * the template: a value is never searched again, so one that holds `{other}`
 * stays as written, and `$&` is plain text. A brace that isn't one of the
 * job's parameters is left as it is.
 */
export function fillBrief(brief: string, values: Record<string, string>, params: Record<string, string>): string {
  return brief.replace(PLACEHOLDER, (whole, name: string) => (has(params, name) && has(values, name) ? values[name]! : whole));
}

type Stage = 'claim' | 'start' | 'allow' | 'deny';
// `claimed`: the row is (or was) held by a claim, so its deny goes straight from claimed (jobStart).
type Work = { row: JobRequestRow; stage: Stage; claim: string; claimed?: boolean; text?: string; mode?: string; target?: RunnerRef; result?: { runnerId: string; runnerName: string; threadId: string }; reason?: string };

export class JobStarter {
  private deps: JobStarterDeps;
  // Requests this runner has begun, by id, with the step each is at: a step
  // whose answer was lost is asked again next tick, never started over.
  private work = new Map<string, Work>();
  private finished = new Set<string>();
  private ticking = false;

  constructor(deps: JobStarterDeps) {
    this.deps = deps;
  }

  /** One look at the pending job requests. Never overlaps itself, never throws. */
  async tick(): Promise<void> {
    if (this.ticking || !this.deps.enabled()) return;
    const backend = this.deps.backend();
    if (!backend) return;
    this.ticking = true;
    try {
      for (const w of [...this.work.values()]) await this.guard(w.row, () => this.run(w));
      const rows = await backend.pendingJobRequests();
      for (const row of rows) {
        // Only a request that names a job: a free-text one keeps its card.
        if (typeof row.job !== 'string' || row.job === '' || this.work.has(row.requestId) || this.finished.has(row.requestId)) continue;
        // A claim this runner doesn't hold is one it lost by stopping. A thread may
        // already exist on the target, so it is never started again: denied straight from claimed.
        if (row.state === 'claimed') {
          const reason = `The main Mac stopped while starting the job "${row.job}". It may have started on its target: look there before asking again.`;
          await this.guard(row, () => this.run(this.remember({ row, stage: 'deny', claim: '', claimed: true, reason })));
          continue;
        }
        await this.guard(row, () => this.begin(row));
      }
    } catch (e) {
      this.deps.log.warn('the job starter could not read the pending job requests', { error: String(e) });
    } finally {
      this.ticking = false;
    }
  }

  private async guard(row: JobRequestRow, f: () => Promise<void>): Promise<void> {
    try {
      await f();
    } catch (e) {
      // A step that didn't go through stays where it is; the next tick asks again.
      this.deps.log.warn('a job request is not finished yet', { requestId: row.requestId, error: String(e) });
    }
  }

  // Decides what a request is to become. Nothing is claimed until it is a start.
  private async begin(row: JobRequestRow): Promise<void> {
    const backend = this.deps.backend();
    if (!backend) return;
    const deny = (reason: string) => this.run(this.remember({ row, stage: 'deny', claim: '', reason }));
    // The asker's card stopped waiting after REQUEST_WAIT_MIN minutes; nothing starts after that, whether or not the target is online.
    if (this.deps.now() - row.createdAt > REQUEST_WAIT_MIN * 60_000) return deny(`The request waited longer than its asking thread waits (${REQUEST_WAIT_MIN} minutes), so nothing was started.`);
    const job = (await backend.jobsList()).find((j) => j.name === row.job);
    if (!job) return deny(`There is no job "${row.job}" any more, so nothing was started.`);
    // The job's own target, as the request was filed for, and only as an id.
    if (row.target !== job.target) return deny(`The request names a target that isn't the job's own (the job changed since it was filed), so nothing was started.`);
    const target = (await this.deps.runners()).find((r) => r.id === job.target);
    if (!target) return deny(`The job "${job.name}" runs on the runner with id ${job.target}, and no runner with that id is known, so nothing was started.`);
    if (!(JOB_MODES as readonly string[]).includes(job.mode)) return deny(`The job "${job.name}" has a permission mode this runner doesn't know, so nothing was started.`);
    const names = Object.keys(job.params);
    const given = Object.keys(row.params ?? {});
    if (names.length !== given.length || !names.every((n) => has(row.params, n) && typeof row.params[n] === 'string')) return deny(`The request's parameters don't fit the job "${job.name}" any more, so nothing was started.`);
    // The values again, against the job as it is now: the owner may have changed it since the request was filed.
    if (valuesProblem(job, row.params) !== null) return deny(`The request's values don't fit the job "${job.name}" any more, so nothing was started.`);
    // Left pending for a Mac that is only away for now; denied once it has been too long.
    if (!target.self && target.online === false) {
      if (this.deps.now() - row.createdAt < OFFLINE_WAIT_MS) return;
      return deny(`${target.name} is offline, so nothing was started.`);
    }
    // The job's mode goes on as it is, a plan too: relay.create sends Plan to another Mac in a way an older runner reads as Ask (remoteCreateMode).
    const mode = job.mode as JobMode;
    const text = jobHeader(job, row) + fillBrief(job.brief, row.params, job.params);
    await this.run(this.remember({ row, stage: 'claim', claim: crypto.randomUUID(), text, mode, target }));
  }

  private remember(w: Work): Work {
    this.work.set(w.row.requestId, w);
    return w;
  }

  private done(w: Work): void {
    this.work.delete(w.row.requestId);
    this.finished.add(w.row.requestId);
    if (this.finished.size > FINISHED_KEPT) this.finished.delete(this.finished.values().next().value as string);
  }

  // Runs a request's steps from where it is, to its end or to the step that failed.
  private async run(w: Work): Promise<void> {
    const backend = this.deps.backend();
    if (!backend) return;
    const { row } = w;
    const decide = (state: 'claimed' | 'allowed' | 'pending' | 'denied', extra: { result?: Work['result']; claim?: string; jobStart?: boolean } = {}) => backend.decideRequest({ requestId: row.requestId, docId: row.docId, state, ...extra });
    for (;;) {
      if (w.stage === 'claim') {
        try {
          await decide('claimed', { claim: w.claim, jobStart: true });
        } catch (e) {
          // Another claim or a decision has it: not ours to start.
          if (refused(e)) return this.done(w);
          throw e;
        }
        w.claimed = true;
        w.stage = 'start';
      } else if (w.stage === 'start') {
        const { target } = w;
        if (!target || w.text === undefined || w.mode === undefined) return this.done(w);
        // From here a thread may exist: this step is never asked again.
        try {
          const made = target.self
            ? await this.deps.createHere({ text: w.text, permissionMode: w.mode, startedBy: { kind: 'thread', label: row.runnerName, threadId: row.threadId, why: `Job ${row.job}` } })
            : await this.deps.createThere(target.id, { text: w.text, permissionMode: w.mode });
          w.result = { runnerId: target.id, runnerName: target.name, threadId: made.id };
          w.stage = 'allow';
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          // Turned down, or never sent: nothing exists. Anything else may.
          const nothing = wasNotSent(e) || (e instanceof RpcError && e.code === ErrorCode.badParams);
          w.reason = nothing ? `${target.name} couldn't start the job (${why}), so nothing was started.` : `${target.name} didn't say it started the job (${why}). It may have started: look there before asking again.`;
          w.stage = 'deny';
        }
      } else if (w.stage === 'allow') {
        try {
          await decide('allowed', { result: w.result, jobStart: true });
        } catch (e) {
          if (!refused(e)) throw e;
        }
        this.deps.log.info('started a job', { requestId: row.requestId, job: row.job, runnerId: w.result?.runnerId, threadId: w.result?.threadId });
        await this.deps.respondThere?.(row.threadId, row.requestId, 'allow').catch(() => undefined);
        return this.done(w);
      } else {
        try {
          // Never through pending: a crash between the two would leave the row pending, and the next tick would start a second thread.
          await decide('denied', w.claimed ? { jobStart: true } : {});
        } catch (e) {
          if (!refused(e)) throw e;
        }
        this.deps.log.info('denied a job request', { requestId: row.requestId, job: row.job, reason: w.reason });
        if (w.reason) await this.deps.respondThere?.(row.threadId, row.requestId, 'deny', w.reason).catch(() => undefined);
        return this.done(w);
      }
    }
  }
}
