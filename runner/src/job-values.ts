// The job value rules, as the main Mac re-checks them at start. A copy of
// paramsProblem and its validators in convex/jobRules.ts: the runner is
// deployed without convex/, so it can't import them. test/unit/job-values.test.ts
// holds the two to the same verdicts.

const BRANCH_MAX_BYTES = 200;
const INT_MAX_DIGITS = 9;
const BRANCH_CHARS = /^[A-Za-z0-9._/+-]+$/;

function validBranch(s: unknown): s is string {
  if (typeof s !== 'string' || s.length === 0 || s.length > BRANCH_MAX_BYTES || !BRANCH_CHARS.test(s)) return false;
  if (s.startsWith('-') || s.startsWith('/') || s.endsWith('/') || s.endsWith('.') || s.includes('..') || s.includes('//')) return false;
  return s.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

function validInt(s: unknown): s is string {
  return typeof s === 'string' && s.length <= INT_MAX_DIGITS && /^[1-9][0-9]*$/.test(s);
}

/** What is wrong with the values a request gives for the job as it is now, or null. */
export function valuesProblem(j: { repos: string[]; params: Record<string, string> }, given: Record<string, string>): string | null {
  const want = Object.keys(j.params);
  for (const n of Object.keys(given)) if (!want.includes(n)) return `${n} isn't a parameter of this job`;
  for (const n of want) {
    const value = given[n];
    if (typeof value !== 'string') return `${n} is missing`;
    const kind = j.params[n];
    if (kind === 'repo' && !j.repos.includes(value)) return `${n} isn't one of this job's repos`;
    if (kind === 'branch' && !validBranch(value)) return `${n} isn't a branch name this job takes`;
    if (kind === 'int' && !validInt(value)) return `${n} must be a positive whole number of at most ${INT_MAX_DIGITS} digits`;
  }
  return null;
}
