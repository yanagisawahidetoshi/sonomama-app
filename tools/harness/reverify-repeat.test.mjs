import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, update } from './test-fixture.mjs';
import * as harness from './index.mjs';
// These runs stand for the production path, so they connect a trusted AI Review adapter as #187 will (#175).
const aiReview = async ({ headSha }) => ({ adapter: 'test-adapter', headSha, status: 'PASS', reasons: [] });
const withAiReview = fn => options => fn({ semanticReviewer: aiReview, ...options });
const resumeRun = withAiReview(harness.resumeRun), reverifyPullRequest = withAiReview(harness.reverifyPullRequest);
import { git } from './workspace.mjs';
import { withPullRequestB, remoteSha, commitOnBranch, runs } from './test-reverify.mjs';


// Issue #144: after main moves, the finished implementation of a PR is merged with the new main and re-verified by a new run,
describe('Re-verification of an existing PR after main moved', () => {
  describe('given main has not moved since the PR head was verified', () => {
    it('when B is re-verified then it reports the run the head is bound to and creates no run, commit, push or PR update', () => fixture(root => withPullRequestB(root, async ({ bare, github, b, pullUrl }) => {
      const before = { runs: await runs(root), body: (await github.state()).pulls[0].body };
      const result = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(result.alreadyVerified, true);
      assert.equal(result.id, b.id);
      assert.equal(result.headSha, b.headSha);
      assert.deepEqual(await runs(root), before.runs);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), b.headSha);
      assert.equal((await github.state()).pulls[0].body, before.body);
      assert.equal((await github.calls()).some(c => c.args.includes('PATCH')), false);
    })));
    it('when someone pushed onto the PR head then the new head is verified in a new run', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      const head = await commitOnBranch(bare, `harness/${b.id}`, { 'apps/admin/src/extra.txt': '追加' });
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(run.alreadyVerified, true);
      assert.notEqual(run.id, b.id);
      assert.equal(run.reverify.previousTestedSha, head);
    })));
    it('when the run of the head stopped as ESCALATED then the head is verified in a new run', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      await git(root, ['commit', '--allow-empty', '-m', 'local only']);
      assert.equal((await resumeRun({ root, runId: b.id, quiet: true })).status, 'ESCALATED');
      await git(root, ['checkout', '--quiet', '--detach', b.baselineSha]);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(run.alreadyVerified, true);
      assert.notEqual(run.id, b.id);
    })));
    it('when the signed state of the run cannot be verified then the head is verified in a new run', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      await update(root, `${b.runDir}/summary.json`, s => { s.reason = '手で書き換えた'; });
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(run.alreadyVerified, true);
      assert.notEqual(run.id, b.id);
    })));
    it('when the run ref no longer points at the PR head then the binding is not trusted and the head is verified in a new run', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      await git(root, ['update-ref', `refs/harness/runs/${b.id}`, b.baselineSha]);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(run.alreadyVerified, true);
      assert.notEqual(run.id, b.id);
    })));
  });
});
