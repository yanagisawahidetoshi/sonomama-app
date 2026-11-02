import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, infrastructureFailure, prepareImage } from './test-fixture.mjs';
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
});

// #261: a setup step that fails because of the machine or the network is reported as an infrastructure failure with its cause,
// so it is not read as a failure of the code under test.
describe('Infrastructure failures of the test setup', () => {
  const result = overrides => ({ ok: false, code: 1, signal: null, timedOut: false, error: null, stderr: '', durationMs: 10, ...overrides });
  it('when a setup command runs out of its time limit then the failure says infrastructure and the time it ran, not null', () => {
    assert.equal(infrastructureFailure('fixture copy', result({ code: null, signal: 'SIGKILL', timedOut: true, durationMs: 120004 })).message,
      '[infrastructure] fixture copy: timed out after 120004ms');
  });
  it('when a setup command fails with output then the failure says infrastructure and keeps the output', () => {
    assert.equal(infrastructureFailure('docker pull node', result({ stderr: 'TLS handshake timeout\n' })).message, '[infrastructure] docker pull node: TLS handshake timeout');
  });
  it('when a setup command fails without output then the failure names its exit', () => {
    assert.equal(infrastructureFailure('fixture copy', result({ code: 2 })).message, '[infrastructure] fixture copy: exit 2');
    assert.equal(infrastructureFailure('fixture copy', result({ code: null, error: 'spawn cp ENOENT' })).message, '[infrastructure] fixture copy: spawn cp ENOENT');
  });
});

describe('Docker base images prepared before the tests that build on them', () => {
  const docker = outcomes => {
    const calls = [];
    return { calls, run: async (command, args) => { calls.push(args.join(' ')); const next = outcomes[args[0]]; return { ok: false, code: 1, stderr: '', ...(typeof next === 'function' ? next() : next) }; } };
  };
  it('when the image is already local then nothing is pulled', async () => {
    const fake = docker({ info: { ok: true }, image: { ok: true } });
    await prepareImage('node:22', { run: fake.run, waitMs: 0 });
    assert.deepEqual(fake.calls, ['info', 'image inspect node:22']);
  });
  it('when a pull fails and a later attempt succeeds then the image is ready', async () => {
    let pulls = 0;
    const fake = docker({ info: { ok: true }, image: { ok: false }, pull: () => (++pulls < 3 ? { stderr: 'connection reset by peer' } : { ok: true }) });
    await prepareImage('node:22', { run: fake.run, waitMs: 0 });
    assert.equal(fake.calls.filter(c => c === 'pull node:22').length, 3);
  });
  it('when every pull fails then it stops as an infrastructure failure with the last cause', async () => {
    const fake = docker({ info: { ok: true }, image: { ok: false }, pull: { stderr: 'TLS handshake timeout' } });
    await assert.rejects(prepareImage('node:22', { run: fake.run, waitMs: 0 }), { message: '[infrastructure] docker pull node:22: TLS handshake timeout' });
    assert.equal(fake.calls.filter(c => c === 'pull node:22').length, 3);
  });
  it('when there is no Docker daemon then nothing is pulled and the tests decide what that means', async () => {
    const fake = docker({ info: { ok: false } });
    await prepareImage('node:22', { run: fake.run, waitMs: 0 });
    assert.deepEqual(fake.calls, ['info']);
  });
});
