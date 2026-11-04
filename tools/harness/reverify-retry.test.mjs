import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, update } from './test-fixture.mjs';
import * as harness from './index.mjs';
import { openPullRequest } from './index.mjs';
// These runs stand for the production path, so they connect a trusted AI Review adapter as #187 will (#175).
const aiReview = async ({ headSha }) => ({ adapter: 'test-adapter', headSha, status: 'PASS', reasons: [] });
const withAiReview = fn => options => fn({ semanticReviewer: aiReview, ...options });
const reverifyPullRequest = withAiReview(harness.reverifyPullRequest);
import { githubPrCli } from './github-pr.mjs';
import { readRunState, saveRun } from './run-store.mjs';
import { exists } from './io.mjs';
import { planned, sbiIssue, acceptance, withPullRequestB, remoteSha, mergeA, runs } from './test-reverify.mjs';


// Issue #144: after main moves, the finished implementation of a PR is merged with the new main and re-verified by a new run,
describe('Re-verification of an existing PR after main moved', () => {

  describe('given the same re-verification is repeated', () => {
    it('when an earlier run stopped while preparing its candidate then it is not reused and a new run starts', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      await mergeA(root);
      const waiting = await reverifyPullRequest({ root, pullUrl, quiet: true });
      // The state a run is left in when it stops between creating its candidate and the preflight: no lane yet.
      const state = await readRunState(root, waiting.id);
      delete state.lane;
      state.status = 'PENDING'; state.executionStatus = 'PENDING'; state.iterations = []; state.reverify.publish = 'PREPARED';
      state.headSha = state.baselineSha;
      await saveRun(root, state);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(run.id, waiting.id);
      assert.equal(run.gate.required, false);
    }, { issue: sbiIssue(planned({ riskCandidate: 'L3' })) })));
    it('when the earlier run failed then running it again starts a new run instead of returning the stopped one', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      await mergeA(root, { '.harness/verification/issue-7.mjs': acceptance('ホーム（新しい見出し）') });
      const failed = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(failed.executionStatus, 'FAILED');
      const again = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(again.id, failed.id);
      assert.equal(again.iterations.length, 1);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), b.headSha);
    })));
    it('when it is run again after the PR was updated then the same run is reused and no second PR or push happens', () => fixture(root => withPullRequestB(root, async ({ github, pullUrl }) => {
      await mergeA(root);
      const first = await reverifyPullRequest({ root, pullUrl, quiet: true });
      const before = await runs(root);
      const again = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(again.id, first.id);
      assert.equal(again.headSha, first.headSha);
      assert.equal(again.alreadyVerified, true);
      assert.deepEqual(await runs(root), before);
      assert.equal((await github.state()).pulls.length, 1);
    })));
    it('when harness:pr is run for the re-verification run then it refuses, so no second branch or PR is created', () => fixture(root => withPullRequestB(root, async ({ bare, github, pullUrl }) => {
      await mergeA(root);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      await assert.rejects(openPullRequest({ root, runId: run.id, quiet: true }), /harness:reverify/);
      assert.equal(await remoteSha(bare, `harness/${run.id}`), '');
      assert.equal((await github.state()).pulls.length, 1);
    })));
    it('when the push itself failed then the retry pushes the same verified candidate without verifying again', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      await mergeA(root);
      const offline = { ...githubPrCli, push: async () => { throw new Error('git push: Could not resolve host: github.com'); } };
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true, github: offline }), /Could not resolve host/);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), b.headSha);
      const [stopped] = (await runs(root)).filter(id => id !== b.id);
      const before = await readRunState(root, stopped);
      assert.equal(before.reverify.publish, 'PUSHING');
      const retried = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(retried.id, stopped);
      assert.equal(retried.iterations.length, 1, 'the candidate is not verified a second time');
      assert.equal(await remoteSha(bare, `harness/${b.id}`), before.headSha);
      assert.equal(retried.reverify.publish, 'PR_UPDATED');
    })));
    it('when the push succeeded but updating the PR failed then the retry skips the push and finishes the PR update', () => fixture(root => withPullRequestB(root, async ({ bare, github, b, pullUrl }) => {
      await mergeA(root);
      const failing = { ...githubPrCli, updatePull: async () => { throw new Error('gh api PATCH repos/acme/app/pulls: HTTP 502'); } };
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true, github: failing }), /502/);
      const pushed = await remoteSha(bare, `harness/${b.id}`);
      assert.notEqual(pushed, b.headSha);
      const [stopped] = (await runs(root)).filter(id => id !== b.id);
      assert.equal((await readRunState(root, stopped)).reverify.publish, 'PUSHED');
      const retried = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(retried.id, stopped);
      assert.equal(retried.headSha, pushed);
      assert.equal(retried.reverify.publish, 'PR_UPDATED');
      assert.ok((await github.state()).pulls[0].body.includes(`run=${retried.id} sha=${pushed}`));
      assert.equal(await exists(join(root, '.harness/runs', stopped, 'workspace')), true);
    })));
  });
});
