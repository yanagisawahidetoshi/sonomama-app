import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { renderSbiBody } from './planner.mjs';
import { githubCli } from './planner-github.mjs';
import { githubMock } from './test-github.mjs';
import { execute } from './io.mjs';
import { collectPbiStatus, renderPbiStatus } from './pbi-status.mjs';
// An adapter that has no evidence to offer, e.g. for an SBI without a merged Harness PR.
const notConnected = { async read() { return { connected: false, reason: 'Maestro E2E Evidenceを接続できません' }; } };
import { evidenceManifests, pbiEvidenceLedgerPath, recordEvidenceManifest } from './pbi-acceptance.mjs';
import { parseIssueUrl } from './planner.mjs';
import { readFile as readText, writeFile as writeText } from 'node:fs/promises';
import { planOf, planDigest, renderPlanSection, approvalKey } from './pbi-plan.mjs';

const pbi = { owner: 'acme', repo: 'app', number: 8, url: 'https://github.com/acme/app/issues/8', title: '受講生ログイン' };
const issueUrl = number => `https://github.com/acme/app/issues/${number}`;
const sha = char => char.repeat(40);
const validationDigest = 'b'.repeat(64);
const mockDigest = id => createHash('sha256').update(`mock ${id}`).digest('hex');
// The approved PBI plan: the complete SBI set the Planner wrote into ## SBI構成 and a human approved once.
const fullPlan = planOf(8, [
  { id: 'SBI-001', number: 11, kind: 'implementation', dependsOn: [] }, { id: 'SBI-002', number: 12, kind: 'implementation', dependsOn: ['SBI-001'] },
  { id: 'SBI-003', number: 13, kind: 'validation', dependsOn: ['SBI-001', 'SBI-002'] },
]);
const implementationOnlyPlan = planOf(8, fullPlan.sbis.slice(0, 2));
// The digest a human accepts binds the approved plan and the SBI composition (ID, Issue number, kind) to the evidence, so changing the SBIs voids it.
const composition = [{ id: 'SBI-001', number: 11, kind: 'implementation' }, { id: 'SBI-002', number: 12, kind: 'implementation' }, { id: 'SBI-003', number: 13, kind: 'validation' }];
const keyOf = (plan, revision = 1) => approvalKey(planDigest(plan), revision);
const pbiDigest = (sbis, evidence, plan = fullPlan) => createHash('sha256').update(JSON.stringify({ plan: keyOf(plan), sbis, evidence })).digest('hex');
const acceptedDigest = pbiDigest(composition, validationDigest);
const planned = (overrides = {}) => ({
  id: 'SBI-001', kind: 'implementation', title: 'ログイン画面', purpose: '受講生がログインできる。',
  scope: { included: ['apps/mobile ログイン画面'], excluded: [] },
  acceptanceCriteria: [{ id: 'AC-1', description: 'ログインできる' }],
  scenarios: [{ name: 'ログイン', given: ['受講生が登録済み'], when: ['ログインする'], then: ['ホームが表示される'], acceptanceIds: ['AC-1'], test: 'Jest: apps/mobile/src/features/login/index.test.tsx' }],
  dependsOn: [], changeAreas: ['apps/mobile'], layers: ['画面Component'], estimatedFiles: 2, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
  verification: { applicationTest: 'Jest', acceptance: 'Trusted Acceptance', e2e: 'Maestro（モックAPI）' },
  ...overrides,
});
const plannedSbis = [
  planned(),
  planned({ id: 'SBI-002', title: 'ログイン失敗の表示', dependsOn: ['SBI-001'] }),
  planned({ id: 'SBI-003', kind: 'validation', title: '実APIでログインを確認する', dependsOn: ['SBI-001', 'SBI-002'], layers: [], verification: { applicationTest: 'なし', acceptance: 'Trusted Acceptance', e2e: 'Maestro（実API + Rails + DB）' } }),
];
const numbers = { 'SBI-001': 11, 'SBI-002': 12, 'SBI-003': 13 };
const sbiIssue = (sbi, overrides = {}) => ({
  number: numbers[sbi.id], title: `${sbi.id} ${sbi.title}`, body: renderSbiBody(sbi, pbi, numbers), html_url: issueUrl(numbers[sbi.id]),
  state: 'open', labels: [{ name: 'sbi' }, { name: 'ready' }], ...overrides,
});
// A Harness PR that merged into main: Closes #N in the body and the SBI-Issue trailer on a commit.
const mergedPull = (issue, number, head, overrides = {}) => ({
  number, merged_at: '2026-10-28T00:00:00Z', base: { ref: 'main' }, body: `Closes #${issue}`, head: { sha: head, repo: { full_name: 'acme/app' } },
  merge_commit_sha: sha(String(number % 10)), user: { login: 'harness-operator', type: 'User' }, ...overrides,
});
const passing = [{ id: 1, name: 'harness', status: 'completed', conclusion: 'success' }];

