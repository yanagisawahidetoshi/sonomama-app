import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixturePrefix, sweepStaleFixtures } from './fixture-sweep.mjs';

// #268: a test process killed by a timeout or a crash never reaches its finally, so its fixture stays in TMPDIR. The next test
// process removes only the fixtures whose owner process has exited; anything it cannot attribute to a dead owner stays.
const dead = 2 ** 22 + 7;
const isAlive = pid => pid !== dead;
async function tempRoot(fn) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sonomama-sweep-test-')));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const make = async (dir, name) => { await mkdir(join(dir, name, '.git'), { recursive: true }); return join(dir, name); };

describe('Stale fixture sweep', () => {
  describe('given fixtures left in the temporary directory', () => {
    it('when the owner process has exited then its fixture and its template are removed', () => tempRoot(async dir => {
      const risk = await make(dir, `${fixturePrefix('risk', dead)}abc123`);
      const template = await make(dir, `${fixturePrefix('fixture-template', dead)}def456`);
      await sweepStaleFixtures({ dir, isAlive, worktrees: [] });
      assert.equal(existsSync(risk), false);
      assert.equal(existsSync(template), false);
    }));
    it('when the owner process is still running then its fixture is kept', () => tempRoot(async dir => {
      const live = await make(dir, `${fixturePrefix('risk', process.pid)}abc123`);
      await sweepStaleFixtures({ dir, isAlive, worktrees: [] });
      assert.equal(existsSync(live), true);
    }));
    it('when a directory names no owner process then it is kept, whatever its prefix', () => tempRoot(async dir => {
      const names = ['sonomama-risk-abc123', 'sonomama-fixture-template-def456', 'sonomama-push-gate-ghi789', `sonomama-isolation-${dead}-abc123`, `other-risk-${dead}-abc123`];
      for (const name of names) await make(dir, name);
      await sweepStaleFixtures({ dir, isAlive, worktrees: [] });
      assert.deepEqual((await readdir(dir)).sort(), names.sort());
    }));
    it('when a dead owner fixture is or contains a registered Git worktree then it is kept', () => tempRoot(async dir => {
      const registered = await make(dir, `${fixturePrefix('risk', dead)}abc123`);
      const parent = await make(dir, `${fixturePrefix('risk', dead)}def456`);
      await sweepStaleFixtures({ dir, isAlive, worktrees: [registered, join(parent, '.harness/runs/r1/workspace')] });
      assert.equal(existsSync(registered), true);
      assert.equal(existsSync(parent), true);
    }));
  });

});
