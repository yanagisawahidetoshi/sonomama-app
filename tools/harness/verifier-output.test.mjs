import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifierDiagnostics } from './verifier-output.mjs';

const failed = overrides => ({ id: 'expo', status: 'FAIL', processes: [{ phase: 'verify', command: ['pnpm', 'run', 'doctor'], code: 1,
  ok: false, stderr: '1 check failed', stdout: 'Check package versions\nexpo expects a compatible patch', ...overrides }] });

describe('Verifier diagnostics', () => {
  describe('given a failed internal check with output on both streams', () => {
    it('when rendered then identifies the verifier, phase, exact command and exit code and retains both outputs', () => {
      const output = verifierDiagnostics(failed()).join('\n');
      assert.match(output, /Internal check: expo \/ verify \/ pnpm run doctor/);
      assert.match(output, /Command: \["pnpm","run","doctor"\]/);
      assert.match(output, /Exit code: 1/);
      assert.match(output, /stderr:\n  \| 1 check failed/);
      assert.match(output, /stdout:\n  \| Check package versions\n  \| expo expects a compatible patch/);
    });
    it('when the explanatory output starts more than 4000 characters before the end then it is still printed', () => {
      const output = verifierDiagnostics(failed({ stdout: 'ROOT CAUSE\n' + 'x'.repeat(5000) })).join('\n');
      assert.match(output, /ROOT CAUSE/);
      assert.match(output, /x{5000}/);
    });
  });
  describe('given a check with several commands', () => {
    it('when one fails then logs the failing command without logging successful commands or changing the result', () => {
      const check = failed();
      check.processes.unshift({ phase: 'setup', command: ['pnpm', 'install'], code: 0, ok: true, stdout: 'INSTALL_OK' });
      const before = structuredClone(check);
      const output = verifierDiagnostics(check).join('\n');
      assert.doesNotMatch(output, /INSTALL_OK|pnpm install/);
      assert.deepEqual(check, before);
    });
  });
  describe('given setup failures, timeouts and spawn failures', () => {
    it('when setup fails then names the setup phase', () => {
      assert.match(verifierDiagnostics(failed({ phase: 'setup', command: ['pnpm', 'install'], code: 3 })).join('\n'), /expo \/ setup \/ pnpm install/);
    });
    it('when the command times out then reports the missing exit code and termination signal', () => {
      const output = verifierDiagnostics(failed({ code: null, signal: 'SIGKILL', timedOut: true })).join('\n');
      assert.match(output, /Exit code: null/);
      assert.match(output, /Signal: SIGKILL/);
      assert.match(output, /Timed out: true/);
    });
    it('when spawning fails then reports the error even with empty output streams', () => {
      const output = verifierDiagnostics(failed({ code: null, error: 'spawn pnpm ENOENT', stdout: '', stderr: '' })).join('\n');
      assert.match(output, /spawn pnpm ENOENT/);
      assert.match(output, /stderr:\n  \| \(empty\)/);
    });
  });
  describe('given sensitive or untrusted command output', () => {
    it('when logging then redacts credentials in commands and both streams and prevents Actions command injection', () => {
      const output = verifierDiagnostics(failed({ command: ['node', 'probe.mjs', 'password=example-password'],
        stdout: 'token=example-token\n::error::untrusted annotation', stderr: 'password=example-password\n::stop-commands::unsafe' })).join('\n');
      assert.doesNotMatch(output, /example-password|example-token/);
      assert.match(output, /\[REDACTED\]/);
      assert.match(output, /  \| ::error::untrusted annotation/);
      assert.doesNotMatch(output, /^::/m);
    });
  });
  describe('given a trusted acceptance process or a missing process', () => {
    it('when the check uses the singular process field then its failure is also logged', () => {
      const check = failed(); check.process = check.processes[0]; delete check.processes;
      assert.match(verifierDiagnostics(check).join('\n'), /Exit code: 1/);
    });
    it('when no process was run then does not invent a failing command', () => {
      assert.deepEqual(verifierDiagnostics({ id: 'expo', status: 'NOT_CONFIGURED' }), []);
    });
  });
  describe('given the CLI used by GitHub Actions', () => {
    it('when rendering verifier checks then calls the diagnostic formatter instead of selecting only stderr or stdout', async () => {
      const source = await readFile(new URL('./cli.mjs', import.meta.url), 'utf8');
      assert.match(source, /verifierDiagnostics\(c\)/);
      assert.doesNotMatch(source, /p\.stderr \|\| p\.stdout/);
    });
  });
});
