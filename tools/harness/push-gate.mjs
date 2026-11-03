import { mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './io.mjs';
import { classifyHarnessChange, selectHarnessTests } from './harness-tests.mjs';
import { configSchema } from './schemas.mjs';
import { git } from './workspace.mjs';
// pre-push scope (#288): fast feedback only. It runs the Harness tests that name a changed module; the verifiers, the Full Gate and
// whatever the gate cannot narrow run in CI, and a push to main runs everything.
const zero = /^0{40}$/;

export function planPushGate({ refs, head, fallbackBase }) {
  const lines = refs.split('\n').filter(Boolean).map(line => line.split(' '));
  if (!lines.length || lines.some(parts => parts.length !== 4)) return { mode: 'unscoped', shas: [head], reasons: ['push refs unknown'] };
  const pushed = lines.filter(([, localSha]) => !zero.test(localSha));
  if (!pushed.length) return { mode: 'skip', reasons: ['delete only'] };
  if (pushed.length > 1) return { mode: 'unscoped', shas: [...new Set(pushed.map(([, localSha]) => localSha))], reasons: ['several refs pushed'] };
  const [, localSha, remoteRef, remoteSha] = pushed[0];
  if (!zero.test(remoteSha)) return { mode: 'impact', shas: [localSha], base: remoteSha, reasons: [`remote:${remoteRef}`] };
  if (!fallbackBase) return { mode: 'unscoped', shas: [localSha], reasons: ['no base for a new branch'] };
  return { mode: 'impact', shas: [localSha], base: fallbackBase, reasons: [`new-branch:${fallbackBase}`] };
}

const resolves = async (root, ref) => (await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true)).ok;

// The working tree may hold uncommitted fixes, so the tests run in a detached worktree of the pushed commit outside the checkout.
// Cleanup never forces: a worktree that the tests left dirty is kept and reported.
async function inPushedCommit({ root, sha, log, leftovers }, fn) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'sonomama-push-gate-')));
  const workspace = join(parent, 'tree');
  try { await git(root, ['worktree', 'add', '--detach', workspace, sha]); } catch (error) { await rmdir(parent); throw error; }
  try {
    log(`Push gate worktree: ${sha} at ${workspace}`);
    return await fn(workspace);
  } finally {
    const removed = await git(root, ['worktree', 'remove', workspace], true);
    if (removed.ok) await rmdir(parent);
    else {
      leftovers.push(workspace);
      log(`Push gate worktree kept: ${workspace} (${removed.stderr.trim() || 'git worktree remove failed'})`);
    }
  }
}

export async function runPushGate({ root, refs, runTests, install, log = () => {} }) {
  const config = configSchema.parse(await readJson(join(root, '.harness/config/harness.json')));
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const fallback = `${config.github.remote}/${config.github.base}`;
  let plan = planPushGate({ refs, head, fallbackBase: await resolves(root, fallback) ? fallback : null });
  if (plan.mode === 'impact' && !await resolves(root, plan.base)) plan = { ...plan, mode: 'unscoped', base: undefined, reasons: ['remote commit unknown locally'] };
  log(`Push gate: ${plan.mode} (${plan.reasons.join(', ')})`);
  if (plan.mode !== 'impact') {
    if (plan.mode === 'unscoped') log('Push gate: Harness tests and verifiers are left to CI');
    return { ...plan, passed: true, leftovers: [] };
  }
  const [sha] = plan.shas;
  const mergeBase = (await git(root, ['merge-base', plan.base, sha])).stdout.trim();
  const files = (await git(root, ['diff', '--no-renames', '--name-only', '-z', mergeBase, sha])).stdout.split('\0').filter(Boolean).map(path => ({ path }));
  // An application or document change selects no Harness test, and a change no import can scope is CI's; neither needs a worktree.
  const change = classifyHarnessChange({ config, files });
  if (change.all) log(`Push gate: every Harness test is needed (${change.reasons.join(', ')}); CI runs them`);
  if (change.all || !change.modules.length) return { ...plan, tests: [], passed: true, leftovers: [] };
  const leftovers = [];
  let tests = [];
  const passed = await inPushedCommit({ root, sha, log, leftovers }, async workspace => {
    ({ tests } = await selectHarnessTests({ root: workspace, config, files }));
    log(`Push gate: Harness tests ${tests.length ? tests.join(' ') : '(none)'}`);
    return !tests.length || (await install(workspace) && await runTests(workspace, tests));
  });
  return { ...plan, tests, passed, leftovers };
}