function world(overrides = {}) {
  const state = {
    pbi: { number: 8, title: pbi.title, body: 'PBI', html_url: pbi.url, state: 'closed', state_reason: 'completed', labels: [{ name: 'plan-approved' }] },
    issues: plannedSbis.map(s => sbiIssue(s)),
    pulls: { 21: mergedPull(11, 21, sha('1')), 22: mergedPull(12, 22, sha('2')) },
    timeline: { 11: [21], 12: [22], 13: [] },
    commits: { 21: ['feat: login\n\nSBI-Issue: https://github.com/acme/app/issues/11'], 22: ['feat: error\n\nSBI-Issue: https://github.com/acme/app/issues/12'] },
    checkRuns: { [sha('1')]: passing, [sha('2')]: passing },
    rulesetChecks: [],
    blockedBy: [],
    plan: fullPlan,
    fail: {},
    ...overrides,
  };
  const guard = name => { if (state.fail[name]) throw new Error(`gh api GET ${name}: HTTP 502`); };
  const github = {
    async fetchIssue(ref) { guard('issue'); if (ref.number !== 8) throw new Error('HTTP 404'); return { ...state.pbi, body: state.pbiBody ?? `PBI\n\n${renderPlanSection(pbi.url, state.plan)}` }; },
    async bodyVersions() { guard('versions'); return state.versions ?? []; },
    async listIssues(_ref, label) { guard('list'); return state.issues.filter(i => i.labels.some(l => l.name === label)); },
    async issueTimeline(ref) { guard('timeline'); return (state.timeline[ref.number] ?? []).map(n => ({ event: 'cross-referenced', source: { issue: { number: n, html_url: `https://github.com/acme/app/pull/${n}`, pull_request: {} } } })); },
    async fetchPull(_ref, number) { guard('pull'); return state.pulls[number]; },
    async pullCommitMessages(_ref, number) { guard('commits'); return state.commits[number] ?? []; },
    async blockedBy() { guard('blockedBy'); return state.blockedBy; },
  };
  const githubPr = {
    async checkRuns(_repo, head) { guard('checkRuns'); return state.checkRuns[head] ?? []; },
    async rulesetChecks() { guard('rules'); return state.rulesetChecks; },
  };
  return { state, github, githubPr };
}
// What #68's Maestro Evidence will provide once connected: the mock lane for implementation SBIs, the real lane plus a digest for the validation SBI.
const connected = (byId = {}) => ({
  async read({ sbi }) {
    if (byId[sbi.id]) return byId[sbi.id];
    return sbi.kind === 'validation' ? { connected: true, e2e: { status: 'PASS', api: 'real' }, evidenceDigest: validationDigest } : { connected: true, e2e: { status: 'PASS', api: 'mock' }, evidenceDigest: mockDigest(sbi.id) };
  },
});
const approval = (overrides = {}) => ({
  id: 'rec-1', purpose: 'pbi-acceptance', pbiUrl: pbi.url, reviewer: 'os:501:reviewer', kind: 'human', identitySource: 'local-os-user',
  decision: 'APPROVE', decidedAt: '2026-10-28T00:00:00.000Z', evidenceDigest: acceptedDigest, signature: 's'.repeat(64), ...overrides,
});
const config = { github: { remote: 'origin', base: 'main', requiredChecks: ['harness'] } };
async function status({ state: stateOverrides, evidence = connected(), records = [approval()], options = {} } = {}) {
  const { github, githubPr } = world(stateOverrides);
  return collectPbiStatus({ root: '/nonexistent', pbiUrl: pbi.url, config, github, githubPr, evidence, acceptanceRecords: async () => records, ...options });
}
const implementationOnlyIssues = plannedSbis.slice(0, 2).map(s => sbiIssue(s));

