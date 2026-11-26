// Start it from the phone on a runner key's free-text request (backend API
// 106, docs/protocol/runners.md "Asking another runner", "From the phone"):
// the phone reads the request as filed and queues a startRequest command for
// the main Mac, which re-reads the row before it starts anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const LAPTOP_KEY = 'tbr_laptop';
const LAPTOP = 'a1b2c3d4e5f6';
const MAIN = 'cb921b2447ea';
const TOKEN = 'phone-token';

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');
const relay = load('relay');

async function setup(opts: { mainOnline?: boolean; mainStarts?: boolean } = {}) {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  const now = Date.now();
  await b.ctx.db.insert('runnerKeys', { runnerId: LAPTOP, keyHash: await sha256(LAPTOP_KEY), name: 'laptop', createdAt: 1 });
  await b.ctx.db.insert('runners', { runnerId: LAPTOP, name: 'laptop', version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: now });
  await b.ctx.db.insert('runners', { runnerId: MAIN, name: 'M5', version: 'v', startedAt: 'x', draining: false, threadCount: 5, lastSeenAt: opts.mainOnline === false ? now - 3_600_000 : now, byOwner: true, ...(opts.mainStarts === false ? {} : { phoneStarts: true }) });
  await b.ctx.db.insert('tokens', { hash: await sha256(TOKEN), name: 'phone', kind: 'phone', expiresAt: now + 1e9, createdAt: now });
  await call(b.ctx, sync.upsertThreads, { key: LAPTOP_KEY, threads: [{ ...THREAD_BASICS, threadId: 'L', runnerId: LAPTOP, title: 'laptop thread', view: 'inbox', needsYou: false }] });
  const file = (requestId: string, request: Record<string, unknown> = { text: 'run the checks', title: 'Checks', cwd: '~/code/x', model: 'm', effort: 'low', permissionMode: 'auto', why: 'because' }, target = 'mac-mini') =>
    call(b.ctx, relay.fileRequest, { key: LAPTOP_KEY, requestId, threadId: 'L', target, request });
  const docId = (requestId: string) => String(b.rows('runnerRequests').find((r) => r.requestId === requestId)!._id);
  return { ...b, file, docId };
}

test('the phone reads a pending request as filed, with who asked', async () => {
  const s = await setup();
  await s.file('req-000001');
  const r = (await call(s.ctx, phone.startRequest, { token: TOKEN, threadId: 'L', approvalId: 'req-000001' })) as Record<string, unknown>;
  assert.deepEqual(r, {
    docId: s.docId('req-000001'), requestId: 'req-000001', threadId: 'L', runnerId: LAPTOP, runnerName: 'laptop', target: 'mac-mini',
    text: 'run the checks', title: 'Checks', cwd: '~/code/x', model: 'm', effort: 'low', permissionMode: 'auto', why: 'because', createdAt: r.createdAt,
  });
  await assert.rejects(call(s.ctx, phone.startRequest, { token: 'nope', threadId: 'L', approvalId: 'req-000001' }));
});

test('the phone reads nothing for another thread, a request that is not pending, a job, or one that is not there', async () => {
  const s = await setup();
  await s.file('req-000002');
  assert.equal(await call(s.ctx, phone.startRequest, { token: TOKEN, threadId: 'other', approvalId: 'req-000002' }), null);
  assert.equal(await call(s.ctx, phone.startRequest, { token: TOKEN, threadId: 'L', approvalId: 'req-gone' }), null);
  // A job request carries no text: the job decides it, so a phone can't start it.
  const row = s.rows('runnerRequests')[0]!;
  await s.ctx.db.insert('runnerRequests', { requestId: 'req-job-001', runnerId: LAPTOP, threadId: 'L', target: 'mac-mini', text: '', job: 'j', params: {}, createdAt: 1, state: 'pending', requestState: row.requestState });
  assert.equal(await call(s.ctx, phone.startRequest, { token: TOKEN, threadId: 'L', approvalId: 'req-job-001' }), null);
  await s.ctx.db.patch(row._id, { state: 'closed', requestState: { kind: 'closed', decidedAt: 1 } });
  assert.equal(await call(s.ctx, phone.startRequest, { token: TOKEN, threadId: 'L', approvalId: 'req-000002' }), null);
});

