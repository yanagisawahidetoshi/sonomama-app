import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './test-fixture.mjs';
import { resumeRun } from './index.mjs';
import { git } from './workspace.mjs';
import { readRunState, saveRun } from './run-store.mjs';
import { readJson } from './io.mjs';
import { runLinks, verifySbiSource } from './sbi-source.mjs';
import { loadImpact } from './impact.mjs';
import { aiReview, startRun, issueUrl, planned, sbiIssue, home, agent, withIssue } from './test-github-pr.mjs';

describe('GitHub PR Adapter', () => {
  // pnpm harness:run SBI_URL: the Issue a human marked ready is the only SBI input; nobody writes SBI JSON.
  describe('given a ready SBI Issue passed to harness:run as its URL', () => {
    const start = (root, options = {}) => startRun({ root, quiet: true, provider: 'codex', agent: agent(), publish: true, issueUrl, ...options });
    const runs = async root => (await readdir(join(root, '.harness/runs'))).filter(name => name !== '.gitkeep');

    it('when the run passes then the PR carries the Issue snapshot and Run trailers that the CI SBI source check accepts', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await start(root);
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.publish, true);
      assert.deepEqual(run.sbiIssue, { repo: 'acme/app', number: 7, url: issueUrl });
      const [pull] = (await github.state()).pulls;
      assert.equal(pull.head.sha, run.headSha);
      assert.ok(pull.body.includes(issueUrl));
      assert.ok(pull.body.includes('Closes #7'), 'merging the PR closes the SBI Issue so dependent SBIs may start');
      const workspace = join(root, run.runDir, 'workspace');
      const committed = JSON.parse((await git(workspace, ['show', `${run.headSha}:.harness/state/sbi-7.json`])).stdout);
      assert.deepEqual(committed, await readJson(join(root, run.runDir, 'sbi-snapshot.json')));
      assert.equal(committed.runId, run.id);
      assert.deepEqual(await runLinks(workspace, run.baselineSha), [{ runId: run.id, url: issueUrl }]);
      const files = [{ path: home }, { path: '.harness/state/sbi-7.json' }];
      // CI rebuilds the SBI with the registration of Issue #7 at the PR head.
      const source = await verifySbiSource({ root: workspace, base: run.baselineSha, files, required: [`production:${home}`], repository: 'acme/app', config: (await loadImpact({ root: workspace, base: run.baselineSha })).config });
      assert.equal(source.status, 'PASS', source.reasons.join('; '));
    })));
    // Each SBI Issue registers its Trusted Acceptance in its own file. CI rebuilds this SBI from .harness/acceptance/sbi-7.json only,
    // so another Issue registered on main meanwhile changes nothing for it. Locally any new commit still stops the run (ADR-0001).
    it('when another Issue registers its Trusted Acceptance after the run started then CI still rebuilds the same SBI, while a local resume stops because the source moved', () => fixture(root => withIssue(root, sbiIssue(), async () => {
      const run = await start(root);
      const workspace = join(root, run.runDir, 'workspace');
      await writeFile(join(workspace, '.harness/acceptance/sbi-8.json'), JSON.stringify({ version: 1, sbiIssue: 8, verifiers: [{ id: 'issue-8-acceptance', trustedScript: '.harness/verification/issue-7.mjs', planned: ['別Issue'], acceptanceIds: ['AC-1'] }] }));
      await git(workspace, ['add', '--all']);
      await git(workspace, ['commit', '-m', 'register the Trusted Acceptance of SBI Issue #8 on main']);
      const { config, files } = await loadImpact({ root: workspace, base: run.baselineSha });
      assert.deepEqual(config.verifiers.filter(v => v.sbiIssue).map(v => v.id), ['issue-7-acceptance']);
      const source = await verifySbiSource({ root: workspace, base: run.baselineSha, files, required: [`production:${home}`], repository: 'acme/app', config });
      assert.equal(source.status, 'PASS', source.reasons.join('; '));
      await git(root, ['commit', '--allow-empty', '-m', 'main moved']);
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      // Execution stays DONE (#70); the merge assessment stops for good because the tested SHA is no longer the merge result.
      assert.deepEqual([resumed.executionStatus, resumed.status, resumed.merge.failure.code, resumed.merge.failure.retryable], ['DONE', 'ESCALATED', 'SOURCE_CHANGED', false]);
    })));
    it('when the snapshot matches the ready Issue then the run is judged by its app change, not by where the snapshot is stored', () => fixture(root => withIssue(root, sbiIssue(), async () => {
      const run = await start(root);
      assert.equal(run.risk.level, 2, JSON.stringify(run.risk.reasons));
      assert.ok(!run.risk.reasons.includes('harness_policy'));
      assert.equal(run.securityAssessment.securitySensitive, false);
    })));
    it('when the Issue is edited after the run started then the snapshot is no longer verified and the run is LEVEL 3', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await start(root);
      await github.update(s => { s.issue.body += '\n追記'; });
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.risk.level, 3);
      assert.ok(resumed.risk.reasons.includes('harness_policy'));
    })));
    it('when the Issue cannot be read during the assessment then the snapshot is not verified and the run is LEVEL 3', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await start(root);
      await github.update(s => { s.issue.number = 99; });
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).risk.level, 3);
    })));
    // #220: a run that stopped before its implementation reads the Issue again on resume, so it implements only what ready or the spec
    // approval still covers. The state is the one the Harness leaves when it stops between the preflight and the first iteration.
    const unstarted = async (root, run) => {
      const state = await readRunState(root, run.id);
      Object.assign(state, { status: 'PENDING', executionStatus: 'PENDING', iterations: [], merge: { state: 'NOT_ASSESSED', autoMergeEligible: false } });
      await saveRun(root, state);
      await rm(join(root, run.runDir, 'iteration-1'), { recursive: true });
    };
    const counting = () => { const spy = async () => { spy.calls += 1; return { files: [{ path: home, content: 'ホーム' }] }; }; spy.calls = 0; return spy; };
    it('when ready was removed from the Issue before the run resumes then the implementation does not resume', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await start(root, { publish: false });
      await unstarted(root, run);
      await github.update(s => { s.issue.labels = [{ name: 'sbi' }]; });
      const implementer = counting();
      const resumed = await resumeRun({ root, runId: run.id, quiet: true, agent: implementer, semanticReviewer: aiReview });
      assert.equal(resumed.status, 'ESCALATED');
      assert.match(resumed.reason, /readyではありません/);
      assert.equal(implementer.calls, 0);
    })));
    it('when the spec of the Issue changed before the run resumes then the implementation does not resume', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await start(root, { publish: false });
      await unstarted(root, run);
      const changed = sbiIssue(['sbi', 'ready'], planned({ purpose: '管理者がホームを開くと見出しと一覧が表示される。' }));
      // No edit history is recorded, so ready still reads as given to this body; only the comparison with the run snapshot catches it.
      await github.update(s => { s.issue.body = changed.body; });
      const implementer = counting();
      const resumed = await resumeRun({ root, runId: run.id, quiet: true, agent: implementer, semanticReviewer: aiReview });
      assert.equal(resumed.status, 'ESCALATED');
      assert.match(resumed.reason, /bodyDigest/);
      assert.equal(implementer.calls, 0);
    })));
    it('when the Issue is still ready and unchanged then the run resumes its implementation', () => fixture(root => withIssue(root, sbiIssue(), async () => {
      const run = await start(root, { publish: false });
      await unstarted(root, run);
      const implementer = counting();
      const resumed = await resumeRun({ root, runId: run.id, quiet: true, agent: implementer, semanticReviewer: aiReview });
      assert.equal(implementer.calls, 1);
      assert.equal(resumed.executionStatus, 'DONE', resumed.reason);
    })));
  });
});
