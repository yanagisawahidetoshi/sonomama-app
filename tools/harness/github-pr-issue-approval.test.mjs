import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, chmod, symlink, appendFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, update, human } from './test-fixture.mjs';
import { resumeRun, approveRun } from './index.mjs';
import { recordDecision } from './human-approvals.mjs';
import { exists } from './io.mjs';
import { startRun, issueUrl, planned, sbiIssue, home, agent, withIssue } from './test-github-pr.mjs';

describe('GitHub PR Adapter', () => {
  // pnpm harness:run SBI_URL: the Issue a human marked ready is the only SBI input; nobody writes SBI JSON.
  describe('given a ready SBI Issue passed to harness:run as its URL', () => {
    const start = (root, options = {}) => startRun({ root, quiet: true, provider: 'codex', agent: agent(), publish: true, issueUrl, ...options });
    const runs = async root => (await readdir(join(root, '.harness/runs'))).filter(name => name !== '.gitkeep');

    // A run that does not publish waits for the merge decision of its Issue; harness:approve SBI_URL --phase merge finds it.
    const unpublished = root => start(root, { publish: false });
    // .harness/state/runs/*.json is a projection anyone can edit. The run to approve is chosen from .harness/runs/<id>/summary.json and re-checked before the decision.
    it('when the run projections are edited to make another run look like the one waiting for the Issue then the approval still goes to the run of the Issue', () => fixture(root => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ riskCandidate: 'L3' })), async () => {
      const own = await unpublished(root), other = await startRun({ root, quiet: true, provider: 'fake' });
      assert.deepEqual([own.executionStatus, other.executionStatus], ['DONE', 'DONE']);
      await update(root, `.harness/state/runs/${other.id}.json`, s => { s.sbiIssue = { repo: 'acme/app', number: 7, url: issueUrl }; });
      await update(root, `.harness/state/runs/${own.id}.json`, s => { s.executionStatus = 'FAILED'; delete s.sbiIssue; });
      const approved = await approveRun({ root, issueUrl, purpose: 'merge', identityProvider: human('Designer'), quiet: true });
      assert.equal(approved.id, own.id);
      assert.equal(await exists(join(root, '.harness/state/human', `${other.id}.json`)), false);
    })));
    // summary.json is signed (#75). An edited summary is neither a candidate for the Issue URL nor resumable.
    const summaryOf = (root, run) => join(root, run.runDir, 'summary.json');
    it('when the signed summary of another run is edited to name the Issue and wait for a merge decision then the approval still goes to the run of the Issue', () => fixture(root => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ riskCandidate: 'L3' })), async () => {
      const own = await unpublished(root), other = await startRun({ root, quiet: true, provider: 'fake' });
      await update(root, summaryOf(root, other).slice(root.length + 1), s => { s.sbiIssue = { repo: 'acme/app', number: 7, url: issueUrl }; });
      const approved = await approveRun({ root, issueUrl, purpose: 'merge', identityProvider: human('Designer'), quiet: true });
      assert.equal(approved.id, own.id);
      assert.equal(await exists(join(root, '.harness/state/human', `${other.id}.json`)), false);
    })));
    it('when the signed summary of the waiting run is edited then approving by the Issue URL records nothing and names the run that failed verification', () => fixture(root => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ riskCandidate: 'L3' })), async ({ github }) => {
      const run = await unpublished(root);
      await update(root, summaryOf(root, run).slice(root.length + 1), s => { s.reason = '手で書き換えた'; });
      await assert.rejects(approveRun({ root, issueUrl, purpose: 'merge', identityProvider: human('Designer'), quiet: true }),
        error => error.message.includes(run.id) && /integrity/.test(error.message));
      assert.equal(await exists(join(root, '.harness/state/human', `${run.id}.json`)), false);
      assert.deepEqual((await github.state()).pulls, []);
    })));
    it('when the signed summary of an Issue run is edited to point at another Issue then resume refuses it', () => fixture(root => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ riskCandidate: 'L3' })), async () => {
      const run = await start(root);
      await update(root, summaryOf(root, run).slice(root.length + 1), s => { s.sbiIssue = { repo: 'acme/app', number: 8, url: 'https://github.com/acme/app/issues/8' }; });
      await assert.rejects(resumeRun({ root, runId: run.id, quiet: true }), /run state integrity/);
    })));
    it('when a decision for the Issue is recorded on a run of another SBI then it is refused before anything is recorded', () => fixture(root => withIssue(root, sbiIssue(), async () => {
      const other = await startRun({ root, quiet: true, provider: 'fake' });
      await assert.rejects(recordDecision({ root, runId: other.id, purpose: 'merge', issueUrl, identityProvider: human('Designer') }), /issues\/7/);
      assert.equal(await exists(join(root, '.harness/state/human', `${other.id}.json`)), false);
    })));
    // The exit code is what a person or a script sees: only a failed run is non-zero. cli.mjs of the fixture is spawned with a codex stub on PATH.
    describe('when the commands are run from the CLI', () => {
      const cli = async (root, args, response = { files: [{ path: home, content: 'ホーム' }], escalation: null }) => {
        const bin = await mkdtemp(join(tmpdir(), 'harness-codex-'));
        try {
          await writeFile(join(bin, 'codex'), `#!${process.execPath}\nconst fs = require('node:fs'), args = process.argv.slice(2); fs.readFileSync(0); fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], process.env.CODEX_STUB_RESPONSE);\n`);
          await chmod(join(bin, 'codex'), 0o755);
          // The trusted AI Review provider is Claude whatever implemented the run (#187); the stub passes the head SHA it was shown.
          await writeFile(join(bin, 'claude'), `#!${process.execPath}\nconst prompt = require('node:fs').readFileSync(0, 'utf8');\n`
            + `console.log(JSON.stringify({ is_error: false, structured_output: { headSha: prompt.match(/"headSha": "([0-9a-f]{40,64})"/)[1], status: 'PASS', riskLevel: 1, reasons: ['stub review'] } }));\n`);
          await chmod(join(bin, 'claude'), 0o755);
          const child = spawn(process.execPath, [join(root, 'tools/harness/cli.mjs'), ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_STUB_RESPONSE: JSON.stringify(response) } });
          let output = '';
          child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
          const code = await new Promise(resolve => child.on('exit', resolve));
          return { code, output };
        } finally { await rm(bin, { recursive: true, force: true }); }
      };
      // The fixture copies tools/harness without node_modules; the installed ones are linked and kept out of Git.
      const linked = async root => {
        await symlink(join(new URL('../../', import.meta.url).pathname, 'node_modules'), join(root, 'node_modules'));
        await mkdir(join(root, '.git/info'), { recursive: true });
        await appendFile(join(root, '.git/info/exclude'), 'node_modules\n');
      };
      // The CLI connects the trusted AI Review adapter (#187), so a Codex run is reviewed by Claude and the PR waits for its human review, not for AI Review.
      it('when harness:run SBI_URL of a Codex run opens the PR then Claude reviews its head SHA and AI Review is not the blocker', () => fixture(root => linked(root).then(() => withIssue(root, sbiIssue(), async ({ github }) => {
        const { code, output } = await cli(root, ['run', issueUrl, '--provider', 'codex']);
        assert.equal(code, 0, output);
        assert.equal((await github.state()).pulls.length, 1);
        assert.match(output, /Pull request: https:\/\/github.com\/acme\/app\/pull\//);
        assert.doesNotMatch(output, /AI Review: /);
      }))));
      it('when harness:run SBI_URL of a level 3 Issue runs then it opens the PR without stopping at a gate', () => fixture(root => linked(root).then(() => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ riskCandidate: 'L3' })), async ({ github }) => {
        const started = await cli(root, ['run', issueUrl, '--provider', 'codex']);
        assert.doesNotMatch(started.output, /Human Gate/);
        assert.equal((await github.state()).pulls.length, 1);
      }))));
      it('when harness:approve asks for the removed implementation gate then refuses it', () => fixture(root => linked(root).then(() => withIssue(root, sbiIssue(), async () => {
        const approved = await cli(root, ['approve', issueUrl, '--phase', 'gate']);
        assert.equal(approved.code, 1, approved.output);
        assert.match(approved.output, /--phase merge/);
      }))));
      it('when harness:run SBI_URL escalates because the agent writes outside the scope then exits 2 and opens no PR', () => fixture(root => linked(root).then(() => withIssue(root, sbiIssue(), async ({ github }) => {
        const { code, output } = await cli(root, ['run', issueUrl, '--provider', 'codex'], { files: [{ path: 'apps/admin-other/home.txt', content: 'ホーム' }], escalation: null });
        assert.equal(code, 2, output);
        assert.deepEqual((await github.state()).pulls, []);
      }))));
    });
    it('when two runs of the Issue wait for a merge decision then approving by the Issue URL refuses to guess and names both runs', () => fixture(root => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ riskCandidate: 'L3' })), async () => {
      const first = await unpublished(root), second = await unpublished(root);
      await assert.rejects(approveRun({ root, issueUrl, purpose: 'merge', identityProvider: human('Designer'), quiet: true }),
        error => error.message.includes(first.id) && error.message.includes(second.id));
    })));
  });
});
