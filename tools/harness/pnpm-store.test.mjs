import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runIsolated, containerEnv } from './isolation.mjs';
import { configSchema } from './schemas.mjs';
import { execute } from './io.mjs';

// #272: container verifiers install from one pnpm store shared across runs. Only a trusted fetch, which runs no package
// or workspace code, writes to it; the untrusted verifier container sees it read-only and installs offline.
const token = 'ghp_' + 'x'.repeat(36);
const credentials = { GH_TOKEN: token, ANTHROPIC_API_KEY: 'anthropic-secret-value' };
const lockfile = `lockfileVersion: '6.0'

packages:

  /left-pad@1.3.0:
    resolution: {integrity: sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQ9+6jNy+vbMsuGtJ6Ifp2VqYuoNkb2KsZGWx8oYxVkqCDCw==}
    dev: false
`;
const install = ['pnpm', 'install', '--frozen-lockfile', '--offline'];
const verifier = (patch = {}) => ({ id: 'web', directory: '.', isolation: 'container', network: false, dependencyStore: 'pnpm', setupCommands: [install], commands: [['node', '-e', 'process.exit(0)']], ...patch });

async function workspace(fn, { lock = lockfile } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'harness-pnpm-store-'));
  try {
    if (lock !== null) await writeFile(join(root, 'pnpm-lock.yaml'), lock);
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    await writeFile(join(root, '.npmrc'), 'registry=https://registry.attacker.test/\n');
    await writeFile(join(root, '.pnpmfile.cjs'), 'process.exit(9)');
    return await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
// A docker CLI stand-in that records every invocation; fetch decides how the trusted fetch container ends.
async function fakeDocker(test, { fetch = 'ok' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'harness-fake-docker-'));
  try {
    const docker = join(dir, 'docker'), log = join(dir, 'calls.jsonl');
    await writeFile(docker, `#!${process.execPath}
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env: process.env }) + '\\n');
if (args[0] === 'run' && args.some(a => /\\bpnpm fetch\\b/.test(a))) {
  if (${JSON.stringify(fetch)} === 'fail') process.exit(1);
  if (${JSON.stringify(fetch)} === 'hang') setTimeout(() => {}, 60000);
}
if (args[0] === 'run' && args.includes('infinity')) console.log('container-id');
`);
    await chmod(docker, 0o755);
    const calls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    return await test({ docker, calls });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function withCredentials(test) {
  const previous = Object.fromEntries(Object.keys(credentials).map(k => [k, process.env[k]]));
  Object.assign(process.env, credentials);
  try { return await test(); } finally {
    for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
const verify = (root, docker, adapter = verifier(), settings = {}) => runIsolated({ workspace: root, cwd: root, adapter, config: { timeoutMs: 5000, setupTimeoutMs: 5000, isolation: { docker }, ...settings } });
const mounts = call => call.args.flatMap((a, i) => call.args[i - 1] === '--mount' ? [Object.fromEntries(a.split(',').map(kv => kv.split('=')))] : []);
const envNames = call => call.args.flatMap((a, i) => call.args[i - 1] === '-e' ? [a.split('=')[0]] : []);
// pnpm fetch rewrites the lockfile beside it, so the fetch copies its read-only inputs first and the command is a shell line.
const fetchRun = calls => calls.find(c => c.args[0] === 'run' && c.args.some(a => /\bpnpm fetch\b/.test(a)));
const verifierRun = calls => calls.find(c => c.args[0] === 'run' && c.args.includes('infinity'));
const installExec = calls => calls.find(c => c.args[0] === 'exec' && c.args.includes('install'));
const storeMount = call => mounts(call).find(m => m.dst === '/pnpm-store');

describe('Shared pnpm store for container verifiers', () => {
  describe('given a container verifier that installs from the shared pnpm store', () => {
    it('when verifying then a trusted container fetches the lockfile packages into the shared store before the install runs', () => workspace(root => fakeDocker(async ({ docker, calls }) => {
      const result = await verify(root, docker);
      assert.equal(result.status, 'PASS', JSON.stringify(result));
      const all = await calls();
      const fetched = fetchRun(all);
      assert.ok(fetched, 'the store is filled by a fetch container');
      assert.ok(all.indexOf(fetched) < all.indexOf(installExec(all)), 'the fetch finishes before the install');
      const args = fetched.args.join(' ');
      assert.match(args, /pnpm fetch/);
      assert.match(args, /--ignore-pnpmfile/);
      assert.match(args, /--ignore-scripts/);
      assert.match(args, /--cap-drop ALL/);
      assert.match(args, /--security-opt no-new-privileges/);
      assert.match(args, /--read-only/);
      assert.match(args, new RegExp(`--user ${process.getuid()}:${process.getgid()}`));
      const store = storeMount(fetched);
      assert.equal(store.type, 'volume');
      assert.ok(store.src, 'the shared store is a named volume');
      assert.ok(!('readonly' in store), 'only the trusted fetch writes to the store');
      const fetchedPhase = result.processes.find(p => p.phase === 'setup');
      assert.ok(fetchedPhase, 'the fetch is a setup process in the evidence');
    })));
    it('when verifying then the fetch sees only the lockfile and workspace list, never the workspace, .npmrc or .pnpmfile.cjs', () => workspace(root => fakeDocker(async ({ docker, calls }) => {
      await verify(root, docker);
      const fetched = fetchRun(await calls());
      const binds = mounts(fetched).filter(m => m.type === 'bind');
      assert.ok(binds.every(m => m.src !== root && !m.src.startsWith(`${root}/`)), 'the workspace is not mounted into the fetch');
      assert.ok(binds.every(m => 'readonly' in m), 'the fetch inputs are read-only');
      const inputs = binds.map(m => m.src);
      assert.equal(inputs.length, 1);
      assert.equal(await readFile(join(inputs[0], 'pnpm-lock.yaml'), 'utf8').catch(() => 'removed after the fetch'), 'removed after the fetch');
    })));
    it('when verifying then the verifier container mounts the same store read-only and no per-run store', () => workspace(root => fakeDocker(async ({ docker, calls }) => {
      await verify(root, docker);
      const all = await calls();
      const store = storeMount(verifierRun(all));
      assert.equal(store.src, storeMount(fetchRun(all)).src);
      assert.ok('readonly' in store, 'the untrusted verifier cannot write to the shared store');
      const chown = all.find(c => c.args[0] === 'exec' && c.args.includes('chown'));
      assert.ok(!chown.args.includes('/pnpm-store'), 'the verifier never takes ownership of the shared store');
    })));
    it('when credentials exist in the Harness environment then the fetch container receives only the container environment', () => workspace(root => fakeDocker(async ({ docker, calls }) => withCredentials(async () => {
      await verify(root, docker);
      const fetched = fetchRun(await calls());
      for (const value of Object.values(credentials)) assert.ok(!fetched.args.join(' ').includes(value));
      for (const name of Object.keys(credentials)) assert.equal(fetched.env[name], undefined);
      const names = envNames(fetched);
      assert.ok(names.length > 0);
      assert.ok(names.every(n => Object.keys(containerEnv).includes(n)), names.join(','));
    }))));
    it('when the fetch exits non-zero then FAILs as SETUP_FAILED and neither the install nor the verification runs', () => workspace(root => fakeDocker(async ({ docker, calls }) => {
      const result = await verify(root, docker);
      assert.equal(result.status, 'FAIL');
      assert.equal(result.failure, 'SETUP_FAILED');
      assert.equal(result.phases.verify.skipped, true);
      assert.equal(installExec(await calls()), undefined);
    }, { fetch: 'fail' })));
    it('when the fetch exceeds the setup limit then FAILs as SETUP_TIMEOUT', () => workspace(root => fakeDocker(async ({ docker, calls }) => {
      const result = await verify(root, docker, verifier({ setupTimeoutMs: 300 }));
      assert.equal(result.status, 'FAIL');
      assert.equal(result.failure, 'SETUP_TIMEOUT');
      assert.equal(installExec(await calls()), undefined);
    }, { fetch: 'hang' })));
    it('when the workspace has no pnpm-lock.yaml then FAILs as SETUP_FAILED without fetching', () => workspace(root => fakeDocker(async ({ docker, calls }) => {
      const result = await verify(root, docker);
      assert.equal(result.failure, 'SETUP_FAILED');
      assert.equal(fetchRun(await calls()), undefined);
      assert.equal(installExec(await calls()), undefined);
    }), { lock: null }));
    it('when a lockfile package has no integrity hash then FAILs as SETUP_FAILED without fetching', () => workspace(root => fakeDocker(async ({ docker, calls }) => {
      const result = await verify(root, docker);
      assert.equal(result.failure, 'SETUP_FAILED');
      assert.match(JSON.stringify(result.processes), /integrity/);
      assert.equal(fetchRun(await calls()), undefined);
    }), { lock: lockfile.replace(/\{integrity: [^}]+\}/, '{tarball: https://registry.attacker.test/left-pad.tgz}') }));
  });
  describe('given a container verifier without the shared store', () => {
    it('when verifying then it keeps a store of its own for the run and fetches nothing', () => workspace(root => fakeDocker(async ({ docker, calls }) => {
      await verify(root, docker, verifier({ dependencyStore: undefined, setupCommands: [['pnpm', 'install', '--frozen-lockfile', '--prefer-offline']] }));
      const all = await calls();
      assert.equal(fetchRun(all), undefined);
      const store = storeMount(verifierRun(all));
      assert.equal(store.src, undefined, 'an anonymous volume');
    })));
  });
  describe('given the verifier configuration', () => {
    const base = async () => JSON.parse(await readFile(new URL('../../.harness/config/harness.json', import.meta.url), 'utf8'));
    it('when a container verifier installs with pnpm then it uses the shared store and installs offline', async () => {
      const config = configSchema.parse(await base());
      const installers = [...config.verifiers, ...config.securityVerifiers].filter(v => v.setupCommands.some(c => c[0] === 'pnpm' && c[1] === 'install'));
      assert.ok(installers.length >= 6, installers.map(v => v.id).join(','));
      for (const v of installers) {
        assert.equal(v.isolation, 'container', v.id);
        assert.equal(v.dependencyStore, 'pnpm', v.id);
        for (const command of v.setupCommands.filter(c => c[1] === 'install')) {
          assert.ok(command.includes('--offline'), `${v.id} installs offline`);
          assert.ok(command.includes('--frozen-lockfile'), `${v.id} keeps the lockfile`);
          assert.ok(!command.includes('--prefer-offline'), `${v.id} never falls back to the network`);
        }
      }
    });
    it('when the shared store is set on a verifier that is not a container then rejects the configuration', async () => {
      const config = await base();
      Object.assign(config.verifiers.find(v => v.id === 'api-contract'), { dependencyStore: 'pnpm' });
      assert.throws(() => configSchema.parse(config));
    });
  });
});

describe('Shared pnpm store with a real Docker daemon', () => {
  describe('given a malicious application test in a verifier that uses the shared store', () => {
    it('when it writes to the shared store then the write is refused', () => workspace(async root => {
      const probe = "try { require('node:fs').writeFileSync('/pnpm-store/poisoned', 'x'); console.log('PROBE written'); } catch (e) { console.log('PROBE ' + e.code); }";
      const result = await runIsolated({ workspace: root, cwd: root, adapter: verifier({ setupCommands: [], commands: [['node', '-e', probe]] }), config: { timeoutMs: 120000, setupTimeoutMs: 300000 } });
      if (!(await execute('docker', ['info'], { timeoutMs: 30000 })).ok) {
        assert.equal(result.status, 'FAIL');
        return;
      }
      assert.equal(result.status, 'PASS', JSON.stringify(result.processes?.map(p => p.stderr)));
      assert.match(result.processes.map(p => p.stdout).join(''), /PROBE EROFS/);
    }, { lock: "lockfileVersion: '6.0'\n" }));
  });
});
