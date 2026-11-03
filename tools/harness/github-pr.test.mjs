import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { reviewApprovals, ciStatus, pullRequestBody } from './github-pr.mjs';
import { mergeDecision } from './merge-policy.mjs';
import { fixture, human } from './test-fixture.mjs';
import { openPullRequest, resumeRun } from './index.mjs';
import { exists, readJson } from './io.mjs';
import { remoteSha, succeed, reviewBy, issueUrl, planned, sbiIssue, withIssue, issueRun } from './test-github-pr.mjs';

const head = 'a'.repeat(40), old = 'b'.repeat(40), base = 'd'.repeat(40);
let nextId = 1;
const review = (login, state, commit = head, type = 'User') => ({ id: nextId++, user: { login, type }, state, commit_id: commit });
const run = (name, status, conclusion = null, id = nextId++, appId = 15368) => ({ id, name, status, conclusion, head_sha: head, app: { id: appId } });
// Repository permission per reviewer, as GitHub reports it (maintain is reported as write).
const permissions = { alice: 'write', bob: 'write', author: 'admin', 'ci-helper': 'write', 'copilot[bot]': 'write' };

describe('GitHub Review approvals', () => {
  describe('given reviews on the pull request', () => {
    it('when distinct humans approve the head SHA then each counts once', () => {
      const result = reviewApprovals({ reviews: [review('alice', 'APPROVED'), review('bob', 'APPROVED'), review('alice', 'APPROVED')], headSha: head, author: 'author', permissions });
      assert.deepEqual(result.approvedHumans, ['alice', 'bob']);
      assert.equal(result.changesRequested, false);
    });
    it('when an approval was given to an older commit then it is not counted', () => {
      assert.deepEqual(reviewApprovals({ reviews: [review('alice', 'APPROVED', old)], headSha: head, author: 'author', permissions }).approvedHumans, []);
    });
    it('when a bot or a GitHub App approves then it is not a human approval', () => {
      const reviews = [review('ci-helper', 'APPROVED', head, 'Bot'), review('copilot[bot]', 'APPROVED')];
      assert.deepEqual(reviewApprovals({ reviews, headSha: head, author: 'author', permissions }).approvedHumans, []);
    });
    it('when the pull request author approves then it is not counted', () => {
      assert.deepEqual(reviewApprovals({ reviews: [review('author', 'APPROVED')], headSha: head, author: 'author', permissions }).approvedHumans, []);
    });
    it('when a reviewer comments after approving then the approval still stands', () => {
      const result = reviewApprovals({ reviews: [review('alice', 'APPROVED'), review('alice', 'COMMENTED')], headSha: head, author: 'author', permissions });
      assert.deepEqual(result.approvedHumans, ['alice']);
    });
    it('when a reviewer requests changes on an older commit and never re-reviews then changes are still requested', () => {
      const result = reviewApprovals({ reviews: [review('alice', 'CHANGES_REQUESTED', old), review('bob', 'APPROVED')], headSha: head, author: 'author', permissions });
      assert.equal(result.changesRequested, true);
      assert.deepEqual(result.changesRequestedBy, ['alice']);
    });
    it('when a reviewer approves after requesting changes then only the latest review counts', () => {
      const result = reviewApprovals({ reviews: [review('alice', 'CHANGES_REQUESTED'), review('alice', 'APPROVED')], headSha: head, author: 'author', permissions });
      assert.deepEqual([result.approvedHumans, result.changesRequested], [['alice'], false]);
    });
    it('when a request for changes is dismissed then it no longer blocks and grants nothing', () => {
      const result = reviewApprovals({ reviews: [review('alice', 'CHANGES_REQUESTED'), review('alice', 'DISMISSED')], headSha: head, author: 'author', permissions });
      assert.deepEqual([result.approvedHumans, result.changesRequested], [[], false]);
    });
    it('when a pending review exists then it is ignored', () => {
      assert.deepEqual(reviewApprovals({ reviews: [review('alice', 'PENDING')], headSha: head, author: 'author', permissions }).approvedHumans, []);
    });
  });
  describe('given reviewers with different repository permissions', () => {
    for (const permission of ['write', 'admin']) {
      it(`when a reviewer with ${permission} permission approves then the approval counts`, () => {
        assert.deepEqual(reviewApprovals({ reviews: [review('carol', 'APPROVED')], headSha: head, author: 'author', permissions: { carol: permission } }).approvedHumans, ['carol']);
      });
    }
    for (const permission of ['read', 'none']) {
      it(`when a reviewer with ${permission} permission approves then GitHub would not count it so neither does Harness`, () => {
        assert.deepEqual(reviewApprovals({ reviews: [review('carol', 'APPROVED')], headSha: head, author: 'author', permissions: { carol: permission } }).approvedHumans, []);
      });
    }
    it('when a reviewer without write permission requests changes then it does not block, as on GitHub', () => {
      const result = reviewApprovals({ reviews: [review('carol', 'CHANGES_REQUESTED'), review('alice', 'APPROVED')], headSha: head, author: 'author', permissions: { carol: 'read', alice: 'write' } });
      assert.deepEqual([result.approvedHumans, result.changesRequested], [['alice'], false]);
    });
    it('when a reviewer permission could not be read then the approval is not counted but a request for changes still blocks', () => {
      const approved = reviewApprovals({ reviews: [review('carol', 'APPROVED')], headSha: head, author: 'author', permissions: {} });
      const requested = reviewApprovals({ reviews: [review('carol', 'CHANGES_REQUESTED')], headSha: head, author: 'author', permissions: { carol: 'unknown' } });
      assert.deepEqual([approved.approvedHumans, requested.changesRequested], [[], true]);
    });
  });
});

