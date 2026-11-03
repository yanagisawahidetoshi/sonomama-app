import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from './io.mjs';
// #277: a provider that starts a helper in its own session keeps stdout open after the provider is killed, so waiting for 'close' never ends.
// The child writes the helper's pid to a file and both sleep for 30 seconds, so a test against the old behavior fails instead of hanging.
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const holder = pidFile => [process.execPath, ['-e', `
  const { spawn } = require('node:child_process');
  const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
  setInterval(() => {}, 1000);`]];
const withHolder = fn => async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-timeout-'));
  const pidFile = join(dir, 'helper.pid');
  let helper;
  try { await fn(pidFile, pid => { helper = pid; }); }
  finally { if (helper && alive(helper)) process.kill(helper, 'SIGKILL'); await rm(dir, { recursive: true, force: true }); }
};

describe('A provider process that outlives its time limit (#277)', () => {
  it('given a helper in its own session keeping the output open when the limit passes then execute returns within a few seconds as timed out', withHolder(async (pidFile, track) => {
    const started = Date.now();
    const result = await execute(...holder(pidFile), { timeoutMs: 500 });
    track(Number(await readFile(pidFile, 'utf8')));
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 10000, `returned after ${Date.now() - started}ms`);
  }));
  it('given a helper in its own session when the limit passes then the helper is killed with the provider and nothing is left running', withHolder(async (pidFile, track) => {
    const started = Date.now();
    await execute(...holder(pidFile), { timeoutMs: 500 });
    const helper = Number(await readFile(pidFile, 'utf8'));
    track(helper);
    assert.ok(Date.now() - started < 10000, `returned after ${Date.now() - started}ms`);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(alive(helper), false, `helper ${helper} is still running`);
  }));
  it('given a ps that never answers when the limit passes then execute still returns within a few seconds as timed out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-slow-ps-'));
    const path = process.env.PATH;
    try {
      await writeFile(join(dir, 'ps'), '#!/bin/sh\nexec sleep 30\n');
      await chmod(join(dir, 'ps'), 0o755);
      process.env.PATH = `${dir}:${path}`;
      const started = Date.now();
      const result = await execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 500 });
      assert.equal(result.timedOut, true);
      assert.ok(Date.now() - started < 10000, `returned after ${Date.now() - started}ms`);
    } finally { process.env.PATH = path; await rm(dir, { recursive: true, force: true }); }
  });
  it('given a provider that finishes in time when it exits then execute still waits for its whole output', async () => {
    const result = await execute(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'], { timeoutMs: 10000 });
    assert.equal(result.ok, true);
    assert.equal(result.stdout.length, 200000);
  });
});
