import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, human } from './test-fixture.mjs';
import { openPullRequest, resumeRun } from './index.mjs';
import { recordDecision } from './human-approvals.mjs';
import { readJson } from './io.mjs';
import { succeed, advanceMain, reviewBy, sbiIssue, withIssue, issueRun } from './test-github-pr.mjs';

describe('GitHub PR Adapter', () => {
  describe('given a completed level 2 run whose baseline is on origin/main', () => {
    it('when a GitHub ruleset requires another check then that check must pass too', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await issueRun(root);
      await github.update(s => { s.rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint' }] } }]; });
      const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
      await succeed(github, run.headSha);
      await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', run.headSha);
      const blocked = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(blocked.status, 'BLOCKED');
      await succeed(github, run.headSha, 'lint');
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'MERGE_ALLOWED');
    })));
    it('when the ruleset requires the check from a specific app then a same-named check from another app does not pass', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await issueRun(root);
      await github.update(s => { s.rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'harness', integration_id: 15368 }] } }]; });
      const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
      await succeed(github, run.headSha, 'harness', 999);
      await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', run.headSha);
      const blocked = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(blocked.status, 'BLOCKED');
      assert.ok(blocked.merge.reasons.includes('required_ci_not_passed'));
      await succeed(github, run.headSha, 'harness', 15368);
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'MERGE_ALLOWED');
    })));
    it('when only a reviewer with read permission approves then it does not count toward merge', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await issueRun(root);
      const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
      await github.update(s => { s.permissions.carol = 'read'; });
      await succeed(github, run.headSha);
      await reviewBy(github, pullRequest.number, 'carol', 'APPROVED', run.headSha);
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'WAITING_FOR_HUMAN_REVIEW');
      assert.deepEqual((await readJson(join(root, run.runDir, 'github-state.json'))).reviews.permissions, { carol: 'read' });
    })));
    it('when the reviewer permission cannot be read then the approval is not counted', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await issueRun(root);
      const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
      await github.update(s => { s.permissions.alice = 'forbidden'; });
      await succeed(github, run.headSha);
      await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', run.headSha);
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'WAITING_FOR_HUMAN_REVIEW');
    })));
    it('when origin/main moves after the PR was opened then resume still allows merge with CI and approval, without re-verification', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await issueRun(root);
      const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
      await succeed(github, run.headSha);
      await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', run.headSha);
      await advanceMain(root, run.baselineSha);
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'MERGE_ALLOWED');
    })));
    it('when GitHub reports the PR conflicts with origin/main then resume blocks on the conflict', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await issueRun(root);
      const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
      await succeed(github, run.headSha);
      await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', run.headSha);
      await github.update(s => { s.pulls.find(p => p.number === pullRequest.number).mergeable = false; });
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'BLOCKED');
      assert.ok(resumed.merge.reasons.includes('merge_conflict'));
    })));
    it('when a local merge approval is attempted in PR mode then refuses it in favour of GitHub Review', () => fixture(root => withIssue(root, sbiIssue(), async () => {
      const run = await issueRun(root);
      await openPullRequest({ root, runId: run.id, quiet: true });
      await assert.rejects(recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') }), /GitHub Review/);
    })));
    it('when harness:pr runs again then reuses the open PR instead of creating another', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await issueRun(root);
      const first = await openPullRequest({ root, runId: run.id, quiet: true });
      const second = await openPullRequest({ root, runId: run.id, quiet: true });
      assert.equal(second.pullRequest.number, first.pullRequest.number);
      assert.equal((await github.state()).pulls.length, 1);
    })));
  });
});