describe('GitHub CI status', () => {
  describe('given the required checks for the head SHA', () => {
    it('when every required check succeeded then passes', () => {
      assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', 'success')], required: [{ context: 'harness' }] }).status, 'PASS');
    });
    it('when a required check is still running then is pending', () => {
      assert.equal(ciStatus({ checkRuns: [run('harness', 'in_progress')], required: [{ context: 'harness' }] }).status, 'PENDING');
    });
    for (const conclusion of ['failure', 'timed_out', 'action_required', 'cancelled', 'skipped', 'neutral', 'stale']) {
      it(`when a required check concluded ${conclusion} then fails`, () => {
        assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', conclusion)], required: [{ context: 'harness' }] }).status, 'FAIL');
      });
    }
    it('when a required check never ran then reports it missing and fails', () => {
      const result = ciStatus({ checkRuns: [run('lint', 'completed', 'success')], required: [{ context: 'harness' }] });
      assert.equal(result.status, 'FAIL');
      assert.deepEqual(result.checks, [{ name: 'harness', status: 'MISSING' }]);
    });
    it('when the ruleset expects the check from a specific app and only another app reported it then fails', () => {
      const result = ciStatus({ checkRuns: [run('harness', 'completed', 'success', nextId++, 999)], required: [{ context: 'harness', integrationId: 15368 }] });
      assert.equal(result.status, 'FAIL');
      assert.deepEqual(result.checks, [{ name: 'harness', integrationId: 15368, status: 'MISSING' }]);
    });
    it('when the ruleset expects the check from a specific app and that app reported success then passes', () => {
      const checkRuns = [run('harness', 'completed', 'failure', nextId++, 15368), run('harness', 'completed', 'success', nextId++, 999)];
      assert.equal(ciStatus({ checkRuns, required: [{ context: 'harness', integrationId: 15368 }] }).status, 'FAIL');
      assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', 'success', nextId++, 15368)], required: [{ context: 'harness', integrationId: 15368 }] }).status, 'PASS');
    });
    it('when no check is required then reports NOT_CONFIGURED instead of passing', () => {
      assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', 'success')], required: [] }).status, 'NOT_CONFIGURED');
    });
    it('when a check was re-run then only the latest run counts', () => {
      assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', 'success', 11), run('harness', 'completed', 'failure', 10)], required: [{ context: 'harness' }] }).status, 'PASS');
      assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', 'success', 10), run('harness', 'completed', 'failure', 11)], required: [{ context: 'harness' }] }).status, 'FAIL');
    });
  });
});

