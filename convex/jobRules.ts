// What a job and a job request may hold (docs/protocol/runners.md, "Jobs").
// Plain TypeScript with no Convex imports, like runnerAccess.ts, so the rules
// are one place and a unit test can read them. relay.ts applies them: setJobs
// to what the owner writes, fileRequest to what a runner key asks for.
//
// Every rule is an allow-list. A value reaches a brief the main Mac fills in
// and a thread on another Mac then reads, so a character that isn't named
// here is refused, never escaped.

export const JOB_NAME_MAX = 40;
export const JOB_BRIEF_MAX_BYTES = 4000;
export const JOB_PER_HOUR_MAX = 60;
export const JOBS_MAX = 50;
export const JOB_REPOS_MAX = 50;
export const JOB_PARAMS_MAX = 10;
export const BRANCH_MAX_BYTES = 200;
export const INT_MAX_DIGITS = 9;
export const JOB_MODES = ['ask', 'auto', 'plan', 'full'] as const;
export const PARAM_KINDS = ['repo', 'branch', 'int'] as const;
export type ParamKind = (typeof PARAM_KINDS)[number];

const JOB_NAME = /^[a-z0-9-]+$/;
const PARAM_NAME = /^[a-z][a-z0-9_]{0,31}$/;
// owner/name: GitHub's own characters. A name of dots alone is refused (`..`).
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_CHARS = /^[A-Za-z0-9._/+-]+$/;
const PLACEHOLDER = /\{([^{}\s"']*)\}/g;

export function validJobName(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= JOB_NAME_MAX && JOB_NAME.test(s);
}

export function validParamName(s: unknown): s is string {
  return typeof s === 'string' && PARAM_NAME.test(s);
}

export function validRepo(s: unknown): s is string {
  if (typeof s !== 'string' || !REPO.test(s)) return false;
  const name = s.split('/')[1]!;
  return name !== '.' && name !== '..';
}

/**
 * A git branch as a job may be asked about it: the characters git refs use
 * every day and none of its special ones (a space, `~^:?*[\`, `..`, `@{`, a
 * leading `-` that a command would take for an option), at most 200 bytes,
 * and the shape `git check-ref-format` wants: no empty, dot-leading or
 * `.lock`-ending part and no trailing `.`.
 */
export function validBranch(s: unknown): s is string {
  if (typeof s !== 'string' || s.length === 0 || s.length > BRANCH_MAX_BYTES || !BRANCH_CHARS.test(s)) return false;
  if (s.startsWith('-') || s.startsWith('/') || s.endsWith('/') || s.endsWith('.') || s.includes('..') || s.includes('//')) return false;
  return s.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** A positive whole number of at most 9 digits, as text: no sign, no space, no leading zero. */
export function validInt(s: unknown): s is string {
  return typeof s === 'string' && s.length <= INT_MAX_DIGITS && /^[1-9][0-9]*$/.test(s);
}

/** The `{name}` placeholders in a brief, in order. A brace holding anything but a lower-case word (JSON, `{Not Word}`) isn't one; a word in braces is one even after `$`, so a shell `${x}` counts as the placeholder `{x}`. */
export function placeholders(brief: string): string[] {
  return [...brief.matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((n) => PARAM_NAME.test(n));
}

export type JobDef = { name: string; target: string; repos: string[]; params: Record<string, ParamKind>; mode: (typeof JOB_MODES)[number]; perHour: number; brief: string };

/** What is wrong with a job as the owner wrote it, in words, or null. Shapes are the validators'; this is the content. */
export function jobProblem(j: JobDef, validTarget: (id: string) => boolean): string | null {
  const at = `job "${j.name}"`;
  if (!validJobName(j.name)) return `a job's name is 1 to ${JOB_NAME_MAX} of a-z, 0-9 and -`;
  if (!validTarget(j.target)) return `${at}: target is a runner's id, never its name`;
  if (j.repos.length < 1 || j.repos.length > JOB_REPOS_MAX) return `${at}: name 1 to ${JOB_REPOS_MAX} repos`;
  for (const r of j.repos) if (!validRepo(r)) return `${at}: "${r}" isn't an owner/name repo`;
  if (new Set(j.repos).size !== j.repos.length) return `${at}: a repo is listed twice`;
  const names = Object.keys(j.params);
  if (names.length > JOB_PARAMS_MAX) return `${at}: at most ${JOB_PARAMS_MAX} parameters`;
  for (const n of names) {
    if (!validParamName(n)) return `${at}: a parameter's name is a-z first, then a-z, 0-9 or _, at most 32`;
    if (!PARAM_KINDS.includes(j.params[n] as never)) return `${at}: ${n} must be one of ${PARAM_KINDS.join(', ')}`;
  }
  if (!JOB_MODES.includes(j.mode)) return `${at}: mode must be one of ${JOB_MODES.join(', ')}`;
  if (!Number.isInteger(j.perHour) || j.perHour < 1 || j.perHour > JOB_PER_HOUR_MAX) return `${at}: perHour is a whole number from 1 to ${JOB_PER_HOUR_MAX}`;
  if (!j.brief.trim()) return `${at}: a job needs a brief`;
  if (new TextEncoder().encode(j.brief).length > JOB_BRIEF_MAX_BYTES) return `${at}: the brief is over ${JOB_BRIEF_MAX_BYTES} bytes`;
  for (const p of placeholders(j.brief)) if (!Object.prototype.hasOwnProperty.call(j.params, p)) return `${at}: the brief uses {${p}}, which isn't a parameter`;
  return null;
}

/**
 * What is wrong with the parameters a request gives for a job, or null: the
 * same names the job has, no more and no fewer, each of its kind. A `repo` is
 * one of the job's own.
 */
export function paramsProblem(j: { repos: string[]; params: Record<string, string> }, given: Record<string, string>): string | null {
  const want = Object.keys(j.params);
  for (const n of Object.keys(given)) if (!want.includes(n)) return `${n} isn't a parameter of this job`;
  for (const n of want) {
    const value = given[n];
    if (value === undefined) return `${n} is missing`;
    const kind = j.params[n];
    if (kind === 'repo' && !j.repos.includes(value)) return `${n} isn't one of this job's repos`;
    if (kind === 'branch' && !validBranch(value)) return `${n} isn't a branch name this job takes`;
    if (kind === 'int' && !validInt(value)) return `${n} must be a positive whole number of at most ${INT_MAX_DIGITS} digits`;
  }
  return null;
}
