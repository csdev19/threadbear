// tb job (src/jobs-cli.ts): the main Mac lists, replaces and removes the named
// jobs (docs/protocol/runners.md, "Jobs") through relay:jobsList and relay:setJobs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { jobCommand } from '../../src/jobs-cli.ts';

const URL_ = 'https://opulent-moose-249.ap-southeast-2.convex.cloud';

const JOB = { name: 'fix-pr', target: 'cb921b2447ea', repos: ['acme/api', 'acme/web'], params: { repo: 'repo', pr: 'int' }, mode: 'auto', perHour: 6, brief: 'Fix PR {pr} in {repo}.\nRun the tests first.' } as const;
const OTHER = { name: 'nightly', target: 'cb921b2447ea', repos: ['acme/api'], params: {}, mode: 'plan', perHour: 1, brief: 'Look over main.' } as const;

function setup(key = 'owner-key', stored: unknown[] = [], names = true, runnerName = 'mac-mini') {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, 'secrets', 'convex-key'), key + '\n');
  const calls: { kind: string; fn: string; args: Record<string, unknown> }[] = [];
  const printed: string[] = [];
  const failed: string[] = [];
  let setError: Error | undefined;
  const state = { stored };
  const post = async (kind: string, fn: string, args: Record<string, unknown>) => {
    calls.push({ kind, fn, args });
    if (fn === 'relay:jobsList') return state.stored.map((j) => ({ ...(j as object), updatedAt: 1 }));
    if (fn === 'sync:runnersList') {
      if (!names) throw new Error('down');
      return [{ runnerId: 'cb921b2447ea', name: runnerName }];
    }
    if (fn === 'relay:setJobs') {
      if (setError) throw setError;
      state.stored = args.jobs as unknown[];
      return null;
    }
    throw new Error(`unexpected ${fn}`);
  };
  const run = (args: string[]) => jobCommand({ home, sync: { url: URL_ } } as never, args, { post, print: (s) => printed.push(s), fail: (s) => failed.push(s) });
  const file = (content: string) => {
    const f = path.join(home, 'jobs.json');
    fs.writeFileSync(f, content);
    return f;
  };
  return { run, calls, printed, failed, file, state, failSet: (e: Error) => (setError = e) };
}

test('list shows a job on its own lines: runner id and name, repos, params with types, mode, rate and brief', async () => {
  const t = setup('owner-key', [JOB]);
  assert.equal(await t.run(['list']), 0);
  const out = t.printed.join('\n');
  assert.match(out, /fix-pr/);
  assert.match(out, /cb921b2447ea \(mac-mini\)/);
  assert.match(out, /repos: acme\/api, acme\/web/);
  assert.match(out, /params: repo \(repo\), pr \(int\)/);
  assert.match(out, /mode: auto/);
  assert.match(out, /6 an hour/);
  assert.ok(t.printed.some((l) => l.trim() === 'Fix PR {pr} in {repo}.'));
  assert.ok(t.printed.some((l) => l.trim() === 'Run the tests first.'));
  assert.equal(t.calls.every((c) => c.fn !== 'relay:setJobs'), true);
});

test('list still prints the runner id when its name cannot be looked up, and says when there are no jobs', async () => {
  const t = setup('owner-key', [JOB], false);
  assert.equal(await t.run(['list']), 0);
  assert.match(t.printed.join('\n'), /cb921b2447ea/);
  const none = setup();
  assert.equal(await none.run(['list']), 0);
  assert.match(none.printed.join('\n'), /No jobs/);
});

test('list takes control characters out of a runner name', async () => {
  const t = setup('owner-key', [JOB], true, 'mini\u001b[31m\nred');
  assert.equal(await t.run(['list']), 0);
  assert.equal(t.printed.some((l) => l.includes('\u001b')), false);
  assert.match(t.printed.join('\n'), /cb921b2447ea \(mini red\)/);
});

