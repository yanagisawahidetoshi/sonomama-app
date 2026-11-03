import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './test-fixture.mjs';
import * as harness from './index.mjs';
// These runs stand for the production path, so they connect a trusted AI Review adapter as #187 will (#175).
const aiReview = async ({ headSha }) => ({ adapter: 'test-adapter', headSha, status: 'PASS', reasons: [] });
const withAiReview = fn => options => fn({ semanticReviewer: aiReview, ...options });
const reverifyPullRequest = withAiReview(harness.reverifyPullRequest);
import { githubPrCli } from './github-pr.mjs';
import { withPullRequestB, mergeA, runs } from './test-reverify.mjs';


// Issue #144: after main moves, the finished implementation of a PR is merged with the new main and re-verified by a new run,
describe('Re-verification of an existing PR after main moved', () => {

  describe('given the PR is not the one the run belongs to', () => {
    it('when the PR head comes from a fork then refuses before any run is created', () => fixture(root => withPullRequestB(root, async ({ github, pullUrl }) => {
      await mergeA(root);
      await github.update(s => { s.pulls[0].head.repo = { full_name: 'someone/app' }; });
      const before = await runs(root);
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true }), /someone\/app/);
      assert.deepEqual(await runs(root), before);
    })));
    it('when the PR head repository was deleted then refuses before any run is created', () => fixture(root => withPullRequestB(root, async ({ github, pullUrl }) => {
      await mergeA(root);
      await github.update(s => { s.pulls[0].head.repo = null; });
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true }), /fork/);
    })));
    it('when the PR was closed and the branch reopened as another PR then the run of the closed PR is not reused and its body is left alone', () => fixture(root => withPullRequestB(root, async ({ github, b, pullUrl }) => {
      await mergeA(root);
      const failing = { ...githubPrCli, updatePull: async () => { throw new Error('gh api PATCH repos/acme/app/pulls: HTTP 502'); } };
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true, github: failing }), /502/);
      const [stopped] = (await runs(root)).filter(id => id !== b.id);
      const closedBody = (await github.state()).pulls[0].body;
      await github.update(s => { s.pulls[0].state = 'closed'; s.pulls.push({ ...s.pulls[0], number: 202, state: 'open', html_url: 'https://github.com/acme/app/pull/202', body: '' }); });
      const run = await reverifyPullRequest({ root, pullUrl: 'https://github.com/acme/app/pull/202', quiet: true });
      assert.notEqual(run.id, stopped);
      assert.equal(run.pullRequest.number, 202);
      const pulls = (await github.state()).pulls;
      assert.equal(pulls[0].body, closedBody);
      assert.ok(pulls[1].body.includes(`run=${run.id}`));
    })));
  });
});
