// The read tier (ADR 0002, docs/protocol/keys.md "The read tier") in the
// backend's own functions, against the in-memory database: how the flag is
// granted and cleared (AC12), what a key with it reaches, and what it never does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const MAIN = 'main00000001';
const LAPTOP = 'laptop000001';
const MINI = 'cb921b2447ea';

const sync = load('sync');
const relay = load('relay');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  return memoryBackend();
}
const add = (s: Awaited<ReturnType<typeof setup>>, runnerId: string, extra: Record<string, unknown> = {}) =>
  call(s.ctx, sync.addRunnerKey, { key: OWNER, runnerId, name: runnerId, ownerRunnerId: MAIN, ...extra }) as Promise<{ key: string }>;
const hb = (s: Awaited<ReturnType<typeof setup>>, key: string, runnerId: string) =>
  call(s.ctx, sync.heartbeat, { key, runner: { runnerId, name: runnerId, version: 'v', startedAt: '2026-11-26T00:00:00.000Z', draining: false, threadCount: 0 } }) as Promise<{ reads?: boolean }>;
const keyRow = (s: Awaited<ReturnType<typeof setup>>, runnerId: string) => s.rows('runnerKeys').filter((r) => r.runnerId === runnerId);
const thread = (threadId: string, runnerId: string) => ({ threadId, runnerId, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false });

test('addRunnerKey gives reads only when asked, and the heartbeat tells the key', async () => {
  const s = await setup();
  const plain = await add(s, MINI);
  const reader = await add(s, LAPTOP, { reads: true });
  assert.equal(keyRow(s, MINI)[0]!.reads, undefined);
  assert.equal(keyRow(s, LAPTOP)[0]!.reads, true);
  assert.equal((await hb(s, plain.key, MINI)).reads, undefined);
  assert.equal((await hb(s, reader.key, LAPTOP)).reads, true);
  // The owner's heartbeat never says it.
  assert.equal((await hb(s, OWNER, MAIN)).reads, undefined);
  // reads: false is the same as not asking.
  const off = await add(s, 'third0000001', { reads: false });
  assert.equal((await hb(s, off.key, 'third0000001')).reads, undefined);
});

test('a key with reads reads other runners as the owner does; one without is refused', async () => {
  const s = await setup();
  const reader = await add(s, LAPTOP, { reads: true });
  const plain = await add(s, MINI);
  await hb(s, OWNER, MAIN);
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('T1', MAIN)] });
  await call(s.ctx, sync.appendMessages, { key: OWNER, messages: [{ threadId: 'T1', seq: 1, role: 'assistant', text: 'hello from main', at: 'now' }] });
  await call(s.ctx, sync.setThreadIndex, { key: OWNER, runnerId: MAIN, rows: [{ threadId: 'T1', title: 'T', status: 'idle', needsYou: false, createdAt: '2026-11-26T00:00:00.000Z', lastActivityAt: '2026-11-26T00:00:00.000Z', cwd: '/x', accountId: 'a', provider: 'claude', unread: false, preview: '' }], removed: [] });
  const asReader = { key: reader.key, runnerId: LAPTOP };
  const runners = (await call(s.ctx, sync.otherRunnersList, asReader)) as { runnerId: string }[];
  assert.ok(runners.some((r) => r.runnerId === MAIN), 'the main Mac is listed');
  assert.ok(!runners.some((r) => r.runnerId === LAPTOP), 'not itself');
  const others = (await call(s.ctx, sync.otherRunnersThreads, asReader)) as { threads: { runnerId: string; threadId: string }[] };
  assert.ok(others.threads.some((r) => r.runnerId === MAIN && r.threadId === 'T1'), 'the seeded row comes back from otherRunnersThreads');
  const since = (await call(s.ctx, sync.threadIndexSince, { key: reader.key, runners: [{ runnerId: MAIN }] })) as { runnerId: string; threadId: string }[];
  assert.ok(since.some((r) => r.runnerId === MAIN && r.threadId === 'T1'), 'and from threadIndexSince');
  const tail = (await call(s.ctx, relay.remoteTail, { key: reader.key, threadId: 'T1' })) as { messages: { text: string }[] };
  assert.deepEqual(tail.messages.map((m) => m.text), ['hello from main']);
  assert.equal(((await call(s.ctx, relay.remoteMessages, { key: reader.key, threadId: 'T1' })) as { messages: unknown[] }).messages.length, 1);
  assert.equal(((await call(s.ctx, relay.remoteThread, { key: reader.key, threadId: 'T1' })) as { threadId: string }).threadId, 'T1');
  assert.deepEqual(await call(s.ctx, relay.picturesAtSeqs, { key: reader.key, threadId: 'T1', seqs: [1] }), []);
  // Without reads, today's refusals.
  for (const [fn, args] of [
    [sync.otherRunnersList, { runnerId: MINI }],
    [sync.otherRunnersThreads, { runnerId: MINI }],
    [sync.threadIndexSince, { runners: [{ runnerId: MAIN }] }],
    [relay.remoteTail, { threadId: 'T1' }],
    [relay.remoteMessages, { threadId: 'T1' }],
    [relay.remoteThread, { threadId: 'T1' }],
    [relay.picturesAtSeqs, { threadId: 'T1', seqs: [1] }],
  ] as const) assert.equal(await outcome(call(s.ctx, fn, { key: plain.key, ...args })), 'forbidden');
});