describe('PBI Status: collecting the PBI from GitHub', () => {
  describe('given a PBI whose SBIs merged, passed every required check and E2E, with the PBI closed as completed and no open blocker', () => {
    it('when the status is collected then the PBI is DONE and every SBI is listed with its kind, Issue, PR and results', async () => {
      const result = await status();
      assert.equal(result.status, 'DONE', result.reasons.join('\n'));
      assert.deepEqual(result.reasons, []);
      assert.deepEqual(result.pbi, { url: pbi.url, number: 8, title: pbi.title, state: 'closed', stateReason: 'completed' });
      assert.deepEqual(result.sbis.map(s => [s.id, s.kind, s.issueUrl, s.status]), [
        ['SBI-001', 'implementation', issueUrl(11), 'DONE'], ['SBI-002', 'implementation', issueUrl(12), 'DONE'], ['SBI-003', 'validation', issueUrl(13), 'DONE'],
      ]);
      assert.deepEqual(result.sbis[0].pullRequest, { number: 21, url: 'https://github.com/acme/app/pull/21', headSha: sha('1') });
      assert.equal(result.sbis[0].merged, true);
      assert.equal(result.sbis[0].requiredVerifiers, 'PASS');
      assert.deepEqual(result.sbis[0].e2e, { status: 'PASS', api: 'mock' });
      assert.deepEqual(result.sbis[2].dependsOn, ['SBI-001', 'SBI-002']);
      assert.equal(result.acceptance, 'APPROVED');
      assert.equal(result.evidenceDigest, acceptedDigest);
      assert.deepEqual(result.blockers, []);
    });
    it('when the Issues of another PBI or Issues without the Planner marker carry the sbi label then they are not SBIs of this PBI', async () => {
      const other = sbiIssue(planned({ id: 'SBI-001' }), { number: 30, html_url: issueUrl(30), body: renderSbiBody(planned(), { ...pbi, number: 9, url: issueUrl(9) }, {}) });
      const handwritten = { number: 31, title: 'SBI-004 手書き', body: '## 目的\n\n手書き', html_url: issueUrl(31), state: 'open', labels: [{ name: 'sbi' }] };
      const result = await status({ state: { issues: [...plannedSbis.map(s => sbiIssue(s)), other, handwritten] } });
      assert.deepEqual(result.sbis.map(s => s.issueUrl), [issueUrl(11), issueUrl(12), issueUrl(13)]);
      assert.equal(result.status, 'DONE');
    });
  });

  describe('given implementation SBIs whose merge GitHub does not confirm', () => {
    for (const [name, change] of [
      ['the PR is still open', s => { s.pulls[22].merged_at = null; }],
      ['the PR merged into another branch', s => { s.pulls[22].base.ref = 'develop'; }],
      ['the PR does not close the SBI Issue', s => { s.pulls[22].body = 'Refs #12'; }],
      ['no commit carries the SBI-Issue trailer, even if the PR body claims it is done', s => { s.commits[22] = ['feat: error']; s.pulls[22].body = 'Closes #12\n\nstatus: DONE\nSBI-Issue: https://github.com/acme/app/issues/12'; }],
      ['no PR references the SBI Issue, even though the Issue was closed by hand', s => { s.timeline[12] = []; s.issues[1].state = 'closed'; }],
    ]) {
      it(`when ${name} then the SBI is not merged and the PBI is NOT_DONE`, async () => {
        const { state } = world();
        change(state);
        const result = await status({ state });
        assert.equal(result.status, 'NOT_DONE');
        assert.equal(result.sbis[1].merged, false);
        assert.notEqual(result.sbis[1].status, 'DONE');
        assert.match(result.reasons.join('\n'), /SBI-002/);
      });
    }
  });

  describe('given required checks on the merged head of an implementation SBI', () => {
    for (const [name, change, pattern] of [
      ['the harness check failed', s => { s.checkRuns[sha('2')] = [{ id: 2, name: 'harness', status: 'completed', conclusion: 'failure' }]; }, /SBI-002.*必須Verifier.*FAIL/],
      ['the harness check was skipped', s => { s.checkRuns[sha('2')] = [{ id: 2, name: 'harness', status: 'completed', conclusion: 'skipped' }]; }, /SBI-002.*必須Verifier.*FAIL/],
      ['the harness check never ran', s => { s.checkRuns[sha('2')] = []; }, /SBI-002.*必須Verifier.*FAIL/],
      ['a ruleset check is missing', s => { s.rulesetChecks = [{ context: 'e2e', integrationId: null }]; }, /SBI-00[12].*必須Verifier.*FAIL/],
    ]) {
      it(`when ${name} then the PBI is NOT_DONE`, async () => {
        const { state } = world();
        change(state);
        const result = await status({ state });
        assert.equal(result.status, 'NOT_DONE');
        assert.match(result.reasons.join('\n'), pattern);
      });
    }
    it('when no required check is configured anywhere then the verifiers are NOT_CONFIGURED and the PBI is NOT_DONE', async () => {
      const result = await status({ options: { config: { github: { remote: 'origin', base: 'main', requiredChecks: [] } } } });
      assert.equal(result.status, 'NOT_DONE');
      assert.equal(result.sbis[0].requiredVerifiers, 'NOT_CONFIGURED');
    });
  });

  describe('given the SBIs of the PBI', () => {
    it('when the PBI has no SBI Issue then it is NOT_DONE', async () => {
      const result = await status({ state: { issues: [] } });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /SBI/);
    });
    it('when two open SBI Issues claim the same SBI ID then the PBI is NOT_DONE instead of choosing one', async () => {
      const copy = sbiIssue(plannedSbis[0], { number: 14, html_url: issueUrl(14) });
      const result = await status({ state: { issues: [...plannedSbis.map(s => sbiIssue(s)), copy] } });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /SBI-001.*#11.*#14|SBI-001.*#14.*#11/);
    });
  });
});

