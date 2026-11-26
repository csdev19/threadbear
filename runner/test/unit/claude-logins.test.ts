// runner.json claudeLogins (experiment claudeLogins): existing
// CLAUDE_CONFIG_DIR folders as Claude logins, their path kept exactly as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeLogins } from '../../src/config.ts';
import { discoverAccounts } from '../../src/accounts.ts';
import { cliEnv } from '../../src/adapters/claude/adapter.ts';

const H = '/Users/x';
const parse = (raw: unknown) => parseClaudeLogins(raw, H);

test('id comes from the folder name without its dot; an explicit id wins', () => {
  assert.deepEqual(parse([{ dir: '~/.claude-personal' }]).logins, [{ id: 'claude-personal', dir: `${H}/.claude-personal` }]);
  assert.deepEqual(parse([{ id: 'work', dir: '~/.claude-personal' }]).logins, [{ id: 'work', dir: `${H}/.claude-personal` }]);
  assert.deepEqual(parse([{ dir: '/opt/foo' }]).logins, [{ id: 'foo', dir: '/opt/foo' }]);
});

test('only the tilde is expanded, as a string', () => {
  assert.equal(parse([{ id: 'a', dir: '~/.x' }]).logins[0].dir, `${H}/.x`);
  assert.equal(parse([{ id: 'a', dir: '~/.x/' }]).logins[0].dir, `${H}/.x/`);
  assert.equal(parse([{ id: 'a', dir: '~/a//b' }]).logins[0].dir, `${H}/a//b`);
  assert.equal(parse([{ id: 'a', dir: '/opt/../x' }]).logins[0].dir, '/opt/../x');
});

test('bad entries are dropped with an error naming them', () => {
  const bad: [unknown, RegExp][] = [
    [{ id: 'claude-main', dir: '~/.a' }, /claude-main.*clash/],
    [{ id: 'claude-3', dir: '~/.a' }, /claude-3.*clash/],
    [{ id: 'codex-main', dir: '~/.a' }, /codex-main.*clash/],
    [{ id: 'codex-7', dir: '~/.a' }, /codex-7.*clash/],
    [{ dir: '~/.claude' }, /claude-main/],
    [{ id: 'y', dir: '~/.claude/' }, /claude-main/],
    [{ id: 'y', dir: '~' }, /home folder/],
    [{ id: 'bad id', dir: '~/.a' }, /bad id.*id must be/],
    [{ id: 'x' }, /dir/],
    [{ id: 'x', dir: '' }, /dir/],
    ['nope', /dir/],
    [{ id: 'x', dir: 'rel/path' }, /x.*rel\/path.*absolute/],
  ];
  for (const [entry, re] of bad) {
    const r = parse([entry]);
    assert.deepEqual(r.logins, [], JSON.stringify(entry));
    assert.equal(r.errors.length, 1, JSON.stringify(entry));
    assert.match(r.errors[0], re);
  }
  const dup = parse([{ id: 'a', dir: '~/.a' }, { id: 'a', dir: '~/.b' }]);
  assert.equal(dup.logins.length, 1);
  assert.match(dup.errors[0], /a \(\/Users\/x\/\.b\).*earlier/);
  assert.deepEqual(parse(undefined), { logins: [], errors: [] });
});

function setup(experiment: boolean, hidden?: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-claude-logins-'));
  const home = path.join(root, 'runner');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: { claudeLogins: experiment } }));
  const userHome = path.join(root, 'user');
  const dir = path.join(userHome, '.claude-personal');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } }));
  const cfg = {
    claudeMainDir: path.join(userHome, '.claude'),
    claudeMainJson: path.join(userHome, '.claude.json'),
    tokenStatsAccountsDir: path.join(root, 'none'),
    userHome,
    pathEnv: '',
    home,
    hiddenLogins: hidden,
    claudeLogins: [
      { id: 'claude-personal', dir },
      { id: 'claude-later', dir: path.join(userHome, '.claude-later') },
    ],
  };
  return { cfg, dir };
}

test('a configured folder is a Claude login with its email and exact path', () => {
  const { cfg, dir } = setup(true);
  const accounts = discoverAccounts(cfg);
  const a = accounts.find((x) => x.id === 'claude-personal')!;
  assert.equal(a.provider, 'claude');
  assert.equal(a.email, 'a@b.c');
  assert.equal(a.configDir, dir);
  assert.equal(accounts.some((x) => x.id === 'claude-later'), false, 'a missing folder is skipped');
  assert.equal(cliEnv(a, {}).CLAUDE_CONFIG_DIR, dir);
});

test('experiment off: not discovered; hiddenLogins hides it', () => {
  assert.equal(discoverAccounts(setup(false).cfg).some((x) => x.id === 'claude-personal'), false);
  assert.equal(discoverAccounts(setup(true, ['claude-personal']).cfg).some((x) => x.id === 'claude-personal'), false);
});

test('a second entry for the same folder, however spelled, is dropped', () => {
  const r = parse([{ id: 'a', dir: '~/.p' }, { id: 'b', dir: '~/.p/' }]);
  assert.deepEqual(r.logins.map((l) => l.id), ['a']);
  assert.match(r.errors[0]!, /b.*already listed/);
});

test('a folder or id another login already has is skipped; notes apply', () => {
  const { cfg, dir } = setup(true);
  const numbered = path.join(path.dirname(cfg.tokenStatsAccountsDir), 'accounts');
  fs.mkdirSync(path.join(numbered, 'claude-1'), { recursive: true });
  fs.mkdirSync(cfg.claudeMainDir, { recursive: true });
  const accounts = discoverAccounts({
    ...cfg,
    accountsDir: numbered,
    accountNotes: { 'claude-personal': 'personal' },
    claudeLogins: [
      { id: 'claude-personal', dir },
      { id: 'again', dir: path.join(numbered, 'claude-1') + '/' },
      { id: 'main-again', dir: cfg.claudeMainDir },
    ],
  });
  assert.deepEqual(accounts.filter((a) => a.provider === 'claude').map((a) => a.id).filter((id) => id !== 'claude-main'), ['claude-1', 'claude-personal']);
  assert.equal(accounts.find((a) => a.id === 'claude-personal')!.note, 'personal');
});
