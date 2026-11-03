import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verify } from './verifier.mjs';

// #295: the Completion Judge runs a Trusted Acceptance of main against a PR tree that has no installed dependencies (ADR-0008).
// A bare import of the code under test resolves from the trusted installation only: never from the PR tree, never by fallback.
const pkg = async (dir, name, value) => {
  await mkdir(join(dir, 'node_modules', name), { recursive: true });
  await writeFile(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.mjs' }));
  await writeFile(join(dir, 'node_modules', name, 'index.mjs'), `export const source = ${JSON.stringify(value)};\n`);
};
async function trees(fn) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'sonomama-trusted-deps-')));
  const root = join(temp, 'trusted'), workspace = join(temp, 'pr');
  try {
    await mkdir(join(root, '.harness/verification'), { recursive: true });
    await mkdir(join(workspace, 'tools'), { recursive: true });
    // The code under test in the PR tree imports a package by name, as tools/harness/schemas.mjs imports zod.
    await writeFile(join(workspace, 'tools/under-test.mjs'), "export { source } from 'harness-dep';\n");
    await writeFile(join(root, '.harness/verification/check.mjs'), [
      "import { join } from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      "const { source } = await import(pathToFileURL(join(process.argv[2], 'tools/under-test.mjs')).href);",
      "if (source !== 'trusted') throw new Error(`resolved from ${source}`);",
      "console.log(JSON.stringify({ acceptance: ['AC-1'] }));",
    ].join('\n'));
    await fn({ root, workspace });
  } finally { await rm(temp, { recursive: true, force: true }); }
}
const judge = ({ root, workspace }) => verify({ root, workspace, sbi: { id: 'SBI-T', acceptanceCriteria: [{ id: 'AC-1', verifier: 'trusted-check' }], requiredVerifiers: [] }, files: [],
  config: { timeoutMs: 10000, verifiers: [{ id: 'trusted-check', trust: 'acceptance', trustedScript: '.harness/verification/check.mjs', acceptanceIds: ['AC-1'] }], securityVerifiers: [] } });
const status = result => result.checks.find(c => c.id === 'trusted-check')?.status;

describe('Dependencies of a Trusted Acceptance run against a PR tree', () => {
  describe('given a PR tree without node_modules and a trusted installation that has the package', () => {
    it('when the Trusted Acceptance imports the code under test then its bare import resolves from the trusted installation', () => trees(async t => {
      await pkg(t.root, 'harness-dep', 'trusted');
      assert.equal(status(await judge(t)), 'PASS');
    }));
  });
  describe('given a PR tree that ships its own copy of the package', () => {
    it('when both have the package then the trusted installation wins and the PR copy is never loaded', () => trees(async t => {
      await pkg(t.root, 'harness-dep', 'trusted');
      await pkg(t.workspace, 'harness-dep', 'pr');
      assert.equal(status(await judge(t)), 'PASS');
    }));
    it('when only the PR tree has the package then the run fails instead of falling back to the PR copy', () => trees(async t => {
      await mkdir(join(t.root, 'node_modules'), { recursive: true });
      await pkg(t.workspace, 'harness-dep', 'pr');
      assert.equal(status(await judge(t)), 'FAIL');
    }));
  });
});
