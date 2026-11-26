// `tb job list|set|remove` (docs/protocol/runners.md, "Jobs"): on the main Mac,
// whose secrets/convex-key is the owner key, reads and writes the named jobs a
// runner key's Mac may ask it to start on another Mac. Straight to the backend
// over HTTP (relay:jobsList, relay:setJobs), so it needs no runner. Only the
// owner key writes jobs, so a Mac with a runner key is refused here, before
// any call; the backend's own checks are the real validation.
import fs from 'node:fs';
import type { Config } from './config.ts';
import { clean } from './runner-keys.ts';
import { convexPoster, readSyncKey, type Post } from './sync.ts';

export type JobDeps = { post?: Post; print?: (s: string) => void; fail?: (s: string) => void };

// A job as relay:jobsList answers it: the fields setJobs takes, and when it was written.
type StoredJob = { name: string; target: string; repos: string[]; params: Record<string, string>; mode: string; perHour: number; brief: string; updatedAt?: number };

const USAGE = [
  'tb job list: the jobs, on the main Mac.',
  'tb job set <file.json>: replaces the whole list of jobs with the array in that file (the shape relay:setJobs takes: name, target, repos, params, mode, perHour, brief). A job not in the file is gone; [] clears them all.',
  'tb job remove <name>: drops that one job and keeps the rest.',
].join('\n');

export async function jobCommand(cfg: Pick<Config, 'home' | 'sync'>, args: string[], deps: JobDeps = {}): Promise<number> {
  const print = deps.print ?? ((s) => console.log(s));
  const fail = (s: string) => {
    (deps.fail ?? ((t) => console.error(t)))(s);
    return 1;
  };
  const url = cfg.sync.url;
  const key = readSyncKey(cfg.home);
  if (cfg.sync.urlRefused) return fail(`This Mac doesn't mirror to Convex: ${cfg.sync.urlRefused}.`);
  if (!url || !key) return fail("This Mac doesn't mirror to Convex (no sync.url in runner.json, or no secrets/convex-key), so it has no jobs to manage. Run ./threadbear setup first.");
  // A runner key can't write jobs: say so here rather than send it to be refused.
  if (key.startsWith('tbr_')) return fail('Jobs are written on the main Mac, which has the main key; this Mac has a runner key of its own. Run tb job there.');
  const post = deps.post ?? convexPoster(url);
  const [sub, ...rest] = args;
  try {
    if (sub === 'list' || sub === undefined) {
      if (rest.length) return fail(USAGE);
      const jobs = await stored(post, key);
      if (!jobs.length) return print('No jobs. tb job set <file.json> defines them.'), 0;
      const names = await runnerNames(post, key);
      for (const j of jobs) for (const line of describe(j, names)) print(line);
      return 0;
    }
    if (sub === 'set') {
      if (rest.length !== 1 || !rest[0]) return fail(USAGE);
      let raw: string;
      try {
        raw = fs.readFileSync(rest[0], 'utf8');
      } catch (e) {
        return fail(`Couldn't read ${clean(rest[0], 200)}: ${clean((e as Error).message, 200)}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return fail(`${clean(rest[0], 200)} isn't valid JSON (${clean((e as Error).message, 200)}).`);
      }
      if (!Array.isArray(parsed)) return fail(`${clean(rest[0], 200)} must hold an array of jobs, even for one job: [ { "name": ... } ]. tb job set replaces the whole list.`);
      await post('mutation', 'relay:setJobs', { key, jobs: parsed });
      print(`Set ${parsed.length} job${parsed.length === 1 ? '' : 's'}; any other job is gone.`);
      return 0;
    }
    if (sub === 'remove') {
      const name = rest[0]?.trim();
      if (!name || rest.length !== 1) return fail(USAGE);
      // Reads the list, then replaces it whole: a set landing in between is overwritten (the main Mac is the only writer).
      const jobs = await stored(post, key);
      const kept = jobs.filter((j) => j.name !== name);
      if (kept.length === jobs.length) return fail(`There is no job named ${clean(name, 60)} (tb job list shows them).`);
      await post('mutation', 'relay:setJobs', { key, jobs: kept.map(({ updatedAt: _updatedAt, ...j }) => j) });
      print(`Removed ${clean(name, 60)}; ${kept.length} job${kept.length === 1 ? '' : 's'} left.`);
      return 0;
    }
    return fail(USAGE);
  } catch (e) {
    if (/could not find (public )?function/i.test(String((e as Error)?.message))) return fail('The Convex backend is older than this runner (it has no jobs yet). It deploys with the runner\'s next update; try again in a few minutes.');
    return fail(clean((e as Error)?.message, 1000));
  }
}

async function stored(post: Post, key: string): Promise<StoredJob[]> {
  const rows = await post('query', 'relay:jobsList', { key });
  return Array.isArray(rows) ? (rows as StoredJob[]) : [];
}

// Runner id to name, for the list: only a convenience, so a failed look is no names.
async function runnerNames(post: Post, key: string): Promise<Map<string, string>> {
  try {
    const rows = (await post('query', 'sync:runnersList', { key })) as { runnerId: string; name?: string }[];
    return new Map(rows.filter((r) => typeof r?.runnerId === 'string' && r.name).map((r) => [r.runnerId, clean(r.name, 60)]));
  } catch {
    return new Map();
  }
}

function describe(j: StoredJob, names: Map<string, string>): string[] {
  const name = names.get(j.target);
  const params = Object.entries(j.params ?? {}).map(([n, kind]) => `${clean(n, 40)} (${clean(kind, 10)})`);
  return [
    `${clean(j.name, 60)}  ->  ${clean(j.target, 64)}${name ? ` (${name})` : ''}`,
    `  repos: ${(j.repos ?? []).map((r) => clean(r, 140)).join(', ')}`,
    `  params: ${params.length ? params.join(', ') : 'none'}`,
    `  mode: ${clean(j.mode, 10)}, ${Number(j.perHour)} an hour`,
    '  brief:',
    // The brief keeps its own lines; each is cleaned of control characters.
    ...String(j.brief ?? '').split('\n').map((l) => `    ${clean(l, 4000)}`),
    '',
  ];
}