describe('Merge Policy Judge with GitHub PR state', () => {
  const checks = ['verification', 'policy-review', 'security', 'completion', 'semantic-review'].map(id => ({ id, required: true, status: 'PASS' }));
  const securityVerification = { status: 'PASS', violations: [], requiredVerifiers: ['secret-scan'], checks: [{ id: 'secret-scan', required: true, status: 'PASS' }] };
  const github = (overrides = {}) => ({
    pullRequest: { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: head, state: 'open', merged: false, testedShaMatches: true, baseRef: 'main', baseSha: base, remoteBaseSha: base, ...overrides.pullRequest },
    ci: { status: 'PASS', checks: [], ...overrides.ci },
    reviews: { approvedHumans: [], changesRequested: false, changesRequestedBy: [], ...overrides.reviews },
  });
  const decide = (level, state, extra = {}) => mergeDecision({ risk: { level, requiredHumanApprovals: level === 3 ? 2 : level === 2 ? 1 : 0 }, checks, approvals: [], securityVerification,
    headSha: head, contextDigest: 'context', humanGate: false, github: state, baseline: { ref: 'main', sha: base }, ...extra });

  describe('given the tested SHA is the pull request head and CI passes', () => {
    it('when the risk is level 3 and two different humans approved then allows merge', () => {
      const result = decide(3, github({ reviews: { approvedHumans: ['alice', 'bob'] } }));
      assert.equal(result.decision, 'MERGE_ALLOWED');
      assert.deepEqual([result.validApprovals, result.requiredApprovals], [2, 2]);
    });
    it('when the risk is level 3 and only one human approved then waits for review', () => {
      assert.equal(decide(3, github({ reviews: { approvedHumans: ['alice'] } })).decision, 'WAITING_FOR_HUMAN_REVIEW');
    });
    it('when the risk is level 2 and one human approved then allows merge', () => {
      assert.equal(decide(2, github({ reviews: { approvedHumans: ['alice'] } })).decision, 'MERGE_ALLOWED');
    });
    it('when the risk is level 1 then needs no approval', () => {
      assert.equal(decide(1, github()).decision, 'MERGE_ALLOWED');
    });
    it('when a local merge approval exists but GitHub has none then the local record is not counted', () => {
      const local = [{ kind: 'human', purpose: 'merge', reviewer: 'os:1:me', commitSha: head, contextDigest: 'context', decision: 'APPROVE' }];
      const result = decide(2, github(), { approvals: local });
      assert.equal(result.decision, 'WAITING_FOR_HUMAN_REVIEW');
      assert.equal(result.validApprovals, 0);
    });
    it('when someone requested changes then rejects even with enough approvals', () => {
      const result = decide(2, github({ reviews: { approvedHumans: ['alice'], changesRequested: true, changesRequestedBy: ['bob'] } }));
      assert.equal(result.decision, 'REJECTED');
      assert.ok(result.reasons.includes('github_changes_requested'));
    });
  });

  describe('given a pull request that does not match what Harness verified', () => {
    it('when a new commit was pushed after verification then blocks even with approvals', () => {
      const result = decide(2, github({ pullRequest: { headSha: old, testedShaMatches: false }, reviews: { approvedHumans: ['alice'] } }));
      assert.equal(result.decision, 'BLOCKED');
      assert.ok(result.reasons.includes('tested_sha_mismatch'));
    });
    for (const status of ['PENDING', 'FAIL', 'NOT_CONFIGURED']) {
      it(`when CI is ${status} then blocks`, () => {
        const result = decide(1, github({ ci: { status } }));
        assert.equal(result.decision, 'BLOCKED');
        assert.ok(result.reasons.includes('required_ci_not_passed'));
      });
    }
    it('when the pull request was already merged on GitHub then blocks and never reports MERGED', () => {
      const result = decide(1, github({ pullRequest: { state: 'closed', merged: true } }));
      assert.equal(result.decision, 'BLOCKED');
      assert.ok(result.reasons.includes('pull_request_not_open'));
    });
    it('when the GitHub state could not be read then blocks instead of trusting an earlier state', () => {
      const result = decide(1, { unavailable: 'gh api GET repos/acme/app/pulls/7: timeout' });
      assert.equal(result.decision, 'BLOCKED');
      assert.ok(result.reasons.includes('github_state_unavailable'));
    });
    // #288: main advancing alone is no reason to sync the PR; the push to main verifies the merged result.
    it('when the base branch moved past the run baseline then still allows merge, because main advancing alone needs no sync', () => {
      const result = decide(2, github({ pullRequest: { baseSha: old, remoteBaseSha: old }, reviews: { approvedHumans: ['alice'] } }));
      assert.equal(result.decision, 'MERGE_ALLOWED');
    });
    it('when the pull request targets another base branch then blocks', () => {
      assert.ok(decide(1, github({ pullRequest: { baseRef: 'develop' } })).reasons.includes('base_branch_mismatch'));
    });
    it('when GitHub reports a merge conflict with the base then blocks until the conflict is resolved', () => {
      const result = decide(1, github({ pullRequest: { mergeable: false } }));
      assert.equal(result.decision, 'BLOCKED');
      assert.ok(result.reasons.includes('merge_conflict'));
    });
    it('when GitHub has not computed mergeability yet then does not block on it', () => {
      assert.equal(decide(1, github({ pullRequest: { mergeable: null } })).decision, 'MERGE_ALLOWED');
    });
    it('when the head SHA differs but the state claims it matches then still blocks', () => {
      assert.equal(decide(1, github({ pullRequest: { headSha: old, testedShaMatches: true } })).decision, 'BLOCKED');
    });
    it('when Harness checks failed then GitHub approvals cannot allow merge', () => {
      const failed = checks.map(c => c.id === 'verification' ? { ...c, status: 'FAIL' } : c);
      assert.equal(decide(2, github({ reviews: { approvedHumans: ['alice'] } }), { checks: failed }).decision, 'BLOCKED');
    });
  });
});

