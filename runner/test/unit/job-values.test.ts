// The runner's copy of the job value rules (src/job-values.ts) agrees with the
// backend's (convex/jobRules.ts): the runner is deployed without convex/, so it
// can't import them, and a value is checked again at start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valuesProblem } from '../../src/job-values.ts';
import { paramsProblem } from '../../../convex/jobRules.ts';

const JOB = { repos: ['csdev19/threadbear', 'a/b'], params: { repo: 'repo', branch: 'branch', pr: 'int' } };
const OK = { repo: 'csdev19/threadbear', branch: 'feature/x', pr: '42' };

const CASES: Record<string, string>[] = [
  OK,
  { ...OK, repo: 'other/repo' },
  { ...OK, repo: '' },
  { ...OK, branch: '' },
  { ...OK, branch: '-rf' },
  { ...OK, branch: 'a..b' },
  { ...OK, branch: 'a b' },
  { ...OK, branch: 'x.lock' },
  { ...OK, branch: 'a'.repeat(201) },
  { ...OK, pr: '0' },
  { ...OK, pr: '007' },
  { ...OK, pr: '1234567890' },
  { ...OK, pr: '12a' },
  { ...OK, pr: 'feature/x' },
  { repo: OK.repo, branch: OK.branch },
  { ...OK, extra: 'x' },
  {},
];

test('the runner copy gives the same verdict as the backend rules on the same cases', () => {
  for (const given of CASES) {
    assert.equal(valuesProblem(JOB, given) === null, paramsProblem(JOB as never, given) === null, JSON.stringify(given));
  }
});

test('a kind changed since filing: an int value no longer fits a branch job, a branch value no longer fits an int', () => {
  assert.equal(valuesProblem({ repos: [], params: { pr: 'branch' } }, { pr: '-1' }) !== null, true);
  assert.equal(valuesProblem({ repos: [], params: { pr: 'int' } }, { pr: 'main' }) !== null, true);
  assert.equal(valuesProblem({ repos: [], params: { pr: 'branch' } }, { pr: '42' }), null);
});
