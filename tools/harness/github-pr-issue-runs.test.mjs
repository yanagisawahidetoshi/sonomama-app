import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './test-fixture.mjs';
import { exists, readJson } from './io.mjs';
import { startRun, issueUrl, planned, sbiIssue, home, agent, registered, withIssue } from './test-github-pr.mjs';

describe('GitHub PR Adapter', () => {
  // pnpm harness:run SBI_URL: the Issue a human marked ready is the only SBI input; nobody writes SBI JSON.
  describe('given a ready SBI Issue passed to harness:run as its URL', () => {
    const start = (root, options = {}) => startRun({ root, quiet: true, provider: 'codex', agent: agent(), publish: true, issueUrl, ...options });
    const runs = async root => (await readdir(join(root, '.harness/runs'))).filter(name => name !== '.gitkeep');

    it('when another SBI runs with --full after Issue #7 registered its Trusted Acceptance then that acceptance is not run for it', () => fixture(root => withIssue(root, sbiIssue(), async () => {
      const run = await startRun({ root, quiet: true, provider: 'fake', full: true });
      // --full also runs every real app verifier, which the fixture cannot pass; only issue-7-acceptance matters here.
      // The registration of Issue #7 is its own file, so a run of another SBI does not even load it.
      assert.equal(run.iterations.length > 0, true);
      for (const iteration of run.iterations) assert.equal(iteration.verification.checks.some(c => c.id === 'issue-7-acceptance'), false);
      assert.equal((await readJson(join(root, run.runDir, 'inputs.json'))).config.verifiers.some(v => v.id === 'issue-7-acceptance'), false);
    })));
    for (const labels of [['sbi', 'needs-review'], ['ready']]) {
      it(`when the Issue is labelled ${labels.join(' + ')} then no run, workspace or PR is created`, () => fixture(root => withIssue(root, sbiIssue(labels), async ({ github }) => {
        await assert.rejects(start(root), /ready|sbi label|needs-review/);
        assert.deepEqual(await runs(root), []);
        assert.deepEqual((await github.state()).pulls, []);
      })));
    }
    it('when an acceptance criterion has no registered Trusted Acceptance then fails before creating a run', () => fixture(root => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ acceptanceCriteria: [...planned().acceptanceCriteria, { id: 'AC-3', description: '未登録の要件' }] })), async () => {
      await assert.rejects(start(root), /AC-3/);
      assert.deepEqual(await runs(root), []);
    })));
    it('when the agent writes into a sibling directory sharing the prefix then the run escalates without writing it', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await start(root, { agent: agent('apps/admin-other/home.txt') });
      assert.equal(run.status, 'ESCALATED');
      assert.match(run.reason, /scope/);
      assert.equal(await exists(join(root, run.runDir, 'workspace/apps/admin-other/home.txt')), false);
      assert.deepEqual((await github.state()).pulls, []);
    })));
    it('when the same Issue is run twice then each run has its own ID, branch, snapshot and PR', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const first = await start(root), second = await start(root);
      assert.notEqual(first.id, second.id);
      const pulls = (await github.state()).pulls;
      assert.deepEqual(pulls.map(p => p.head.ref).sort(), [`harness/${first.id}`, `harness/${second.id}`].sort());
      assert.notEqual((await readJson(join(root, first.runDir, 'sbi-snapshot.json'))).runId, (await readJson(join(root, second.runDir, 'sbi-snapshot.json'))).runId);
    })));
    it('when the ready Issue is a level 3 candidate then the run opens the PR without an implementation gate', () => fixture(root => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ riskCandidate: 'L3' })), async ({ github }) => {
      const run = await start(root);
      assert.equal(run.gate.required, false);
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.risk.level, 3);
      assert.equal((await github.state()).pulls.length, 1);
    })));
  });
});
