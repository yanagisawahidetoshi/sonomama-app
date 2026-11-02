import { readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// #268: a fixture directory names the process that owns it, so a later test process can tell what a killed or timed out
// process left behind. Only these names are swept; a directory without an owner, or with a live one, is never touched.
export const fixturePrefix = (kind, pid = process.pid) => `sonomama-${kind}-${pid}-`;
const owned = /^sonomama-(?:risk|fixture-template)-(\d+)-[^/]+$/;
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
export async function sweepStaleFixtures({ dir: base = tmpdir(), isAlive = alive, worktrees }) {
  // Worktree paths are real paths; on macOS the temporary directory is reached through the /var symlink.
  const dir = await realpath(base);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const pid = Number(entry.name.match(owned)?.[1]);
    if (!entry.isDirectory() || !pid || isAlive(pid)) continue;
    const path = join(dir, entry.name);
    if (worktrees.some(worktree => worktree === path || worktree.startsWith(`${path}/`))) continue;
    await rm(path, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}
