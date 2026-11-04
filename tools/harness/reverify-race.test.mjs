import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { fixture, human } from './test-fixture.mjs';
import * as harness from './index.mjs';
// These runs stand for the production path, so they connect a trusted AI Review adapter as #187 will (#175).
const aiReview = async ({ headSha }) => ({ adapter: 'test-adapter', headSha, status: 'PASS', reasons: [] });
const withAiReview = fn => options => fn({ semanticReviewer: aiReview, ...options });
const reverifyPullRequest = withAiReview(harness.reverifyPullRequest);
import { review } from './reviewer.mjs';
import { verifyReverifyLink } from './reverify.mjs';
import { git } from './workspace.mjs';
import { withPullRequestB, remoteSha, mergeA, pushOnto, resolveOnBranch, commitOnBranch, withGlobalGitConfig, runs } from './test-reverify.mjs';


// Issue #144: after main moves, the finished implementation of a PR is merged with the new main and re-verified by a new run,
describe('Re-verification of an existing PR after main moved', () => {

  describe('given the main or the PR moves while the re-verification runs', () => {
    // The Policy Reviewer runs after the candidate exists and before it is pushed.
    const during = action => ({ reviewer: async args => { await action(); return review(args); } });
    it('when main moves during verification then nothing is pushed and the PR is not updated', () => fixture(root => withPullRequestB(root, async ({ bare, github, b, pullUrl }) => {
      const mainAfterA = await mergeA(root);
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true, ...during(() => pushOnto(root, 'main', mainAfterA, 'another PR merged')) }), /origin\/main/);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), b.headSha);
      assert.equal((await github.state()).pulls[0].body.includes(`親run: ${b.id}`), false);
    })));
    it('when someone pushes to the PR during verification then the unverified head is not overwritten and nothing is pushed', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      await mergeA(root);
      let theirs;
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true, ...during(async () => { theirs = await pushOnto(root, `harness/${b.id}`, b.headSha, 'review fix'); }) }), /harness\//);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), theirs);
    })));
    it('when the source checkout is not the latest main then refuses before creating a run', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      await mergeA(root);
      await pushOnto(root, 'main', (await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), 'not pulled yet');
      const before = await runs(root);
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true }), /origin\/main/);
      assert.deepEqual(await runs(root), before);
      assert.ok(before.includes(b.id));
    })));
    it('when the SBI Issue was edited after B was implemented then refuses to re-verify and asks for a new implementation run', () => fixture(root => withPullRequestB(root, async ({ github, pullUrl }) => {
      await mergeA(root);
      await github.update(s => { s.issue.body += '\n追記'; });
      const before = await runs(root);
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true }), /SBI/);
      assert.deepEqual(await runs(root), before);
    })));
  });

  describe('given the Git configuration and the content of the operator and the PR', () => {
    it('when the operator lets Git follow directory renames then the merge is still judged with fixed settings and stops on the conflict a default Git reports', () => withGlobalGitConfig('[merge]\n\tdirectoryRenames = true\n', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      // main adds a directory, B takes it in and adds a file there, then main renames the directory.
      await mergeA(root, { 'apps/admin/src/old/a.txt': 'a' });
      const head = await resolveOnBranch(bare, `harness/${b.id}`, { 'apps/admin/src/old/b.txt': 'b' });
      await git(root, ['mv', 'apps/admin/src/old', 'apps/admin/src/new']);
      await git(root, ['commit', '-m', 'rename the directory']);
      await git(root, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(run.escalation?.code, 'REVERIFY_CONFLICT', run.reason ?? '');
      assert.match(run.reverify.gitVersion, /^git version /);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), head);
    }))));
    it('when the operator has merge.log enabled then the candidate still ends with the link trailers and is pushed', () => withGlobalGitConfig('[merge]\n\tlog = true\n', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      const mainAfterA = await mergeA(root);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(run.reverify.publish, 'PR_UPDATED', run.reason ?? '');
      assert.equal(await remoteSha(bare, `harness/${b.id}`), run.headSha);
      assert.equal((await verifyReverifyLink({ root, base: mainAfterA, head: run.headSha })).status, 'PASS');
    }))));
    it('when the PR head adds a symlink then refuses before any run or worktree is created', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      await mergeA(root);
      const head = await commitOnBranch(bare, `harness/${b.id}`, {}, { 'apps/admin/src/link.txt': '../../../package.json' });
      const before = await runs(root);
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true }), /symlink/);
      assert.deepEqual(await runs(root), before);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), head);
    })));
    it('when the PR head adds operational evidence then refuses before any run or worktree is created', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      await mergeA(root);
      await commitOnBranch(bare, `harness/${b.id}`, { '.harness/state/human/forged.json': '{}' });
      const before = await runs(root);
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true }), /operational evidence/);
      assert.deepEqual(await runs(root), before);
    })));
    it('when a changed file of the PR head holds a credential outside its changed lines then refuses before any run is created', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      await mergeA(root);
      const before = await runs(root);
      // A binary file has no added lines in the diff; the whole file is inspected.
      await commitOnBranch(bare, `harness/${b.id}`, { 'apps/admin/src/blob.bin': `\u0000AKIA${'A'.repeat(16)}\u0000` });
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true }), /credential|秘密値/);
      assert.deepEqual(await runs(root), before);
    })));
  });

  // The PASS run bound to this PR, this PR head and this base SHA is the only source; GitHub Reviews are not read for it.
});