test('set sends exactly the parsed array', async () => {
  const t = setup();
  const file = t.file(JSON.stringify([JOB, OTHER]));
  assert.equal(await t.run(['set', file]), 0);
  const call = t.calls.find((c) => c.fn === 'relay:setJobs');
  assert.deepEqual(call?.kind, 'mutation');
  assert.deepEqual(call?.args, { key: 'owner-key', jobs: [JOB, OTHER] });
  assert.match(t.printed.join('\n'), /2 jobs/);
});

test('set refuses a file that is not JSON, not an array, missing or unnamed, with no call', async () => {
  const t = setup();
  assert.equal(await t.run(['set', t.file('{not json')]), 1);
  assert.match(t.failed.join('\n'), /isn't valid JSON/);
  assert.equal(await t.run(['set', t.file(JSON.stringify(JOB))]), 1);
  assert.match(t.failed.join('\n'), /array/);
  assert.equal(await t.run(['set', path.join(tmpDir(), 'none.json')]), 1);
  assert.equal(await t.run(['set']), 1);
  assert.match(t.failed.join('\n'), /replaces the whole list/);
  assert.equal(t.calls.length, 0);
});

test('set prints the backend refusal plainly and exits non-zero', async () => {
  const t = setup();
  t.failSet(new Error('job "fix-pr": target is a runner\'s id, never its name'));
  assert.equal(await t.run(['set', t.file(JSON.stringify([JOB]))]), 1);
  assert.match(t.failed.join('\n'), /target is a runner's id, never its name/);
});

test('set [] clears the list', async () => {
  const t = setup('owner-key', [JOB]);
  assert.equal(await t.run(['set', t.file('[]')]), 0);
  assert.deepEqual(t.calls.find((c) => c.fn === 'relay:setJobs')?.args.jobs, []);
});

test('remove drops that job and sets the rest, exactly as the backend returned them without updatedAt', async () => {
  const t = setup('owner-key', [JOB, OTHER]);
  assert.equal(await t.run(['remove', 'fix-pr']), 0);
  assert.deepEqual(t.calls.find((c) => c.fn === 'relay:setJobs')?.args, { key: 'owner-key', jobs: [OTHER] });
  assert.match(t.printed.join('\n'), /Removed fix-pr/);
});

test('remove of a name that is not there says so, exits non-zero and sets nothing', async () => {
  const t = setup('owner-key', [JOB]);
  assert.equal(await t.run(['remove', 'nope']), 1);
  assert.match(t.failed.join('\n'), /no job named nope/i);
  assert.equal(t.calls.some((c) => c.fn === 'relay:setJobs'), false);
  assert.equal(await t.run(['remove']), 1);
});

test('a runner key is refused before any backend call, for every subcommand', async () => {
  const t = setup('tbr_runnerkey', [JOB]);
  for (const args of [['list'], [], ['set', t.file('[]')], ['remove', 'fix-pr']]) {
    assert.equal(await t.run(args), 1);
  }
  assert.equal(t.failed.length, 4);
  assert.match(t.failed[0]!, /main Mac/);
  assert.equal(t.calls.length, 0);
});

test('a Mac with no sync url or key is told to run setup, with no call', async () => {
  const home = tmpDir();
  const calls: string[] = [];
  const failed: string[] = [];
  const code = await jobCommand({ home, sync: { url: URL_ } } as never, ['list'], { post: async (_k, fn) => (calls.push(fn), []), fail: (s) => failed.push(s) });
  assert.equal(code, 1);
  assert.match(failed.join('\n'), /setup/);
  assert.equal(calls.length, 0);
});

test('an unknown subcommand prints the usage, which says set replaces the whole list', async () => {
  const t = setup();
  assert.equal(await t.run(['frob']), 1);
  assert.match(t.failed.join('\n'), /tb job list/);
  assert.match(t.failed.join('\n'), /replaces the whole list/);
});
