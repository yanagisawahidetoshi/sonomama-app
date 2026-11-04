import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, update, human } from './test-fixture.mjs';
import * as harness from './index.mjs';
// These runs stand for the production path, so they connect a trusted AI Review adapter as #187 will (#175).
const aiReview = async ({ headSha }) => ({ adapter: 'test-adapter', headSha, status: 'PASS', reasons: [] });
const withAiReview = fn => options => fn({ semanticReviewer: aiReview, ...options });
const resumeRun = withAiReview(harness.resumeRun), reverifyPullRequest = withAiReview(harness.reverifyPullRequest);
import { withPullRequestB, parents, mergeA, pushOnto, succeed, reviewBy } from './test-reverify.mjs';


// Issue #144: after main moves, the finished implementation of a PR is merged with the new main and re-verified by a new run,
describe('Re-verification of an existing PR after main moved', () => {

  describe('given the re-verified PR on GitHub', () => {
    it('when CI passes and a human approves the new head then MERGE_ALLOWED, while approvals of the old head never count', () => fixture(root => withPullRequestB(root, async ({ github, b, pullUrl }) => {
      await succeed(github, b.headSha);
      await reviewBy(github, b.pullRequest.number, 'alice', 'APPROVED', b.headSha);
      await mergeA(root);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(run.status, 'BLOCKED');
      assert.deepEqual(run.merge.reasons, ['required_ci_not_passed']);
      await succeed(github, run.headSha);
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'WAITING_FOR_HUMAN_REVIEW');
      await reviewBy(github, b.pullRequest.number, 'alice', 'APPROVED', run.headSha);
      const allowed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(allowed.status, 'MERGE_ALLOWED');
      assert.deepEqual(allowed.merge.validReviewers, ['github:alice']);
    })));
    it('when a request for changes was left on the old head then the new head is still rejected', () => fixture(root => withPullRequestB(root, async ({ github, b, pullUrl }) => {
      await reviewBy(github, b.pullRequest.number, 'bob', 'CHANGES_REQUESTED', b.headSha);
      await mergeA(root);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      await succeed(github, run.headSha);
      await reviewBy(github, b.pullRequest.number, 'alice', 'APPROVED', run.headSha);
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'REJECTED');
    })));
    it('when someone pushes onto the PR after the update then the run blocks on the SHA mismatch', () => fixture(root => withPullRequestB(root, async ({ github, b, pullUrl }) => {
      await mergeA(root);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      const pushed = await pushOnto(root, `harness/${b.id}`, run.headSha, 'someone else pushed');
      await succeed(github, pushed);
      await reviewBy(github, b.pullRequest.number, 'alice', 'APPROVED', pushed);
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'BLOCKED');
      assert.ok(resumed.merge.reasons.includes('tested_sha_mismatch'));
    })));
    it('when main moves again after the update then the run blocks until it is re-verified once more', () => fixture(root => withPullRequestB(root, async ({ github, b, pullUrl }) => {
      await mergeA(root);
      const first = await reverifyPullRequest({ root, pullUrl, quiet: true });
      await succeed(github, first.headSha);
      await reviewBy(github, b.pullRequest.number, 'alice', 'APPROVED', first.headSha);
      const mainAfterC = await mergeA(root, { 'docs/feature-c.md': '# Cの機能\n' });
      const second = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(second.alreadyVerified, true, 'a new base SHA is verified again');
      assert.notEqual(second.id, first.id);
      assert.equal(second.reverify.parentRunId, b.id, 'the parent stays the run that implemented the SBI');
      assert.equal(second.reverify.previousTestedSha, first.headSha);
      assert.deepEqual(await parents(root, second.headSha), [mainAfterC, first.headSha]);
      assert.equal(second.status, 'BLOCKED');
    })));
  });
});
