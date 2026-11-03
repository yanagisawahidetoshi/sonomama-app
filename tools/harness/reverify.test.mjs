import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture } from './test-fixture.mjs';
import * as harness from './index.mjs';
// These runs stand for the production path, so they connect a trusted AI Review adapter as #187 will (#175).
const aiReview = async ({ headSha }) => ({ adapter: 'test-adapter', headSha, status: 'PASS', reasons: [] });
const withAiReview = fn => options => fn({ semanticReviewer: aiReview, ...options });
const reverifyPullRequest = withAiReview(harness.reverifyPullRequest);
import { readRunState } from './run-store.mjs';
import { verifyReverifyLink } from './reverify.mjs';
import { git } from './workspace.mjs';
import { readJson } from './io.mjs';
import { issueUrl, home, spy, withPullRequestB, remoteSha, parents, isAncestor, mergeA } from './test-reverify.mjs';


// Issue #144: after main moves, the finished implementation of a PR is merged with the new main and re-verified by a new run,
describe('Re-verification of an existing PR after main moved', () => {
  describe('given A and B started from the same main and only A was merged', () => {
    it('when B is re-verified then its finished code is merged with the new main, verified without the implementation agent and pushed to the same PR as a fast-forward', () => fixture(root => withPullRequestB(root, async ({ bare, github, b, pullUrl }) => {
      const mainAfterA = await mergeA(root);
      const reverification = spy();
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true, agent: reverification.agent });
      assert.equal(reverification.calls.length, 0, 'the implementation agent is not called');
      assert.equal(run.executionStatus, 'DONE');
      assert.notEqual(run.id, b.id);
      assert.equal(run.kind, 'reverify');
      assert.equal(run.baselineSha, mainAfterA);
      assert.deepEqual(await parents(root, run.headSha), [mainAfterA, b.headSha], 'the candidate is a merge commit of the new main and the old tested SHA');
      assert.equal(await remoteSha(bare, `harness/${b.id}`), run.headSha);
      assert.ok(await isAncestor(root, b.headSha, run.headSha), 'the PR branch moved forward without a force push');
      assert.equal(run.reverify.parentRunId, b.id);
      assert.equal(run.reverify.previousTestedSha, b.headSha);
      assert.equal(run.reverify.publish, 'PR_UPDATED');
      assert.match(run.reverify.sbiSnapshotDigest, /^[0-9a-f]{64}$/);
      assert.deepEqual(run.pullRequest, b.pullRequest);
      const pulls = (await github.state()).pulls;
      assert.equal(pulls.length, 1, 'no second PR');
      for (const text of [`run=${run.id} sha=${run.headSha}`, `Run ID: ${run.id}`, `tested SHA: ${run.headSha}`, `親run: ${b.id}`, `旧tested SHA: ${b.headSha}`, `baseline: ${mainAfterA}`, 'Closes #7', issueUrl, '元PBI: https://github.com/acme/app/issues/3'])
        assert.ok(pulls[0].body.includes(text), `PR body includes ${text}`);
    })));
    it('when B is re-verified then the SBI snapshot and Run trailer of B are kept, as the CI SBI source check requires', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      await mergeA(root);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      const snapshot = JSON.parse((await git(root, ['show', `${run.headSha}:.harness/state/sbi-7.json`])).stdout);
      assert.equal(snapshot.runId, b.id);
      assert.equal(run.snapshotVerification.verified, true, run.snapshotVerification.reasons.join('; '));
    })));
    it('when B is re-verified then the old run, its evidence and its tested SHA are left as they were', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      const before = await readJson(join(root, b.runDir, 'summary.json'));
      await mergeA(root);
      await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.deepEqual(await readJson(join(root, b.runDir, 'summary.json')), before);
      assert.equal((await readRunState(root, b.id)).headSha, b.headSha);
    })));
    it('when main gained an unrelated file then only the change of B is judged for scope, lane and risk', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      await mergeA(root, { 'docs/feature-a.md': '# Aの機能\n', 'apps/admin/src/feature-a.txt': 'A' });
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      const changes = await readJson(join(root, run.runDir, 'changes.json'));
      assert.deepEqual(changes.files.map(f => f.path).sort(), [home, '.harness/state/sbi-7.json'].sort());
      assert.equal(run.risk.level, b.risk.level);
      assert.equal(run.lane.name, 'production');
    })));
    it('when the head is re-verified then the new run is named in the PR head commit so a check reading only Git can link them', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      const mainAfterA = await mergeA(root);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      const link = await verifyReverifyLink({ root, base: mainAfterA, head: run.headSha });
      assert.deepEqual(link, { status: 'PASS', runId: run.id, parentRunId: b.id, baselineSha: mainAfterA, previousTestedSha: b.headSha, reasons: [] });
    })));
  });
});

describe('Link between a PR head and its re-verification run', () => {
  it('when the PR head is an ordinary Harness commit then it is reported as no re-verification, not as a failure', () => fixture(root => withPullRequestB(root, async ({ b }) => {
    const link = await verifyReverifyLink({ root, base: b.baselineSha, head: b.headSha });
    assert.equal(link.status, 'NONE');
  })));
  it('when a commit claims a parent run other than the one in the committed SBI snapshot then the link fails', () => fixture(root => withPullRequestB(root, async ({ b }) => {
    const forged = (await git(root, ['commit-tree', `${b.headSha}^{tree}`, '-p', b.headSha, '-m', 'Reverify\n\nHarness-Reverify-Run: 2026-10-29T00-00-00-000Z-aaaaaaaa\nHarness-Parent-Run: 2026-10-29T00-00-00-000Z-bbbbbbbb'])).stdout.trim();
    const link = await verifyReverifyLink({ root, base: b.baselineSha, head: forged });
    assert.equal(link.status, 'FAIL');
    assert.match(link.reasons.join('; '), /Harness-Parent-Run/);
  })));
  it('when a commit names a re-verification run but not its parent then the link fails', () => fixture(root => withPullRequestB(root, async ({ b }) => {
    const forged = (await git(root, ['commit-tree', `${b.headSha}^{tree}`, '-p', b.headSha, '-m', 'Reverify\n\nHarness-Reverify-Run: 2026-10-29T00-00-00-000Z-aaaaaaaa'])).stdout.trim();
    assert.equal((await verifyReverifyLink({ root, base: b.baselineSha, head: forged })).status, 'FAIL');
  })));
});
