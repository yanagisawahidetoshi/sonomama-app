import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, update, runFixture as runHarness } from './test-fixture.mjs';
import { configSchema, providerTimeoutMs } from './schemas.mjs';
// A provider (Claude / Codex) reads, decides and writes several files, so it gets a longer limit than a verifier.
// The verifiers and the Trusted Acceptance scripts keep timeoutMs; only the provider calls read providerTimeoutMs.
const good = 'export function greet(name) { return `こんにちは、${name?.trim() || "ゲスト"}さん`; }';
const limits = async root => update(root, '.harness/config/harness.json', c => { c.timeoutMs = 120000; c.providerTimeoutMs = 600000; });

describe('Provider and verifier time limits', () => {
  it('given the repository configuration when it is read then providers get 10 minutes and verifiers keep 2 minutes', async () => {
    const config = configSchema.parse(JSON.parse(await readFile(new URL('../../.harness/config/harness.json', import.meta.url), 'utf8')));
    assert.equal(config.providerTimeoutMs, 600000);
    assert.equal(config.timeoutMs, 120000);
  });
  it('given a configuration without providerTimeoutMs when the provider limit is read then it falls back to timeoutMs', () => {
    assert.equal(providerTimeoutMs({ timeoutMs: 120000 }), 120000);
    assert.equal(providerTimeoutMs({ timeoutMs: 120000, providerTimeoutMs: 600000 }), 600000);
  });
  it('given a provider limit longer than 30 minutes when the configuration is read then it is rejected', () => {
    assert.equal(configSchema.shape.providerTimeoutMs.safeParse(1800001).success, false);
  });
  it('given separate limits when a run implements and reviews the SBI then the implementation agent and AI Review get the provider limit', () => fixture(async root => {
    await limits(root);
    const seen = { agent: [], review: [] };
    const run = await runHarness({ root, quiet: true, provider: 'codex',
      agent: async ({ timeoutMs }) => { seen.agent.push(timeoutMs); return { files: [{ path: 'greeting.mjs', content: good }] }; },
      semanticReviewer: async ({ headSha, timeoutMs }) => { seen.review.push(timeoutMs); return { adapter: 'test-adapter', headSha, status: 'PASS', reasons: [] }; } });
    assert.equal(run.executionStatus, 'DONE');
    assert.deepEqual(seen.agent, [600000]);
    assert.deepEqual(seen.review, [600000]);
  }));
});
