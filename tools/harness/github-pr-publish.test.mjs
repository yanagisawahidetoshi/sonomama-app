import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, update, commitFixture } from './test-fixture.mjs';
import { openPullRequest } from './index.mjs';
import { git } from './workspace.mjs';
import { exists } from './io.mjs';
import { startRun, sbiPath, withRemote, remoteSha, advanceMain, sbiIssue, home, agent, withIssue, issueRun } from './test-github-pr.mjs';

describe('GitHub PR Adapter', () => {
  // #220: --sbi PATH is hand-written SBI JSON with no ready binding and no spec approval, so it stays a local self-test even with a real provider.
  // Only a run from a ready SBI Issue continues to the PR (given a ready SBI Issue passed to harness:run as its URL).
  describe('given harness:run --sbi with a real provider and a baseline on origin/main', () => {
    const good = 'export function greet(name) { return `こんにちは、${name?.trim() || "ゲスト"}さん`; }';
    const agent = content => async () => ({ files: [{ path: 'greeting.mjs', content }] });
    // The remote must exist before the run, so the run starts from the published baseline.
    const start = (root, options = {}) => startRun({ root, quiet: true, provider: 'codex', agent: agent(good), publish: true, sbiPath, ...options });
    const remoteFirst = (root, test) => commitFixture(root).then(() => withRemote(root, test));
    it('when local verification passes then it pushes nothing and opens no PR, because --sbi is a local self-test', () => fixture(root => remoteFirst(root, async ({ bare, github }) => {
      const run = await start(root);
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.publish, false);
      assert.equal(run.pullRequest, undefined);
      assert.equal(await remoteSha(bare, `harness/${run.id}`), '');
      assert.deepEqual((await github.state()).pulls, []);
    })));
    it('when harness:pr is run for the --sbi run then it refuses before pushing, so no PR comes from an SBI without an approved Issue', () => fixture(root => remoteFirst(root, async ({ bare, github }) => {
      const run = await start(root);
      await assert.rejects(openPullRequest({ root, runId: run.id, quiet: true }), /SBI Issue/);
      assert.equal(await remoteSha(bare, `harness/${run.id}`), '');
      assert.deepEqual((await github.state()).pulls, []);
    })));
    it('when local verification keeps failing then pushes nothing and opens no PR', () => fixture(root => remoteFirst(root, async ({ bare, github }) => {
      const run = await start(root, { agent: agent('export const greet = () => "wrong";') });
      assert.equal(run.status, 'ESCALATED');
      assert.equal(run.pullRequest, undefined);
      assert.equal(await remoteSha(bare, `harness/${run.id}`), '');
      assert.deepEqual((await github.state()).pulls, []);
    })));
    it('when no SBI is given and the configured sample SBI runs then opens no PR', () => fixture(root => remoteFirst(root, async ({ bare, github }) => {
      const run = await start(root, { sbiPath: undefined });
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(await remoteSha(bare, `harness/${run.id}`), '');
      assert.deepEqual((await github.state()).pulls, []);
    })));
    it('when the run uses the fake provider then opens no PR, so harness:demo never publishes', () => fixture(root => remoteFirst(root, async ({ github }) => {
      const run = await start(root, { provider: 'fake', agent: undefined });
      assert.equal(run.executionStatus, 'DONE');
      assert.deepEqual((await github.state()).pulls, []);
    })));
  });

  // #175: the approved SBI already classified its risks, so an unclassified risk raises the level but stops nothing before the PR.
  describe('given harness:run of an approved SBI with a risk no rule classifies', () => {
    const good = 'export function greet(name) { return `こんにちは、${name?.trim() || "ゲスト"}さん`; }';
    const agent = async () => ({ files: [{ path: 'greeting.mjs', content: good }] });
    it('when it runs then implements without an implementation gate and needs two humans, while the --sbi run opens no PR (#220)', () => fixture(async root => {
      await update(root, sbiPath, s => s.risks = ['外部サービス連携']);
      await commitFixture(root);
      await withRemote(root, async ({ github }) => {
        const run = await startRun({ root, quiet: true, provider: 'codex', agent, publish: true, sbiPath });
        assert.equal(run.gate.required, false);
        assert.equal(run.executionStatus, 'DONE');
        assert.deepEqual((await github.state()).pulls, []);
        assert.equal(run.merge.requiredApprovals, 2);
      });
    }));
  });

  describe('given a run that cannot be published as is', () => {
    it('when the baseline is not on origin/main then refuses before pushing so the PR never carries untested commits', () => fixture(root => withIssue(root, sbiIssue(), async ({ bare, github }) => {
      const run = await issueRun(root);
      await assert.rejects(openPullRequest({ root, runId: run.id, quiet: true }), /origin\/main/);
      assert.equal(await remoteSha(bare, `harness/${run.id}`), '');
      assert.deepEqual((await github.state()).pulls, []);
    }, { publishBaseline: false })));
    it('when origin/main moved past the run baseline without a conflict then still opens the PR at the tested SHA', () => fixture(root => withIssue(root, sbiIssue(), async ({ bare, github }) => {
      const run = await issueRun(root);
      await advanceMain(root, run.baselineSha);
      await openPullRequest({ root, runId: run.id, quiet: true });
      assert.equal(await remoteSha(bare, `harness/${run.id}`), run.headSha);
      assert.equal((await github.state()).pulls.length, 1);
    })));
    it('when origin/main changed the same lines as the run then refuses before pushing and names the conflict', () => fixture(root => withIssue(root, sbiIssue(), async ({ bare, github }) => {
      const run = await issueRun(root);
      const other = await mkdtemp(join(tmpdir(), 'sonomama-main-'));
      try {
        await git(root, ['worktree', 'add', '--detach', join(other, 'tree'), run.baselineSha]);
        await mkdir(join(other, 'tree', home, '..'), { recursive: true });
        await writeFile(join(other, 'tree', home), '別のホーム');
        await git(join(other, 'tree'), ['add', home]);
        await git(join(other, 'tree'), ['commit', '-m', 'someone else changed the home']);
        await git(join(other, 'tree'), ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
        await git(root, ['worktree', 'remove', join(other, 'tree')]);
      } finally { await rm(other, { recursive: true, force: true }); }
      await assert.rejects(openPullRequest({ root, runId: run.id, quiet: true }), /conflict/);
      assert.equal(await remoteSha(bare, `harness/${run.id}`), '');
      assert.deepEqual((await github.state()).pulls, []);
    })));
    it('when an open PR for the run branch targets another base then refuses instead of reusing it', () => fixture(root => withIssue(root, sbiIssue(), async ({ bare, github }) => {
      const run = await issueRun(root);
      await github.update(s => { s.pulls.push({ number: 9, title: 'x', body: '', state: 'open', merged: false, html_url: 'https://github.com/acme/app/pull/9', user: { login: 'harness-operator', type: 'User' },
        head: { ref: `harness/${run.id}`, sha: run.headSha }, base: { ref: 'develop', sha: run.baselineSha } }); });
      await assert.rejects(openPullRequest({ root, runId: run.id, quiet: true }), /develop/);
      assert.equal(await remoteSha(bare, `harness/${run.id}`), '');
      assert.equal((await github.state()).pulls.length, 1);
    })));
    it('when the PR branch already exists at another SHA then refuses instead of force pushing', () => fixture(root => withIssue(root, sbiIssue(), async ({ bare, github }) => {
      const run = await issueRun(root);
      await git(root, ['push', 'origin', `${run.baselineSha}:refs/heads/harness/${run.id}`]);
      await assert.rejects(openPullRequest({ root, runId: run.id, quiet: true }), /harness\/.*既に/);
      assert.equal(await remoteSha(bare, `harness/${run.id}`), run.baselineSha);
      assert.deepEqual((await github.state()).pulls, []);
    })));
    it('when execution has not completed then refuses to open a PR', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await issueRun(root, { agent: async () => ({ escalation: '仕様判断が必要', files: [] }) });
      assert.notEqual(run.executionStatus, 'DONE');
      await assert.rejects(openPullRequest({ root, runId: run.id, quiet: true }), /DONE/);
      assert.deepEqual((await github.state()).pulls, []);
    })));
  });
});
