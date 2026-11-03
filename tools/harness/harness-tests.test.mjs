import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selectHarnessTests } from './harness-tests.mjs';

// #288: pre-push runs only the Harness tests that name a changed Harness module; what it cannot narrow is left to CI, never run in full.
const config = { impact: { fullGate: ['^tools/harness/', '^\\.harness/(config|verification|rules|skills)/', '^\\.github/', '^\\.githooks/', '^AGENTS\\.md$'], toolchain: ['^\\.node-version$', '^package\\.json$'] } };
const sources = {
  'package.json': JSON.stringify({ scripts: { 'harness:test': 'node --test --test-concurrency=3 tools/harness/*.test.mjs tools/harness/agents/*.test.mjs .harness/verification/*.test.mjs .harness/verification/lib/*.test.mjs' } }),
  'tools/harness/io.mjs': 'export const io = 1;\n',
  'tools/harness/verifier.mjs': "import { io } from './io.mjs';\n",
  'tools/harness/unused.mjs': 'export {};\n',
  'tools/harness/test-fixture.mjs': "import './verifier.mjs';\n",
  'tools/harness/io.test.mjs': "import { io } from './io.mjs';\n",
  'tools/harness/verifier.test.mjs': "import { fixture } from './test-fixture.mjs';\nimport { verify } from './verifier.mjs';\n",
  'tools/harness/cli.test.mjs': "const cli = join(root, 'tools/harness/cli.mjs');\n",
  'tools/harness/cli.mjs': 'export {};\n',
  'tools/harness/agents/provider.mjs': 'export {};\n',
  'tools/harness/agents/provider.test.mjs': "import '../io.mjs';\nimport './provider.mjs';\n",
  '.harness/verification/lib/assert.mjs': 'export {};\n',
  '.harness/verification/lib/assert.test.mjs': "import './assert.mjs';\n",
};
async function repository(fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sonomama-harness-tests-')));
  try {
    for (const [path, text] of Object.entries(sources)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); }
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const select = (root, ...paths) => selectHarnessTests({ root, config, files: paths.map(path => ({ path })) });

describe('Harness test selection', () => {
  describe('given a changed Harness module', () => {
    it('when tests import it then selects only those tests, in every test directory of harness:test', () => repository(async root => {
      assert.deepEqual(await select(root, 'tools/harness/io.mjs'), { all: false, tests: ['tools/harness/agents/provider.test.mjs', 'tools/harness/io.test.mjs'], reasons: [] });
    }));
    it('when a test reaches it only through another module then does not select that test', () => repository(async root => {
      assert.deepEqual((await select(root, 'tools/harness/test-fixture.mjs')).tests, ['tools/harness/verifier.test.mjs']);
      assert.deepEqual((await select(root, 'tools/harness/io.mjs')).tests.includes('tools/harness/verifier.test.mjs'), false);
    }));
    it('when a test names it as a path it runs instead of importing it then selects that test', () => repository(async root => {
      assert.deepEqual((await select(root, 'tools/harness/cli.mjs')).tests, ['tools/harness/cli.test.mjs']);
    }));
    it('when the module of the Trusted Acceptance library changes then selects its tests', () => repository(async root => {
      assert.deepEqual((await select(root, '.harness/verification/lib/assert.mjs')).tests, ['.harness/verification/lib/assert.test.mjs']);
    }));
    it('when no test names it then selects no test', () => repository(async root => {
      assert.deepEqual(await select(root, 'tools/harness/unused.mjs'), { all: false, tests: [], reasons: [] });
    }));
  });
  describe('given a changed Harness test', () => {
    it('when the test exists then selects it', () => repository(async root => {
      assert.deepEqual((await select(root, 'tools/harness/agents/provider.test.mjs')).tests, ['tools/harness/agents/provider.test.mjs']);
    }));
    it('when the test was deleted then selects nothing for it', () => repository(async root => {
      assert.deepEqual((await select(root, 'tools/harness/removed.test.mjs')).tests, []);
    }));
  });
  describe('given a change no import can scope', () => {
    for (const path of ['.harness/config/harness.json', '.harness/rules/pr-risk.json', '.github/workflows/harness.yml', '.githooks/pre-push', 'AGENTS.md', 'tools/harness/maestro-ci.sh', 'tools/harness/fixtures/sbi.json']) {
      it(`when ${path} changes then asks for every Harness test with the path as the reason`, () => repository(async root => {
        assert.deepEqual(await select(root, 'tools/harness/io.mjs', path), { all: true, tests: [], reasons: [`diff:${path}`] });
      }));
    }
    it('when the toolchain changes then asks for every Harness test', () => repository(async root => {
      assert.deepEqual(await select(root, '.node-version'), { all: true, tests: [], reasons: ['toolchain:.node-version'] });
    }));
  });
  describe('given a change outside the Harness', () => {
    it('when only applications and documents change then selects no Harness test', () => repository(async root => {
      assert.deepEqual(await select(root, 'apps/admin/src/main.ts', 'docs/architecture/README.md'), { all: false, tests: [], reasons: [] });
    }));
  });
});
