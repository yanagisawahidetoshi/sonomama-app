import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selectHarnessTests } from './harness-tests.mjs';
import { configSchema } from './schemas.mjs';

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
async function repository(fn, extra = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sonomama-harness-tests-')));
  try {
    for (const [path, text] of Object.entries({ ...sources, ...extra })) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); }
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

// #300: an integration test runs whole Harness flows, so it is chosen by the modules it is responsible for, never by what it imports.
// pre-push runs no integration test; CI runs the ones whose test or owner changed; a push to main runs every test.
describe('Harness test selection by stage', () => {
  const staged = { ...config, harnessTests: { integration: { 'tools/harness/flow.test.mjs': ['tools/harness/flow.mjs'] } } };
  const flow = { 'tools/harness/flow.mjs': "import './io.mjs';\n", 'tools/harness/flow.test.mjs': "import './io.mjs';\nimport './flow.mjs';\nimport './verifier.mjs';\n" };
  const selectIn = (stage, root, ...paths) => selectHarnessTests({ root, config: staged, files: paths.map(path => ({ path })), stage });
  describe('given an integration test declared with the module it owns', () => {
    it('when a shared module it only imports changes then CI selects the unit tests naming that module but not the integration test', () => repository(async root => {
      assert.deepEqual((await selectIn('ci', root, 'tools/harness/io.mjs')).tests, ['tools/harness/agents/provider.test.mjs', 'tools/harness/io.test.mjs']);
    }, flow));
    it('when another module it imports changes then CI does not select it', () => repository(async root => {
      assert.deepEqual((await selectIn('ci', root, 'tools/harness/verifier.mjs')).tests, ['tools/harness/verifier.test.mjs']);
    }, flow));
    it('when its owner module changes then CI selects it', () => repository(async root => {
      assert.deepEqual((await selectIn('ci', root, 'tools/harness/flow.mjs')).tests, ['tools/harness/flow.test.mjs']);
    }, flow));
    it('when the integration test itself changes then CI selects it', () => repository(async root => {
      assert.deepEqual((await selectIn('ci', root, 'tools/harness/flow.test.mjs')).tests, ['tools/harness/flow.test.mjs']);
    }, flow));
    it('when no stage is given then it is selected as CI selects it', () => repository(async root => {
      assert.deepEqual((await selectHarnessTests({ root, config: staged, files: [{ path: 'tools/harness/flow.mjs' }] })).tests, ['tools/harness/flow.test.mjs']);
    }, flow));
    it('when its owner module changes before push then pre-push leaves it to CI', () => repository(async root => {
      assert.deepEqual(await selectIn('pre-push', root, 'tools/harness/flow.mjs'), { all: false, tests: [], reasons: [] });
    }, flow));
    it('when the integration test itself changes before push then pre-push leaves it to CI', () => repository(async root => {
      assert.deepEqual((await selectIn('pre-push', root, 'tools/harness/flow.test.mjs', 'tools/harness/io.mjs')).tests, ['tools/harness/agents/provider.test.mjs', 'tools/harness/io.test.mjs']);
    }, flow));
  });
  describe('given a declaration that no longer matches the tree', () => {
    it('when a declared integration test does not exist then selection fails naming it, so its owners are never silently untested', () => repository(async root => {
      const stale = { ...config, harnessTests: { integration: { 'tools/harness/gone.test.mjs': ['tools/harness/io.mjs'] } } };
      await assert.rejects(selectHarnessTests({ root, config: stale, files: [{ path: 'tools/harness/io.mjs' }] }), /tools\/harness\/gone\.test\.mjs/);
    }));
    it('when a declared owner module does not exist then selection fails naming it', () => repository(async root => {
      const stale = { ...config, harnessTests: { integration: { 'tools/harness/flow.test.mjs': ['tools/harness/renamed.mjs'] } } };
      await assert.rejects(selectHarnessTests({ root, config: stale, files: [{ path: 'tools/harness/io.mjs' }], stage: 'pre-push' }), /tools\/harness\/renamed\.mjs/);
    }, flow));
  });
  describe('given the repository configuration', () => {
    it('when its integration tests are read then every declared test and owner exists and each test runs a whole Harness flow', async () => {
      const root = new URL('../../', import.meta.url).pathname;
      const repo = configSchema.parse(JSON.parse(await readFile(join(root, '.harness/config/harness.json'), 'utf8')));
      const declared = Object.entries(repo.harnessTests.integration);
      assert.ok(declared.length > 0);
      await selectHarnessTests({ root, config: repo, files: [{ path: 'tools/harness/io.mjs' }] });
      for (const [test] of declared) assert.match(await readFile(join(root, test), 'utf8'), /test-fixture\.mjs/, `${test} uses no Harness fixture`);
    });
  });
});
