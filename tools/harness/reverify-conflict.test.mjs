import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './test-fixture.mjs';
import * as harness from './index.mjs';
// These runs stand for the production path, so they connect a trusted AI Review adapter as #187 will (#175).
const aiReview = async ({ headSha }) => ({ adapter: 'test-adapter', headSha, status: 'PASS', reasons: [] });
const withAiReview = fn => options => fn({ semanticReviewer: aiReview, ...options });
const reverifyPullRequest = withAiReview(harness.reverifyPullRequest);
import { verifyReverifyLink } from './reverify.mjs';
import { git } from './workspace.mjs';
import { planned, sbiIssue, home, acceptance, spy, withPullRequestB, remoteSha, parents, mergeA, resolveOnBranch } from './test-reverify.mjs';


// Issue #144: after main moves, the finished implementation of a PR is merged with the new main and re-verified by a new run,
describe('Re-verification of an existing PR after main moved', () => {
  describe('given B conflicts with the new main', () => {
    const conflicting = { [home]: 'Aのホーム' };
    it('when B is re-verified then it stops with the conflicting paths, keeps the PR branch and verifies nothing', () => fixture(root => withPullRequestB(root, async ({ bare, github, b, pullUrl }) => {
      await mergeA(root, conflicting);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(run.status, 'ESCALATED');
      assert.equal(run.escalation.code, 'REVERIFY_CONFLICT');
      assert.deepEqual(run.reverify.conflicts, [home]);
      assert.ok(run.reason.includes(home));
      assert.equal(run.iterations.length, 0);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), b.headSha);
      assert.equal((await github.state()).pulls[0].body.includes(run.id), false);
    })));
    it('when a person resolves the conflict on the PR branch then the resolved head is verified again in a new run and pushed', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      const mainAfterA = await mergeA(root, conflicting);
      const stopped = await reverifyPullRequest({ root, pullUrl, quiet: true });
      const resolved = await resolveOnBranch(bare, `harness/${b.id}`, { [home]: 'ホーム' });
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(run.id, stopped.id);
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.iterations.length, 1);
      assert.equal(run.iterations[0].verification.status, 'PASS');
      assert.equal(run.reverify.previousTestedSha, resolved);
      assert.deepEqual(await parents(root, run.headSha), [resolved], 'the resolved head is kept and only the link commit is added on top');
      assert.equal((await git(root, ['rev-parse', `${run.headSha}^{tree}`])).stdout.trim(), (await git(root, ['rev-parse', `${resolved}^{tree}`])).stdout.trim());
      assert.equal(await remoteSha(bare, `harness/${b.id}`), run.headSha);
      assert.equal((await verifyReverifyLink({ root, base: mainAfterA, head: run.headSha })).status, 'PASS');
    })));
    it('when the resolution also changes a file outside the SBI scope then it stops before verification and pushes nothing', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      await mergeA(root, conflicting);
      await reverifyPullRequest({ root, pullUrl, quiet: true });
      const resolved = await resolveOnBranch(bare, `harness/${b.id}`, { [home]: 'ホーム', 'docs/outside-scope.md': 'scope外' });
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(run.status, 'ESCALATED');
      assert.equal(run.escalation.code, 'SCOPE_VIOLATION');
      assert.ok(run.reason.includes('docs/outside-scope.md'));
      assert.equal(run.iterations.length, 0);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), resolved);
    })));
  });

  describe('given the latest trusted rules and verification code on main', () => {
    it('when the Trusted Acceptance on the new main fails for B then the run fails, nothing is pushed and the agent is not called', () => fixture(root => withPullRequestB(root, async ({ bare, github, b, pullUrl }) => {
      await mergeA(root, { '.harness/verification/issue-7.mjs': acceptance('ホーム（新しい見出し）') });
      const reverification = spy();
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true, agent: reverification.agent });
      assert.equal(run.executionStatus, 'FAILED');
      assert.equal(run.iterations.length, 1);
      assert.equal(reverification.calls.length, 0);
      assert.notEqual(run.reverify.publish, 'PR_UPDATED');
      assert.equal(await remoteSha(bare, `harness/${b.id}`), b.headSha);
      assert.equal((await github.state()).pulls[0].body.includes(run.id), false);
      assert.notEqual(run.status, 'MERGE_ALLOWED');
    })));
    // #175: the approved SBI decided its level 3 Risk, so neither the run nor its re-verification stops at an implementation gate.
    it('when the SBI is level 3 then the new baseline is verified and pushed without an implementation gate or the implementation agent', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl, implementation }) => {
      assert.equal(b.gate.required, false);
      await mergeA(root);
      const before = implementation.calls.length;
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(run.gate.required, false);
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.risk.level, 3);
      assert.equal(implementation.calls.length, before);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), run.headSha);
    }, { issue: sbiIssue(planned({ riskCandidate: 'L3' })) })));
  });
});
