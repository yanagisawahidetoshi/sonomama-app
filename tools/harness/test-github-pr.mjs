import { mkdtemp, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { update, commitFixture } from './test-fixture.mjs';
import { githubMock } from './test-github.mjs';
import { runHarness as harnessRun } from './index.mjs';
import { git } from './workspace.mjs';
import { renderSbiBody } from './planner.mjs';

// Shared setup of the GitHub PR Adapter tests, split over github-pr*.test.mjs so that the files run in parallel.
// A pull request is the production path, where the fake AI Review of the demo never counts (#175). These runs connect a trusted adapter as #187 will.
export const aiReview = async ({ headSha }) => ({ adapter: 'test-adapter', headSha, status: 'PASS', reasons: [] });
export const startRun = options => harnessRun({ semanticReviewer: aiReview, ...options });
export const sbiPath = '.harness/state/sample-sbi.json';
export const mockGitHub = githubMock({ issue: { number: 1, title: 'unused', body: '', html_url: 'https://github.com/acme/app/issues/1', state: 'open', labels: [] },
  permissions: { alice: 'write', bob: 'write', 'harness-operator': 'admin' } });
// origin points at github.com/acme/app as configured, while git itself pushes to a local bare repository.
export async function withRemote(root, test, { publishBaseline = true, state = {} } = {}) {
  const bare = await realpath(await mkdtemp(join(tmpdir(), 'harness-remote-')));
  try {
    await git(bare, ['init', '--bare', '--initial-branch=main']);
    await git(root, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
    await git(root, ['config', `url.${bare}.insteadOf`, 'https://github.com/acme/app.git']);
    if (publishBaseline) await git(root, ['push', 'origin', 'HEAD:refs/heads/main']);
    await mockGitHub({ bare, ...state }, github => test({ bare, github }));
  } finally { await rm(bare, { recursive: true, force: true }); }
}
export const remoteSha = async (bare, branch) => (await git(bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true)).stdout.trim();
export const succeed = (github, sha, name = 'harness', appId = 15368) => github.update(s => { s.checkRuns[sha] = [...(s.checkRuns[sha] || []), { id: (s.checkRuns[sha] || []).length + 1, name, status: 'completed', conclusion: 'success', head_sha: sha, app: { id: appId } }]; });
// A new commit on origin/main that the run never saw; the source checkout HEAD stays at the baseline.
export const advanceMain = async (root, baselineSha) => {
  const next = (await git(root, ['commit-tree', `${baselineSha}^{tree}`, '-p', baselineSha, '-m', 'someone else merged'])).stdout.trim();
  await git(root, ['push', '--quiet', 'origin', `${next}:refs/heads/main`]);
  return next;
};
export const reviewBy = (github, number, login, state, commit) => github.update(s => { s.reviews[number] = [...(s.reviews[number] || []), { id: (s.reviews[number] || []).length + 1, user: { login, type: 'User' }, state, commit_id: commit }]; });

export const issueUrl = 'https://github.com/acme/app/issues/7';
export const pbi = { number: 3, url: 'https://github.com/acme/app/issues/3', title: '管理画面のホーム' };
export const planned = (overrides = {}) => ({
  id: 'SBI-001', kind: 'implementation', title: 'ホームに見出しを表示する', purpose: '管理者がホームを開くと見出しが表示される。',
  scope: { included: ['apps/admin ホーム画面'], excluded: [] },
  acceptanceCriteria: [{ id: 'AC-1', description: 'ホームに見出しが表示される' }, { id: 'AC-2', description: '見出しの文言が仕様どおりである' }],
  scenarios: [{ name: 'ホームを開く', given: ['管理者がログインしている'], when: ['ホームを開く'], then: ['見出しが表示される'], acceptanceIds: ['AC-1', 'AC-2'], test: 'Vitest: apps/admin/src/features/home/index.test.tsx' }],
  dependsOn: [], changeAreas: ['apps/admin'], layers: ['画面Component'], estimatedFiles: 2, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
  verification: { applicationTest: 'Vitest', acceptance: 'Trusted Acceptance', e2e: '不要' }, ...overrides });
export const sbiIssue = (labels = ['sbi', 'ready'], sbi = planned()) => ({ number: 7, title: `${sbi.id} ${sbi.title}`, body: renderSbiBody(sbi, pbi), html_url: issueUrl, state: 'open', labels: labels.map(name => ({ name })) });
export const home = 'apps/admin/src/home.txt';
export const agent = (path = home) => async () => ({ files: [{ path, content: 'ホーム' }] });
// A human wrote and registered the Trusted Acceptance of Issue #7 before marking it ready. No SBI JSON exists for it.
export const registered = async root => {
  await writeFile(join(root, '.harness/verification/issue-7.mjs'), `import assert from "node:assert/strict";import{readFileSync}from"node:fs";import{join}from"node:path";assert.equal(readFileSync(join(process.argv[2],${JSON.stringify(home)}),"utf8"),"ホーム");console.log(JSON.stringify({acceptance:["AC-1","AC-2"]}));`);
  await mkdir(join(root, '.harness/acceptance'), { recursive: true });
  await writeFile(join(root, '.harness/acceptance/sbi-7.json'), JSON.stringify({ version: 1, sbiIssue: 7, verifiers: [{ id: 'issue-7-acceptance', trustedScript: '.harness/verification/issue-7.mjs', planned: ['ホーム見出し'], acceptanceIds: ['AC-1', 'AC-2'] }] }));
  await update(root, '.harness/config/harness.json', c => {
    // The admin placeholder has no installable app in the fixture; its verifier stands in with a passing command.
    Object.assign(c.verifiers.find(v => v.id === 'admin'), { setupCommands: [], commands: [['node', '-e', 'process.exit(0)']] });
  });
  await commitFixture(root);
};
export const withIssue = (root, issue, test, options = {}) => registered(root).then(() => withRemote(root, test, { ...options, state: { issue, ...options.state } }));
// #220: only a run from a ready SBI Issue opens a PR, so the PR of each test below comes from Issue #7. The fake provider never publishes
// by itself, so harness:pr opens the PR where the test says.
export const issueRun = (root, options = {}) => startRun({ root, quiet: true, provider: 'fake', agent: agent(), issueUrl, ...options });
