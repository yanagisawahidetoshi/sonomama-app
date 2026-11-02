import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from './workspace.mjs';
import { readFile } from 'node:fs/promises';
import { checkApiContract, checkRailsRoutes } from './api-contract.mjs';
import { fixture, update, commitFixture, runFixture } from './test-fixture.mjs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const schema = (paths, openapi = '3.1.0') => JSON.stringify({ openapi, info: { title: 'SONOMAMA', version: '0.1.0' }, paths });
const lessons = { '/lessons': { get: { operationId: 'listLessons', responses: { 200: { description: 'OK' } } } } };
const lessonsAndCoaches = { ...lessons, '/coaches': { get: { operationId: 'listCoaches', responses: { 200: { description: 'OK' } } } } };

async function repo(fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sonomama-contract-')));
  try {
    await mkdir(join(root, 'packages/api-schema'), { recursive: true });
    await git(root, ['init', '--template=', '--initial-branch=main']);
    await git(root, ['config', 'user.email', 'harness@example.invalid']);
    await git(root, ['config', 'user.name', 'Harness']);
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
}
const write = (root, text, file = 'openapi.json') => writeFile(join(root, 'packages/api-schema', file), text);
const routes = async (root, entries) => {
  await mkdir(join(root, 'apps/api/config'), { recursive: true });
  await writeFile(join(root, 'apps/api/config/routes.rb'), 'Rails.application.routes.draw do\nend\n');
  if (entries !== undefined) await writeFile(join(root, 'apps/api/config/routes.manifest.json'), typeof entries === 'string' ? entries : JSON.stringify(entries));
};
const route = (verb, path, controller = 'api/v1/lessons', action = 'index') => ({ verb, path, controller, action });
const lesson = { '/api/v1/lessons/{lessonId}': { get: { operationId: 'getLesson', responses: { 200: { description: 'OK' } } }, patch: { operationId: 'updateLesson', responses: { 200: { description: 'OK' } } } } };
const contract = async (root, paths, entries) => { await commit(root); await write(root, schema(paths)); await routes(root, entries); return checkApiContract({ root, base: 'main' }); };
const commit = async root => { await git(root, ['add', '--all']); await git(root, ['commit', '--allow-empty', '-m', 'base']); };

describe('API contract verifier', () => {
  describe('given no OpenAPI document at the base', () => {
    it('when a valid OpenAPI 3.1 document is added then passes', () => repo(async root => {
      await commit(root);
      await write(root, schema(lessons));
      const result = await checkApiContract({ root, base: 'main' });
      assert.equal(result.status, 'PASS');
      assert.deepEqual(result.breaking, []);
    }));

    it('when an OpenAPI 3.0 document is added then fails', () => repo(async root => {
      await commit(root);
      await write(root, schema(lessons, '3.0.3'));
      const result = await checkApiContract({ root, base: 'main' });
      assert.equal(result.status, 'FAIL');
      assert.match(result.errors.join('\n'), /OpenAPI 3\.1\.x/);
    }));

    it('when the document cannot be parsed then fails', () => repo(async root => {
      await commit(root);
      await write(root, '{ not json');
      assert.equal((await checkApiContract({ root, base: 'main' })).status, 'FAIL');
    }));
  });

  describe('given an OpenAPI document at the base', () => {
    it('when an endpoint is added then passes and reports the addition as non-breaking', () => repo(async root => {
      await write(root, schema(lessons));
      await commit(root);
      await write(root, schema(lessonsAndCoaches));
      const result = await checkApiContract({ root, base: 'main' });
      assert.equal(result.status, 'PASS');
      assert.ok(result.nonBreaking.length > 0);
    }));

    it('when an endpoint is removed then fails as a breaking change', () => repo(async root => {
      await write(root, schema(lessonsAndCoaches));
      await commit(root);
      await write(root, schema(lessons));
      const result = await checkApiContract({ root, base: 'main' });
      assert.equal(result.status, 'FAIL');
      assert.match(result.breaking.join('\n'), /\/coaches/);
    }));
  });

  describe('given no OpenAPI document in the change', () => {
    it('when the Source of Truth is still missing then reports it as not created', () => repo(async root => {
      await commit(root);
      const result = await checkApiContract({ root, base: 'main' });
      assert.equal(result.status, 'MISSING');
    }));
  });

  describe('given an OpenAPI document and the Rails route manifest', () => {
    it('when every Rails route is in the contract then passes without mismatches', () => repo(async root => {
      const result = await contract(root, lesson, [route('GET', '/api/v1/lessons/:id(.:format)', 'api/v1/lessons', 'show'), route('PATCH', '/api/v1/lessons/:id(.:format)', 'api/v1/lessons', 'update')]);
      assert.equal(result.status, 'PASS');
      assert.deepEqual(result.mismatches, []);
      assert.deepEqual(result.unimplemented, []);
    }));

    it('when Rails adds an endpoint that the contract does not define then fails naming the route', () => repo(async root => {
      const result = await contract(root, lesson, [route('GET', '/api/v1/lessons/:id(.:format)', 'api/v1/lessons', 'show'), route('GET', '/api/v1/coaches(.:format)', 'api/v1/coaches')]);
      assert.equal(result.status, 'FAIL');
      assert.match(result.mismatches.join('\n'), /GET \/api\/v1\/coaches/);
    }));

    it('when Rails serves a contract path with a method the contract does not define then fails naming the method', () => repo(async root => {
      const result = await contract(root, lesson, [route('PUT', '/api/v1/lessons/:id(.:format)', 'api/v1/lessons', 'update')]);
      assert.equal(result.status, 'FAIL');
      assert.match(result.mismatches.join('\n'), /PUT \/api\/v1\/lessons\/\{\}.*GET, PATCH/);
    }));

    it('when Rails serves a path that differs from the contract only by a segment then fails', () => repo(async root => {
      const result = await contract(root, lesson, [route('GET', '/api/v1/lesson/:id(.:format)', 'api/v1/lessons', 'show')]);
      assert.equal(result.status, 'FAIL');
      assert.match(result.mismatches.join('\n'), /\/api\/v1\/lesson\//);
    }));

    it('when a Rails route accepts any HTTP method then fails because the contract cannot cover it', () => repo(async root => {
      const result = await contract(root, lesson, [route('', '/api/v1/lessons/:id(.:format)', 'api/v1/lessons', 'show')]);
      assert.equal(result.status, 'FAIL');
      assert.match(result.mismatches.join('\n'), /any HTTP method/);
    }));

    it('when a Rails route has an optional segment other than the format then fails instead of guessing the paths', () => repo(async root => {
      const result = await contract(root, lesson, [route('GET', '/api/v1/lessons(/:id)(.:format)', 'api/v1/lessons', 'show')]);
      assert.equal(result.status, 'FAIL');
      assert.match(result.mismatches.join('\n'), /optional segment/);
    }));

    it('when the contract defines an operation that Rails has not implemented yet then passes and reports it as unimplemented', () => repo(async root => {
      const result = await contract(root, lesson, [route('GET', '/api/v1/lessons/:id(.:format)', 'api/v1/lessons', 'show')]);
      assert.equal(result.status, 'PASS');
      assert.deepEqual(result.unimplemented, ['PATCH /api/v1/lessons/{lessonId}']);
    }));

    it('when path parameter names differ between Rails and the contract then matches them by position', () => repo(async root => {
      const result = await contract(root, lesson, [route('GET', '/api/v1/lessons/:id(.:format)', 'api/v1/lessons', 'show')]);
      assert.deepEqual(result.mismatches, []);
    }));

    it('when the only Rails routes are framework routes such as the health check then excludes them from the contract', () => repo(async root => {
      const result = await contract(root, lesson, [route('GET', '/up(.:format)', 'rails/health', 'show')]);
      assert.equal(result.status, 'PASS');
      assert.deepEqual(result.mismatches, []);
    }));

    it('when the Rails app has no route manifest then fails and asks for it to be generated', () => repo(async root => {
      const result = await contract(root, lesson, undefined);
      assert.equal(result.status, 'FAIL');
      assert.match(result.errors.join('\n'), /routes\.manifest\.json/);
    }));

    it('when the route manifest is not a list of routes then fails', () => repo(async root => {
      const result = await contract(root, lesson, '{"verb":"GET"}');
      assert.equal(result.status, 'FAIL');
      assert.match(result.errors.join('\n'), /routes\.manifest\.json/);
    }));
  });

  describe('given an OpenAPI document without a Rails app', () => {
    it('when the contract is checked then skips the route comparison and passes', () => repo(async root => {
      await commit(root);
      await write(root, schema(lesson));
      const result = await checkApiContract({ root, base: 'main' });
      assert.equal(result.status, 'PASS');
      assert.deepEqual(result.mismatches, []);
    }));
  });

  describe('given a Rails-only change checked by the rails verifier', () => {
    it('when there is no OpenAPI document and Rails only serves framework routes then passes', () => repo(async root => {
      await routes(root, [route('GET', '/up(.:format)', 'rails/health', 'show')]);
      const result = await checkRailsRoutes({ root });
      assert.equal(result.status, 'PASS');
    }));

    it('when there is no OpenAPI document and Rails adds a business endpoint then fails because the contract must come first', () => repo(async root => {
      await routes(root, [route('GET', '/api/v1/lessons(.:format)')]);
      const result = await checkRailsRoutes({ root });
      assert.equal(result.status, 'FAIL');
      assert.match(result.mismatches.join('\n'), /GET \/api\/v1\/lessons/);
    }));

    it('when the OpenAPI document defines the Rails route then passes', () => repo(async root => {
      await write(root, schema(lesson));
      await routes(root, [route('GET', '/api/v1/lessons/:id(.:format)', 'api/v1/lessons', 'show')]);
      assert.equal((await checkRailsRoutes({ root })).status, 'PASS');
    }));

    it('when the rails verifier runs then it compares the Rails routes with the contract before booting Rails', async () => {
      const config = JSON.parse(await readFile(new URL('../../.harness/config/harness.json', import.meta.url), 'utf8'));
      const [first] = config.verifiers.find(v => v.id === 'rails').commands;
      assert.deepEqual(first, ['node', '../../tools/harness/api-contract.mjs', '--routes']);
    });
  });
  // #251 made the repository carry a contract; a run (harness:demo) checks it in a workspace that may have no origin/main,
  // as a CI job that checks out one SHA does. The run's baseline is what the change is compared with.
  describe('given a Harness run that verifies the API contract', () => {
    const repositoryContract = new URL('../../packages/api-schema/openapi.yaml', import.meta.url);
    const prepare = async root => {
      // The run workspace lies inside the repository and resolves the Harness dependencies (yaml) from its node_modules, as a checkout does.
      // The link is a file to Git, which .gitignore's node_modules/ does not match; it stays untracked so the run accepts the workspace.
      await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(root, 'node_modules')).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await mkdir(join(root, '.git/info'), { recursive: true });
      await appendFile(join(root, '.git/info/exclude'), '/node_modules\n');
      await writeFile(join(root, 'packages/api-schema/openapi.yaml'), await readFile(repositoryContract, 'utf8'));
      await update(root, '.harness/state/sample-sbi.json', s => { s.requiredVerifiers = ['api-contract']; });
      // The Prism Mock check is covered by its own tests; only the contract comparison is under test here.
      await update(root, '.harness/config/harness.json', c => { c.verifiers.find(v => v.id === 'api-contract').commands = [['node', '../../tools/harness/api-contract.mjs']]; });
    };
    const contractCheck = async (root, run) => JSON.parse(await readFile(join(root, run.runDir, 'iteration-1/result.json'), 'utf8')).verification.checks.find(c => c.id === 'api-contract');
    const output = check => check.processes.map(p => `${p.stdout}${p.stderr}`).join('');

    it('when the repository has no origin/main then compares the contract with the run baseline and passes', () => fixture(async root => {
      await prepare(root);
      const run = await runFixture({ root, quiet: true });
      const check = await contractCheck(root, run);
      assert.equal(check.status, 'PASS', output(check));
      assert.match(output(check), new RegExp(`API contract \\(base ${run.baselineSha}\\): PASS`));
    }));

    it('when origin/main holds an operation the baseline already removed then still compares with the baseline and reports no breaking change', () => fixture(async root => {
      const document = parseYaml(await readFile(repositoryContract, 'utf8'));
      document.paths['/api/v1/retired'] = { get: { operationId: 'getRetired', responses: { 200: { description: 'OK' } } } };
      await writeFile(join(root, 'packages/api-schema/openapi.yaml'), stringifyYaml(document));
      await commitFixture(root);
      await git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      await prepare(root);
      const run = await runFixture({ root, quiet: true });
      const check = await contractCheck(root, run);
      assert.equal(check.status, 'PASS', output(check));
      assert.doesNotMatch(output(check), /BREAKING/);
    }));

    it('when the run has verified the contract then the Harness process keeps its own HARNESS_BASE_REF', () => fixture(async root => {
      const previous = process.env.HARNESS_BASE_REF;
      process.env.HARNESS_BASE_REF = 'harness-own-base';
      try {
        await prepare(root);
        await runFixture({ root, quiet: true });
        assert.equal(process.env.HARNESS_BASE_REF, 'harness-own-base');
      } finally { if (previous === undefined) delete process.env.HARNESS_BASE_REF; else process.env.HARNESS_BASE_REF = previous; }
    }));
  });
});