// Issue #91: the PR of a Schema SBI is traceable from its body alone: PBI, SBI, contract diff and what Prism did and did not call.
describe('Pull request body of a Schema SBI', () => {
  const sbi = { id: 'ISSUE-6', title: 'SBI-001 OpenAPI Schemaを作る', description: 'コース一覧APIの契約を定義する。', acceptanceCriteria: [{ id: 'AC-1', description: 'コース一覧の契約がある' }],
    issueUrl: 'https://github.com/acme/app/issues/6', pbiUrl: 'https://github.com/acme/app/issues/3' };
  const contract = { id: 'api-contract', status: 'PASS', processes: [
    { ok: true, stdout: 'CHANGE 追加: paths./api/v1/courses\nCHANGE 説明を変更: info.description\nAPI contract (base HEAD): PASS\n', stderr: '' },
    { ok: true, stdout: 'Prism Mock: PASS GET /api/v1/courses 200\nPrism Mock: SKIP GET /api/v1/me（security要件があり、Verifierは認証headerを送らないため）\nPrism Mock: SKIP POST /api/v1/courses（GET以外はPrismへrequestしていません）\nPrism Mock check: PASS\n', stderr: '' }] };
  const summary = (checks = [contract]) => ({ id: 'run-1', headSha: 'a'.repeat(40), runDir: '.harness/runs/run-1', sbiIssue: { repo: 'acme/app', number: 6, url: sbi.issueUrl },
    iterations: [{ verification: { status: 'PASS', checks }, security: { status: 'PASS' }, securityVerification: { status: 'PASS' } }], risk: { level: 2, reasons: [] }, merge: { requiredApprovals: 1 } });
  const section = (body, heading) => body.split(/^## /m).find(part => part.startsWith(heading)) ?? '';
  it('when the body is written then it links the PBI and the Schema SBI Issue', () => {
    const body = pullRequestBody({ summary: summary(), sbi });
    assert.ok(body.includes('元PBI: https://github.com/acme/app/issues/3'));
    assert.ok(body.includes('Issue: https://github.com/acme/app/issues/6'));
  });
  it('when the api-contract Verifier ran then the body lists the breaking and non-breaking contract diff item by item', () => {
    const api = section(pullRequestBody({ summary: summary(), sbi }), 'API Schema');
    assert.match(api, /breaking: なし/);
    assert.ok(api.includes('追加: paths./api/v1/courses') && api.includes('説明を変更: info.description'));
  });
  it('when Prism was run then the body lists the endpoints it called and those it did not call with the reason', () => {
    const api = section(pullRequestBody({ summary: summary(), sbi }), 'API Schema');
    assert.ok(api.includes('GET /api/v1/courses 200'));
    assert.ok(api.includes('GET /api/v1/me（security要件があり、Verifierは認証headerを送らないため）'));
    assert.ok(api.includes('POST /api/v1/courses（GET以外はPrismへrequestしていません）'));
  });
  it('when the api-contract Verifier did not run for the SBI then the body has no API Schema section', () => {
    assert.equal(section(pullRequestBody({ summary: summary([{ id: 'admin', status: 'PASS', processes: [] }]), sbi }), 'API Schema'), '');
  });
});

describe('GitHub PR Adapter', () => {
  describe('given a completed level 2 run whose baseline is on origin/main', () => {
    it('when harness:pr runs then pushes exactly the tested SHA and opens a PR whose head is that SHA', () => fixture(root => withIssue(root, sbiIssue(), async ({ bare, github }) => {
      const run = await issueRun(root);
      assert.equal(run.status, 'WAITING_FOR_HUMAN_REVIEW');
      const result = await openPullRequest({ root, runId: run.id, quiet: true });
      assert.equal(await remoteSha(bare, `harness/${run.id}`), run.headSha);
      const [pull] = (await github.state()).pulls;
      assert.equal(pull.head.sha, run.headSha);
      assert.equal(pull.base.ref, 'main');
      assert.deepEqual(result.pullRequest, { number: pull.number, url: pull.html_url, branch: `harness/${run.id}`, base: 'main', repository: 'acme/app' });
      for (const text of [run.id, run.headSha, run.sbi, 'LEVEL 2', '1人']) assert.ok(pull.body.includes(text), `PR body includes ${text}`);
      for (const criterion of planned().acceptanceCriteria) assert.ok(pull.body.includes(criterion.id));
    })));
    it('when CI has not reported yet then the merge decision is blocked on CI, not allowed', () => fixture(root => withIssue(root, sbiIssue(), async () => {
      const run = await issueRun(root);
      const result = await openPullRequest({ root, runId: run.id, quiet: true });
      assert.equal(result.status, 'BLOCKED');
      assert.ok(result.merge.reasons.includes('required_ci_not_passed'));
    })));
    it('when CI passes and a human approves the head SHA then resume reaches MERGE_ALLOWED and records the GitHub state', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await issueRun(root);
      const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
      await succeed(github, run.headSha);
      await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', run.headSha);
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'MERGE_ALLOWED');
      assert.deepEqual(resumed.merge.validReviewers, ['github:alice']);
      const evidence = await readJson(join(root, run.runDir, 'github-state.json'));
      assert.deepEqual(evidence.pullRequest.testedShaMatches, true);
      assert.deepEqual(evidence.reviews.approvedHumans, ['alice']);
      assert.equal(evidence.ci.status, 'PASS');
      assert.equal(resumed.events.some(e => e.status === 'MERGED'), false);
    })));
    it('when the run was reviewed by the fake AI Review of the demo then the PR never reaches MERGE_ALLOWED even with CI and a human approval', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await issueRun(root, { semanticReviewer: undefined });
      assert.equal(run.iterations.at(-1).semanticReview.adapter, 'fake');
      const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
      await succeed(github, run.headSha);
      await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', run.headSha);
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'BLOCKED');
      assert.ok(resumed.merge.reasons.includes('ai_review_not_passed'));
      assert.equal(resumed.merge.autoMergeEligible, false);
    })));
    it('when a commit is pushed to the PR after verification then resume blocks even though it was approved', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await issueRun(root);
      const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
      const pushed = 'c'.repeat(40);
      await github.update(s => { s.pulls[0].head.sha = pushed; });
      await succeed(github, pushed);
      await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', pushed);
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'BLOCKED');
      assert.ok(resumed.merge.reasons.includes('tested_sha_mismatch'));
    })));
    it('when a reviewer requests changes then resume rejects the merge', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await issueRun(root);
      const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
      await succeed(github, run.headSha);
      await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', run.headSha);
      await reviewBy(github, pullRequest.number, 'bob', 'CHANGES_REQUESTED', run.headSha);
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'REJECTED');
    })));
    it('when only the PR author approves then it is not a human approval', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await issueRun(root);
      const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
      await succeed(github, run.headSha);
      await reviewBy(github, pullRequest.number, 'harness-operator', 'APPROVED', run.headSha);
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'WAITING_FOR_HUMAN_REVIEW');
    })));
  });
});