test('Start it queues a startRequest for the main Mac, with no thread of its own, and the main Mac takes it', async () => {
  const s = await setup();
  await s.file('req-000003');
  const commandId = await call(s.ctx, phone.startRequestNow, { token: TOKEN, threadId: 'L', approvalId: 'req-000003', docId: s.docId('req-000003') });
  const c = s.rows('commands').find((r) => r._id === commandId)!;
  assert.deepEqual({ runnerId: c.runnerId, threadId: c.threadId, kind: c.kind, args: c.args }, { runnerId: MAIN, threadId: undefined, kind: 'startRequest', args: { threadId: 'L', approvalId: 'req-000003', docId: s.docId('req-000003') } });
  const pending = (await call(s.ctx, sync.pendingCommands, { key: OWNER, runnerId: MAIN })) as { kind: string }[];
  assert.deepEqual(pending.map((p) => p.kind), ['startRequest']);
  assert.equal(await call(s.ctx, sync.takeCommand, { key: OWNER, commandId }), true);
  await call(s.ctx, sync.finishCommand, { key: OWNER, commandId, ok: true, result: JSON.stringify({ thread: { id: 'new1', runnerId: 'mini', runnerName: 'mac-mini' } }) });
  const done = (await call(s.ctx, phone.command, { token: TOKEN, commandId })) as { state: string; result?: unknown };
  assert.equal(done.state, 'done');
  assert.deepEqual(done.result, { thread: { id: 'new1', runnerId: 'mini', runnerName: 'mac-mini' } });
});

test('Start it is refused for a row that changed, one not pending, a job, and with no main Mac online', async () => {
  const s = await setup();
  await s.file('req-000004');
  const base = { token: TOKEN, threadId: 'L', approvalId: 'req-000004' };
  await assert.rejects(call(s.ctx, phone.startRequestNow, { ...base, docId: 'someotherdoc' }), /changed since the phone showed it/);
  await assert.rejects(call(s.ctx, phone.startRequestNow, { ...base, threadId: 'other', docId: s.docId('req-000004') }), /No such request/);
  await assert.rejects(call(s.ctx, phone.startRequestNow, { ...base, token: 'nope', docId: s.docId('req-000004') }));
  const row = s.rows('runnerRequests')[0]!;
  await s.ctx.db.patch(row._id, { state: 'claimed', requestState: { kind: 'claimed', claim: 'c' } });
  await assert.rejects(call(s.ctx, phone.startRequestNow, { ...base, docId: s.docId('req-000004') }), /being started/);
  await s.ctx.db.patch(row._id, { state: 'pending', requestState: { kind: 'pending' }, job: 'j' });
  await assert.rejects(call(s.ctx, phone.startRequestNow, { ...base, docId: s.docId('req-000004') }), /job/);
  assert.equal(s.rows('commands').length, 0);
  const off = await setup({ mainOnline: false });
  await off.file('req-000005');
  await assert.rejects(call(off.ctx, phone.startRequestNow, { token: TOKEN, threadId: 'L', approvalId: 'req-000005', docId: off.docId('req-000005') }), /main Mac is offline/);
  assert.equal(await outcome(call(off.ctx, phone.startRequestNow, { token: TOKEN, threadId: 'L', approvalId: 'req-000005', docId: off.docId('req-000005') })), 'badArgs');
});

// The button must not show when it can only fail: the main Mac says in its
// heartbeat that it takes the phone's start (multiMacJobs on), and the phone
// is offered nothing until it does.
test('the phone reads nothing while the main Mac does not report that it starts requests from the phone', async () => {
  const s = await setup({ mainStarts: false });
  await s.file('req-000006');
  assert.equal(await call(s.ctx, phone.startRequest, { token: TOKEN, threadId: 'L', approvalId: 'req-000006' }), null);
  // It reports it (the experiment turned on there): the same row is now offered.
  await call(s.ctx, sync.heartbeat, { key: OWNER, runner: { runnerId: MAIN, name: 'M5', version: 'v', startedAt: 'x', draining: false, threadCount: 5, phoneStarts: true } });
  assert.equal(s.rows('runners').find((r) => r.runnerId === MAIN)!.phoneStarts, true);
  assert.equal(((await call(s.ctx, phone.startRequest, { token: TOKEN, threadId: 'L', approvalId: 'req-000006' })) as { requestId: string }).requestId, 'req-000006');
  // A later heartbeat without it (experiment off, or an older runner) takes it away.
  await call(s.ctx, sync.heartbeat, { key: OWNER, runner: { runnerId: MAIN, name: 'M5', version: 'v', startedAt: 'x', draining: false, threadCount: 5 } });
  assert.equal(await call(s.ctx, phone.startRequest, { token: TOKEN, threadId: 'L', approvalId: 'req-000006' }), null);
});