describe('PBI Status: Maestro E2E Evidence', () => {
  describe('given the evidence of each SBI', () => {
    it('when an implementation SBI ran its E2E against the real API then only mock results count and the PBI is NOT_DONE', async () => {
      const result = await status({ evidence: connected({ 'SBI-001': { connected: true, e2e: { status: 'PASS', api: 'real' } } }) });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /SBI-001.*モック以外/);
    });
    it('when the validation SBI ran its E2E against the mock API then only real API + Rails + DB results count and the PBI is NOT_DONE', async () => {
      const result = await status({ evidence: connected({ 'SBI-003': { connected: true, e2e: { status: 'PASS', api: 'mock' }, evidenceDigest: validationDigest } }) });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /SBI-003.*実API以外/);
    });
    it('when the validation E2E failed then the PBI is NOT_DONE', async () => {
      const result = await status({ evidence: connected({ 'SBI-003': { connected: true, e2e: { status: 'FAIL', api: 'real' }, evidenceDigest: validationDigest } }) });
      assert.equal(result.status, 'NOT_DONE');
    });
    it('when an implementation SBI has no E2E target then it needs no E2E result', async () => {
      const result = await status({ evidence: connected({ 'SBI-002': { connected: true, e2e: null } }) });
      assert.equal(result.status, 'DONE', result.reasons.join('\n'));
    });
  });

  describe('given an evidence adapter that has no evidence to offer', () => {
    it('when the status is collected then every SBI is NOT_DONE for missing evidence instead of treating it as no E2E target', async () => {
      const result = await status({ evidence: notConnected });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /Maestro E2E Evidenceを接続できません/);
      for (const sbi of result.sbis) assert.equal(sbi.e2e, null);
      assert.equal(result.ready, false);
    });
    it('when no evidence adapter is given then the Maestro adapter reads the snapshot of each merged head from GitHub and fails closed when the CI run cannot be read', async () => {
      const { github, githubPr } = world();
      const read = [];
      github.fileAt = async (_ref, path, at) => { read.push([path, at]); return null; };
      const actions = { async checkRuns() { throw new Error('HTTP 502'); } };
      const result = await collectPbiStatus({ root: '/nonexistent', pbiUrl: pbi.url, config, github, githubPr, actions, acceptanceRecords: async () => [approval()] });
      assert.equal(result.status, 'NOT_DONE');
      assert.deepEqual(read, [['.harness/state/sbi-11.json', sha('1')], ['.harness/state/sbi-12.json', sha('2')]]);
      assert.match(result.reasons.join('\n'), /SBI-001.*snapshot/);
    });
  });
  describe('given an evidence response that does not have the agreed shape', () => {
    for (const [name, response] of [
      ['a connected implementation result without the e2e key', { connected: true }],
      ['a connected result whose e2e has no api', { connected: true, e2e: { status: 'PASS' } }],
      ['a connected result whose e2e api is unknown', { connected: true, e2e: { status: 'PASS', api: 'staging' } }],
      ['a not-connected answer without a reason', { connected: false }],
      ['no connected flag', { e2e: null }],
      ['an unknown extra field', { connected: true, e2e: null, skip: true }],
    ]) {
      it(`when it is ${name} then the evidence is invalid and the PBI is NOT_DONE instead of treating it as no E2E target`, async () => {
        const result = await status({ evidence: connected({ 'SBI-002': response }) });
        assert.equal(result.status, 'NOT_DONE');
        assert.match(result.reasons.join('\n'), /SBI-002.*Evidence.*不正/);
      });
    }
    it('when the validation result has no evidence digest then the evidence is invalid and the PBI is NOT_DONE', async () => {
      const result = await status({ evidence: connected({ 'SBI-003': { connected: true, e2e: { status: 'PASS', api: 'real' } } }) });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /SBI-003.*Evidence.*不正/);
    });
  });
  describe('given an evidence adapter that fails', () => {
    it('when reading the evidence throws then the PBI is NOT_DONE with the reason', async () => {
      const result = await status({ evidence: { async read() { throw new Error('artifact expired'); } } });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /artifact expired/);
    });
  });
});

