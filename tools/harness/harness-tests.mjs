import { access, readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
// #288: the Harness tests a change needs before push. A test is selected when it is changed or names a changed module, imported or run
// as a path; a module it reaches only through another module does not select it (test-fixture.mjs reaches nearly all of them).
// A change no import can scope (config, rules, workflow, hook, a non-module file, the toolchain) asks for every test, which CI runs.
const firstMatch = (patterns = [], path) => patterns.some(p => new RegExp(p).test(path));
const isModule = path => /^(tools\/harness|\.harness\/verification)\/.*\.mjs$/.test(path);
const named = /['"`]([^'"`\s]+\.mjs)['"`]/g;

// The directories harness:test runs, read from its script so the two never drift apart.
async function testFiles(root) {
  const script = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts['harness:test'];
  const dirs = [...script.matchAll(/([\w.][\w.\/-]*)\/\*\.test\.mjs/g)].map(m => m[1]);
  const lists = await Promise.all(dirs.map(async dir => (await readdir(join(root, dir)).catch(() => [])).filter(f => f.endsWith('.test.mjs')).map(f => `${dir}/${f}`)));
  return lists.flat();
}

// Which changed paths are Harness modules, and which ask for every test. Pure, so a caller can decide before it reads any tree.
export function classifyHarnessChange({ config, files }) {
  const reasons = [], modules = [];
  for (const { path } of files) {
    if (firstMatch(config.impact?.toolchain, path)) reasons.push(`toolchain:${path}`);
    else if (!firstMatch(config.impact?.fullGate, path)) continue;
    else if (isModule(path)) modules.push(path);
    else reasons.push(`diff:${path}`);
  }
  return { all: reasons.length > 0, modules, reasons };
}

const exists = path => access(path).then(() => true, () => false);

// #300: a unit test is selected by the modules it names; an integration test by itself and the modules it owns, so a shared module
// (io.mjs, index.mjs, workspace.mjs) no longer pulls in every whole-flow test. pre-push runs no integration test; CI runs the selected ones.
export async function selectHarnessTests({ root, config, files, stage = 'ci' }) {
  const { all, modules, reasons } = classifyHarnessChange({ config, files });
  const integration = config.harnessTests?.integration ?? {};
  // A stale declaration fails closed: a renamed test or owner would otherwise leave its flow untested until main.
  const missing = [];
  for (const path of new Set(Object.entries(integration).flat(2))) if (!await exists(join(root, path))) missing.push(path);
  if (missing.length) throw new Error(`Harness integration tests declared in .harness/config/harness.json do not exist: ${missing.join(', ')}`);
  if (all || !modules.length) return { all, tests: [], reasons };
  const changed = new Set(modules), tests = [];
  for (const test of await testFiles(root)) {
    if (integration[test]) {
      if (stage !== 'pre-push' && (changed.has(test) || integration[test].some(owner => changed.has(owner)))) tests.push(test);
      continue;
    }
    const dir = posix.dirname(test);
    const names = [...(await readFile(join(root, test), 'utf8')).matchAll(named)].flatMap(([, name]) => [posix.join(dir, name), posix.normalize(name)]);
    if (changed.has(test) || names.some(name => changed.has(name))) tests.push(test);
  }
  return { all: false, tests: tests.sort(), reasons };
}
