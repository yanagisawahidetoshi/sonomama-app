import { access, readFile, writeFile, mkdir, rename, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redact, redactText } from './evidence-protection.mjs';
import { spawn, spawnSync } from 'node:child_process';
export const exists = path => access(path).then(() => true, () => false);
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
export async function json(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(redact(value), null, 2) + '\n');
  await rename(temp, path);
}
// The process and every descendant, found before any of them dies (a killed parent hands its children to init). A provider may start
// helpers in their own session, so killing the process group alone can leave them running with our output pipes open (#277).
function processTree(root) {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  const children = new Map();
  for (const line of (listed.stdout ?? '').split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const tree = [root];
  for (let i = 0; i < tree.length; i += 1) tree.push(...(children.get(tree[i]) ?? []));
  return tree;
}
// After a kill, this long at most for the output to close; a descendant we could not see must not hold the run (#277).
const closeGraceMs = 2000;
// No shell expansion. env replaces the inherited environment when given. Bound runtime and captured output; on timeout kill the process
// group and every descendant, and return within closeGraceMs even when something still holds the output open.
export function execute(command, args, { cwd, input = '', timeoutMs = 120000, env } = {}) {
  const started = Date.now();
  return new Promise(resolve => {
    let stdout = '', stderr = '', error = null, timedOut = false, done = false, grace = null;
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (code, signal) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(grace);
      resolve({ code, signal, timedOut, error, durationMs: Date.now() - started, stdout: stdout.slice(0, 1024 * 1024), stderr: stderr.slice(0, 1024 * 1024), ok: code === 0 && !error && !timedOut });
    };
    const kill = () => {
      if (process.platform === 'win32') { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
      else {
        const tree = child.pid ? processTree(child.pid) : [];
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
        for (const pid of tree) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
      }
      grace ??= setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(child.exitCode, child.signalCode ?? 'SIGKILL'); }, closeGraceMs);
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const collect = key => chunk => {
      if (key === 'out') stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 1024 * 1024) { error = 'process output limit exceeded'; kill(); }
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    child.on('error', e => { error = e.message; });
    child.stdin.on('error', () => {});
    child.on('close', finish);
    child.stdin.end(input);
  });
}

export async function evidenceText(path, text, append = false) {
  await mkdir(dirname(path), { recursive: true });
  await (append ? appendFile : writeFile)(path, redactText(text));
}