describe('PBI Status: manual acceptance on GitHub', () => {
  describe('given all SBI checks passed', () => {
    it('when the PBI is closed as completed without any local acceptance ledger then it is DONE', async () => {
      let ledgerRead = false;
      const result = await status({ records: [], options: { acceptanceRecords: async () => { ledgerRead = true; throw new Error('obsolete ledger'); } } });
      assert.equal(result.status, 'DONE', result.reasons.join('\n'));
      assert.equal(result.acceptance, 'APPROVED');
      assert.equal(ledgerRead, false);
    });
    for (const [name, issue] of [
      ['the PBI is open', { state: 'open', state_reason: null }],
      ['the PBI is reopened', { state: 'open', state_reason: 'reopened' }],
      ['the PBI is cancelled', { state: 'closed', state_reason: 'not_planned' }],
      ['the completion reason is missing', { state: 'closed', state_reason: undefined }],
    ]) {
      it(`when ${name} then it stays NOT_DONE even with an old signed approval`, async () => {
        const { state } = world();
        Object.assign(state.pbi, issue);
        const result = await status({ state });
        assert.equal(result.status, 'NOT_DONE');
        assert.equal(result.acceptance, 'PENDING');
        assert.equal(result.ready, true);
        assert.match(result.reasons.join('\n'), /PBI.*完了として閉じ/);
      });
    }
    it('when no validation SBI is needed then closing the PBI completes it without a dedicated command', async () => {
      const result = await status({ state: { issues: implementationOnlyIssues, plan: implementationOnlyPlan }, records: [] });
      assert.equal(result.status, 'DONE', result.reasons.join('\n'));
    });
  });
  describe('given a missing SBI in the approved plan', () => {
    for (const [name, change] of [
      ['its sbi label was removed', s => { s.issues[0].labels = [{ name: 'ready' }]; }],
      ['its Planner marker was removed from the body', s => { s.issues[0].body = s.issues[0].body.replace(/<!-- sonomama-sbi [^>]*-->/, ''); }],
    ]) {
      it(`when ${name} while it is unmerged then the PBI is NOT_DONE because a listed dependency is missing`, async () => {
        const { state } = world();
        change(state);
        state.timeline[11] = [];
        const result = await status({ state, records: [approval({ evidenceDigest: pbiDigest(composition.slice(1), validationDigest) })] });
        assert.equal(result.status, 'NOT_DONE');
        assert.match(result.reasons.join('\n'), /SBI-00[23].*依存.*SBI-001.*ありません/);
        assert.equal(result.ready, false);
      });
    }
  });
});

