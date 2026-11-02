import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './test-fixture.mjs';
import { git } from './workspace.mjs';

// #197: fixtures are copied from a template made once per test process; each one must still be a fresh, independent repository.
describe('Test fixture repository', () => {
  it('when a fixture is made then it is a clean Git repository on main with the fixture inputs committed', () => fixture(async root => {
    assert.equal((await git(root, ['status', '--porcelain', '--untracked-files=all'])).stdout, '');
    assert.equal((await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'main');
    assert.equal((await git(root, ['log', '--format=%s'])).stdout.trim(), 'Fixture inputs');
    assert.ok((await readFile(join(root, '.harness/config/harness.json'), 'utf8')).length > 0);
    assert.equal((await git(root, ['ls-files', '.harness/runs'])).stdout, '');
  }));
  it('when one fixture is changed and committed then the next fixture does not see the change', async () => {
    await fixture(async root => {
      await writeFile(join(root, 'AGENTS.md'), 'changed\n');
      await git(root, ['commit', '-am', 'change']);
    });
    await fixture(async root => {
      assert.notEqual(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'changed\n');
      assert.equal((await git(root, ['log', '--format=%s'])).stdout.trim(), 'Fixture inputs');
    });
  });
  it('when two fixtures are open at once then each is its own directory and repository', () => fixture(a => fixture(async b => {
    assert.notEqual(a, b);
    await writeFile(join(a, 'only-a.txt'), 'a\n');
    assert.equal((await git(b, ['status', '--porcelain', '--untracked-files=all'])).stdout, '');
    assert.equal((await git(a, ['rev-parse', '--git-dir'])).stdout.trim(), '.git');
  })));
  // #268: a killed test process never reaches its finally; the next test process removes what the killed one left behind.
  it('when a test process is killed while its fixture is open then the next test process removes that fixture', async () => {
    const module = JSON.stringify(new URL('./test-fixture.mjs', import.meta.url).href);
    const node = script => spawn(process.execPath, ['--input-type=module', '-e', `import { fixture } from ${module};${script}`], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exit = child => new Promise(resolve => child.once('exit', resolve));
    const killed = node('await fixture(async root => { console.log(root); await new Promise(() => {}); });');
    const root = await new Promise((resolve, reject) => {
      killed.stdout.once('data', chunk => resolve(chunk.toString().trim()));
      killed.once('exit', code => reject(new Error(`fixture process exited early: ${code}`)));
    });
    assert.equal(existsSync(join(root, '.git')), true);
    killed.kill('SIGKILL');
    await exit(killed);
    assert.equal(existsSync(root), true);
    assert.equal(await exit(node('await fixture(async () => {});')), 0);
    assert.equal(existsSync(root), false);
  });
});