test('a key with reads never gets tool output, accounts, pools, the runner order or a write', async () => {
  const s = await setup();
  const reader = await add(s, LAPTOP, { reads: true });
  const key = reader.key;
  for (const [fn, args] of [
    [sync.remoteBody, { threadId: 'T1', seq: 1 }],
    [relay.remoteAccounts, { runnerId: MAIN }],
    [relay.remotePools, { runnerId: MAIN }],
    [sync.runnerOrder, {}],
    [relay.queueCommand, { runnerId: MAIN, kind: 'send', args: { text: 'x' } }],
    [relay.pictureUploadUrl, {}],
    [sync.setRunnerReads, { runnerId: LAPTOP, reads: false }],
    [sync.addRunnerKey, { runnerId: MINI, name: 'x', ownerRunnerId: MAIN, reads: true }],
  ] as const) assert.equal(await outcome(call(s.ctx, fn, { key, ...args })), 'forbidden');
  assert.equal(keyRow(s, LAPTOP)[0]!.reads, true);
});

test('AC12: revoke clears reads; a replacement has it only if asked again', async () => {
  const s = await setup();
  const first = await add(s, LAPTOP, { reads: true });
  // A key replaced without the flag has none, and the old key is dead.
  const second = await add(s, LAPTOP, { replace: true });
  assert.equal(await outcome(call(s.ctx, sync.otherRunnersList, { key: first.key, runnerId: LAPTOP })), 'auth');
  assert.equal(await outcome(call(s.ctx, sync.otherRunnersList, { key: second.key, runnerId: LAPTOP })), 'forbidden');
  assert.deepEqual(keyRow(s, LAPTOP).map((r) => [Boolean(r.revokedAt), r.reads === true]), [[true, false], [false, false]]);
  // Asked again, it has it.
  const third = await add(s, LAPTOP, { replace: true, reads: true });
  assert.equal((await hb(s, third.key, LAPTOP)).reads, true);
  assert.ok(keyRow(s, LAPTOP).every((r) => !r.reads || !r.revokedAt), 'no revoked row keeps reads');
  // Revoking clears it on the row, besides revokedAt, and the key is refused outright.
  assert.equal(await call(s.ctx, sync.revokeRunnerKey, { key: OWNER, runnerId: LAPTOP }), 1);
  assert.ok(keyRow(s, LAPTOP).every((r) => Boolean(r.revokedAt) && !r.reads));
  assert.equal(await outcome(call(s.ctx, sync.otherRunnersList, { key: third.key, runnerId: LAPTOP })), 'auth');
});

test('setRunnerReads grants and clears it on a live key, and does nothing for a runner with none', async () => {
  const s = await setup();
  const k = await add(s, LAPTOP);
  assert.equal(await outcome(call(s.ctx, sync.otherRunnersList, { key: k.key, runnerId: LAPTOP })), 'forbidden');
  assert.equal(await call(s.ctx, sync.setRunnerReads, { key: OWNER, runnerId: LAPTOP, reads: true }), 1);
  assert.equal((await hb(s, k.key, LAPTOP)).reads, true);
  assert.equal(await outcome(call(s.ctx, sync.otherRunnersList, { key: k.key, runnerId: LAPTOP })), 'ok');
  assert.equal(await call(s.ctx, sync.setRunnerReads, { key: OWNER, runnerId: LAPTOP, reads: false }), 1);
  assert.equal((await hb(s, k.key, LAPTOP)).reads, undefined);
  assert.equal(await outcome(call(s.ctx, sync.otherRunnersList, { key: k.key, runnerId: LAPTOP })), 'forbidden');
  // No live key (or a revoked one): 0, and a revoked row is never given it.
  assert.equal(await call(s.ctx, sync.setRunnerReads, { key: OWNER, runnerId: MINI, reads: true }), 0);
  await call(s.ctx, sync.revokeRunnerKey, { key: OWNER, runnerId: LAPTOP });
  assert.equal(await call(s.ctx, sync.setRunnerReads, { key: OWNER, runnerId: LAPTOP, reads: true }), 0);
  assert.ok(keyRow(s, LAPTOP).every((r) => !r.reads));
  // A bad id is refused as it arrives.
  assert.equal(await outcome(call(s.ctx, sync.setRunnerReads, { key: OWNER, runnerId: 'any', reads: true })), 'badArgs');
});

test('listRunnerKeys shows reads', async () => {
  const s = await setup();
  await add(s, LAPTOP, { reads: true });
  await add(s, MINI);
  const { keys } = (await call(s.ctx, sync.listRunnerKeys, { key: OWNER })) as { keys: { runnerId: string; reads?: boolean }[] };
  assert.equal(keys.find((k) => k.runnerId === LAPTOP)!.reads, true);
  assert.equal(keys.find((k) => k.runnerId === MINI)!.reads, undefined);
});