describe('PBI Status: the approved PBI plan', () => {
  // ADR-0009: the plan-approved label a human puts on the PBI is the plan approval (MVP); who added it is not checked.
  describe('given the PBI plan in ## SBI構成 and the plan-approved label on the PBI', () => {
    it('when the status is collected then the plan digest is reported as approved', async () => {
      const result = await status();
      assert.deepEqual(result.plan, { digest: planDigest(fullPlan), revision: 1, approvalKey: keyOf(fullPlan), approved: true });
    });
    for (const [name, state, pattern] of [
      ['the PBI body has no ## SBI構成', { pbiBody: 'PBI' }, /SBI構成/],
      ['the PBI has no plan-approved label', { pbi: { number: 8, title: pbi.title, body: 'PBI', html_url: pbi.url, state: 'open', labels: [] } }, /PBI plan.*承認されていません[\s\S]*plan-approved/],
      ['the edit history of the PBI cannot be read', { fail: { versions: true } }, /HTTP 502/],
    ]) {
      it(`when ${name} then the PBI is NOT_DONE`, async () => {
        const result = await status({ state });
        assert.equal(result.status, 'NOT_DONE');
        assert.match(result.reasons.join('\n'), pattern);
        assert.equal(result.ready, false);
      });
    }
    it('when only a harness-pbi-plan comment approves the plan then the PBI is NOT_DONE, since the label is the approval', async () => {
      const { state, github, githubPr } = world({ pbi: { number: 8, title: pbi.title, body: 'PBI', html_url: pbi.url, state: 'open', labels: [] } });
      github.listComments = async () => [{ id: 1, body: `harness-pbi-plan: ${keyOf(state.plan)}`, user: { login: 'alice', type: 'User' }, created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z' }];
      github.permission = async () => 'admin';
      const result = await collectPbiStatus({ root: '/nonexistent', pbiUrl: pbi.url, config, github, githubPr, evidence: connected(), acceptanceRecords: async () => [approval()] });
      assert.equal(result.plan.approved, false);
    });
  });
  describe('given an edit of the PBI body outside ## SBI構成', () => {
    it('when the status is collected then the plan keeps its revision and its approval', async () => {
      const result = await status({ state: { versions: [{ body: `PBI\n\n${renderPlanSection(pbi.url, fullPlan)}`, deletedAt: null }], pbiBody: `PBI 追記\n\n${renderPlanSection(pbi.url, fullPlan)}` } });
      assert.equal(result.plan.revision, 1);
      assert.equal(result.plan.approved, true);
    });
  });
  describe('given the SBI Issues found on GitHub and the approved plan', () => {
    it('when an SBI of the approved plan cannot be found because its label was removed then the PBI is NOT_DONE even if no SBI depends on it', async () => {
      const plan = planOf(8, [...fullPlan.sbis, { id: 'SBI-004', number: 14, kind: 'implementation', dependsOn: [] }]);
      const result = await status({ state: { plan } });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /SBI #14 が見つかりません/);
    });
    it('when an SBI Issue of the PBI is not in the approved plan then the PBI is NOT_DONE', async () => {
      const extra = sbiIssue(planned({ id: 'SBI-004' }), { number: 14, html_url: issueUrl(14) });
      const result = await status({ state: { issues: [...plannedSbis.map(s => sbiIssue(s)), extra] } });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /SBI #14 が承認済みPBI planに登録されていません/);
    });
    it('when an SBI Issue now says another kind than the approved plan then the PBI is NOT_DONE', async () => {
      const { state } = world();
      state.issues[1] = sbiIssue(planned({ id: 'SBI-002', kind: 'validation', dependsOn: ['SBI-001'] }));
      const result = await status({ state });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /SBI #12.*承認済みPBI plan.*一致しません/);
    });
  });
  describe('given an APPROVE of the PBI Human Acceptance', () => {
    it('when the plan is not approved then APPROVE is not ready', async () => {
      const result = await status({ state: { pbi: { number: 8, title: pbi.title, body: 'PBI', html_url: pbi.url, state: 'open', labels: [] } }, records: [] });
      assert.equal(result.ready, false);
    });
  });
});

describe('PBI Status: blockers', () => {
  describe('given Issues registered on GitHub as blocking the PBI (blocked by)', () => {
    it('when one is open then the PBI is NOT_DONE and names it', async () => {
      const result = await status({ state: { blockedBy: [{ number: 40, title: 'ログインできない', body: null, html_url: issueUrl(40), state: 'open', labels: [{ name: 'bug' }] }] } });
      assert.equal(result.status, 'NOT_DONE');
      assert.deepEqual(result.blockers, [{ url: issueUrl(40), title: 'ログインできない', state: 'open' }]);
      assert.match(result.reasons.join('\n'), /blocker.*issues\/40/);
      assert.equal(result.ready, false);
    });
    it('when every one is closed then it does not block the PBI', async () => {
      const result = await status({ state: { blockedBy: [{ number: 40, title: 'ログインできない', body: null, html_url: issueUrl(40), state: 'closed', labels: [{ name: 'bug' }] }] } });
      assert.equal(result.status, 'DONE', result.reasons.join('\n'));
    });
  });
});

describe('PBI Status: GitHub failures fail closed', () => {
  for (const name of ['issue', 'list', 'timeline', 'pull', 'commits', 'checkRuns', 'rules', 'blockedBy']) {
    it(`when reading ${name} from GitHub fails then the PBI is NOT_DONE with the reason instead of throwing`, async () => {
      const result = await status({ state: { fail: { [name]: true } } });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /HTTP 502/);
    });
  }
  it('when the PBI URL is a pull request then the PBI is NOT_DONE', async () => {
    const { state } = world();
    state.pbi.pull_request = { url: 'x' };
    const result = await status({ state });
    assert.equal(result.status, 'NOT_DONE');
    assert.match(result.reasons.join('\n'), /pull request/);
  });
  it('when the PBI URL is not a GitHub Issue URL then collecting is rejected', async () => {
    const { github, githubPr } = world();
    await assert.rejects(collectPbiStatus({ root: '/nonexistent', pbiUrl: 'https://example.com/8', config, github, githubPr }), /Issue URL/);
  });
});

describe('PBI Status: display', () => {
  describe('given a collected status', () => {
    it('when it is rendered then the PBI, its status, each SBI, Human Acceptance, blockers and the reasons are shown', async () => {
      const { state } = world();
      state.pbi.state = 'open'; state.pbi.state_reason = null;
      const text = renderPbiStatus(await status({ state, records: [] })).join('\n');
      assert.match(text, /^PBI: #8 受講生ログイン$/m);
      assert.match(text, /^Status: NOT_DONE$/m);
      assert.match(text, /SBI-001 implementation .*#11.*merged.*verifier PASS.*E2E mock PASS/);
      assert.match(text, /SBI-003 validation .*#13.*E2E real PASS/);
      assert.match(text, /PBI plan\n✅ APPROVED \(plan-approved, digest [0-9a-f]{12}\)/);
      assert.match(text, /Human Acceptance\n.*PENDING/);
      assert.match(text, new RegExp(`Evidence digest: ${acceptedDigest}`));
      assert.match(text, /GitHub.*PBI.*完了として閉じ/);
      assert.doesNotMatch(text, /harness:pbi-accept|--evidence/);
      assert.match(text, /Blockers\n.*none/);
      assert.doesNotMatch(text, /[Bb]ug/);
      assert.match(text, /Reason:\n- PBI.*完了として閉じ/);
    });
    it('when the Maestro E2E Evidence is not connected then each SBI line says so instead of showing no E2E target', async () => {
      const text = renderPbiStatus(await status({ evidence: notConnected })).join('\n');
      assert.match(text, /SBI-001 implementation .*E2E 未接続/);
      assert.match(text, /SBI-003 validation .*E2E 未接続/);
      assert.doesNotMatch(text, /E2E none/);
    });
    it('when the evidence of an SBI cannot be read then its line says it is unreadable', async () => {
      const text = renderPbiStatus(await status({ evidence: { async read() { throw new Error('artifact expired'); } } })).join('\n');
      assert.match(text, /SBI-001 implementation .*E2E unreadable/);
    });
    it('when the PBI plan is not approved then the display says so', async () => {
      const text = renderPbiStatus(await status({ state: { pbi: { number: 8, title: pbi.title, body: 'PBI', html_url: pbi.url, state: 'open', labels: [] } } })).join('\n');
      assert.match(text, /PBI plan\n❌ NOT_APPROVED \(digest [0-9a-f]{12}\)/);
    });
    it('when the PBI is DONE then no reason is listed', async () => {
      const text = renderPbiStatus(await status()).join('\n');
      assert.match(text, /^Status: DONE$/m);
      assert.doesNotMatch(text, /Reason:/);
    });
  });
});

describe('PBI Evidence manifest', () => {
  const human = async () => ({ id: 'os:501:reviewer', kind: 'human', source: 'local-os-user' });
  async function withRoot(fn) {
    const root = await mkdtemp(join(tmpdir(), 'harness-pbi-manifest-'));
    try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
  }
  const resultDigest = id => mockDigest(id);
  const source = sbi => ({ workflowRunId: 900 + sbi.number, artifactId: 1000 + sbi.number, lane: sbi.kind === 'validation' ? 'real' : 'mock', resultDigest: sbi.kind === 'validation' ? validationDigest : resultDigest(sbi.id) });
  // The raw CI artifact: readable until it expires, then the adapter says the artifact is unavailable.
  const ci = (expired = new Set(), rerun = new Set()) => ({
    async read({ sbi }) {
      const { workflowRunId, artifactId } = source(sbi);
      if (expired.has(sbi.id)) throw Object.assign(new Error(`workflow run ${workflowRunId} のmaestro-results artifactが期限切れ`), { artifactUnavailable: true, workflowRunId, artifactId: rerun.has(sbi.id) ? artifactId + 1 : artifactId });
      return sbi.kind === 'validation' ? { connected: true, e2e: { status: 'PASS', api: 'real' }, evidenceDigest: validationDigest, source: source(sbi) }
        : { connected: true, e2e: { status: 'PASS', api: 'mock' }, evidenceDigest: resultDigest(sbi.id), source: source(sbi) };
    },
  });
  const run = (root, { evidence = ci(), state, decision } = {}) => {
    const { github, githubPr } = world(state);
    const options = { root, pbiUrl: pbi.url, config, github, githubPr, evidence };
    if (decision) return collectPbiStatus(options).then(async current => {
      assert.equal(current.ready, true, current.reasons.join('\n'));
      return recordEvidenceManifest({ root, pbiUrl: pbi.url, manifest: current.manifestDraft });
    });
    return collectPbiStatus(options);
  };
  describe('given an existing signed Evidence manifest', () => {
    it('when a verified manifest is stored then a signed manifest of the verified evidence is stored with the plan, each SBI, its PR, SHAs, required checks, lane, result digest, run and artifact', () => withRoot(async root => {
      await run(root, { decision: 'APPROVE' });
      const [manifest] = await evidenceManifests(root, pbi.url);
      assert.equal(manifest.evidenceDigest, acceptedDigest);
      assert.deepEqual(manifest.plan, { digest: planDigest(fullPlan), revision: 1, approvalKey: keyOf(fullPlan) });
      assert.deepEqual(manifest.sbis[0], {
        id: 'SBI-001', number: 11, kind: 'implementation', pullRequest: 21, headSha: sha('1'), mergeCommitSha: sha('1'),
        requiredChecks: [{ name: 'harness', status: 'SUCCESS' }], e2e: { status: 'PASS', api: 'mock' },
        lane: 'mock', resultDigest: resultDigest('SBI-001'), workflowRunId: 911, artifactId: 1011,
      });
      assert.equal(manifest.sbis[2].lane, 'real');
      assert.match(manifest.signature, /^[0-9a-f]{64}$/);
    }));
  });
  describe('given the raw artifact expired', () => {
    it('when there is no historical manifest and the PBI is NOT_DONE', () => withRoot(async root => {
      const result = await run(root, { evidence: ci(new Set(['SBI-001'])) });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /SBI-001.*期限切れ/);
    }));
    it('when it expired after APPROVE then the signed manifest keeps the PBI DONE and the SBI shows it came from the manifest', () => withRoot(async root => {
      await run(root, { decision: 'APPROVE' });
      const result = await run(root, { evidence: ci(new Set(['SBI-001', 'SBI-003'])) });
      assert.equal(result.status, 'DONE', result.reasons.join('\n'));
      assert.equal(result.sbis[0].evidence, 'MANIFEST');
      assert.match(renderPbiStatus(result).join('\n'), /SBI-001 implementation .*E2E mock PASS \(manifest\)/);
    }));
    for (const [name, state] of [
      ['the plan changed', { plan: implementationOnlyPlan, issues: implementationOnlyIssues }],
      ['the merged head of an SBI changed', { pulls: { 21: mergedPull(11, 21, sha('7')), 22: mergedPull(12, 22, sha('2')) }, checkRuns: { [sha('7')]: passing, [sha('2')]: passing } }],
      ['the merge commit of an SBI changed', { pulls: { 21: mergedPull(11, 21, sha('1'), { merge_commit_sha: sha('8') }), 22: mergedPull(12, 22, sha('2')) } }],
      ['another Issue now claims an SBI ID', { issues: [sbiIssue(plannedSbis[0], { number: 15, html_url: issueUrl(15) }), ...plannedSbis.slice(1).map(s => sbiIssue(s))], timeline: { 15: [21], 12: [22], 13: [] } }],
    ]) {
      it(`when ${name} after APPROVE then the manifest no longer counts and the PBI is NOT_DONE`, () => withRoot(async root => {
        await run(root, { decision: 'APPROVE' });
        const result = await run(root, { evidence: ci(new Set(['SBI-001', 'SBI-002', 'SBI-003'])), state });
        assert.equal(result.status, 'NOT_DONE');
        assert.ok(result.sbis.every(s => s.evidence !== 'MANIFEST'), JSON.stringify(result.sbis));
      }));
    }
    it('when CI was re-run after APPROVE and the artifact now selected is another one then the manifest does not stand in', () => withRoot(async root => {
      await run(root, { decision: 'APPROVE' });
      const result = await run(root, { evidence: ci(new Set(['SBI-001']), new Set(['SBI-001'])) });
      assert.equal(result.status, 'NOT_DONE');
      assert.notEqual(result.sbis[0].evidence, 'MANIFEST');
    }));
    it('when the manifest ledger was edited then the PBI is NOT_DONE with the reason', () => withRoot(async root => {
      await run(root, { decision: 'APPROVE' });
      const path = pbiEvidenceLedgerPath(root, parseIssueUrl(pbi.url));
      await writeText(path, (await readText(path, 'utf8')).replace('"PASS"', '"FAIL"'));
      const result = await run(root, { evidence: ci(new Set(['SBI-001'])) });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /signature invalid/);
    }));

  });
});

describe('GitHub adapter for blocking Issues', () => {
  describe('given the gh CLI', () => {
    it('when the Issues blocking the PBI are read then the GitHub issue dependencies (blocked by) endpoint is used', () => githubMock({})({ blockedBy: { 8: [{ number: 40, title: 'bug', body: null, html_url: issueUrl(40), state: 'open', labels: [] }] } }, async github => {
      const issues = await githubCli.blockedBy(pbi);
      assert.deepEqual(issues.map(i => i.html_url), [issueUrl(40)]);
      assert.ok((await github.calls()).some(c => c.args[1].startsWith('repos/acme/app/issues/8/dependencies/blocked_by')));
    }));
  });
});

describe('PBI Status CLI', () => {
  const cli = new URL('./cli.mjs', import.meta.url).pathname;
  describe('given the commands offered to developers', () => {
    it('when the package scripts are read then status remains available and no acceptance command is needed', async () => {
      const { scripts } = JSON.parse(await readText(new URL('../../package.json', import.meta.url), 'utf8'));
      assert.equal(scripts['harness:pbi-status'], 'node tools/harness/cli.mjs pbi-status');
      assert.equal(scripts['harness:pbi-accept'], undefined);
    });
    it('when usage is printed then it offers status without a dedicated acceptance command', async () => {
      const { stderr } = await execute(process.execPath, [cli, 'unknown']);
      assert.match(stderr, /pnpm harness:pbi-status PBI_URL/);
      assert.doesNotMatch(stderr, /harness:pbi-accept/);
    });
    it('when the removed acceptance command is invoked then it cannot record an approval', async () => {
      const result = await execute(process.execPath, [cli, 'pbi-accept', pbi.url]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Usage:/);
    });
    it('when pbi-plan-approve has no PBI URL then it exits 1 without posting', async () => {
      const result = await execute(process.execPath, [cli, 'pbi-plan-approve']);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /PBI URL/);
    });
    it('when pbi-status has no PBI URL then it exits 1', async () => {
      const result = await execute(process.execPath, [cli, 'pbi-status', '--json']);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /PBI URL/);
    });
  });
});
