import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm, rmdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commitFixture, fixture } from './test-fixture.mjs';
import { git } from './workspace.mjs';
import { planPushGate, runPushGate } from './push-gate.mjs';
const exec=promisify(execFile);
const root=new URL('../../',import.meta.url).pathname;
// git hands the pushed refs to pre-push on stdin; the hook must read them before anything else consumes stdin.
const hook=(env,input='')=>{ const run=exec('sh',[join(root,'.githooks/pre-push')],{cwd:root,env}); run.child.stdin.end(input); return run; };
const zero='0'.repeat(40), sha=c=>c.repeat(40);
describe('Versioned pre-push quality gate',()=>{
  describe('given a failing check or test',()=>{
    for(const fail of ['harness:check','harness:push-gate','none']) {
      it(`when ${fail} fails then push gate returns the correct exit status`,async()=>{
        const temp=await mkdtemp(join(tmpdir(),'harness-hook-'));
        try {
          await writeFile(join(temp,'pnpm'),`#!/bin/sh\necho "$1" >> "$GATE_LOG"\n[ "$1" != "$GATE_FAIL" ]\n`);
          await chmod(join(temp,'pnpm'),0o755);
          let failed=false;
          try { await hook({...process.env,PATH:`${temp}:${process.env.PATH}`,GATE_LOG:join(temp,'log'),GATE_FAIL:fail}); } catch { failed=true; }
          assert.equal(failed,fail!=='none');
          assert.equal(await readFile(join(temp,'log'),'utf8'),fail==='harness:check'?'harness:check\n':'harness:check\nharness:push-gate\n');
        } finally { await rm(temp,{recursive:true,force:true}); }
      });
    }
  });
  describe('given git exported GIT_DIR of the pushing worktree to the hook',()=>{
    it('when the gate runs tests then git fixtures do not inherit the repository location',async()=>{
      const temp=await mkdtemp(join(tmpdir(),'harness-hook-'));
      try {
        await writeFile(join(temp,'pnpm'),`#!/bin/sh\necho "${'$'}{GIT_DIR-unset} ${'$'}{GIT_WORK_TREE-unset} ${'$'}{GIT_INDEX_FILE-unset}" >> "$GATE_LOG"\n`);
        await chmod(join(temp,'pnpm'),0o755);
        await hook({...process.env,PATH:`${temp}:${process.env.PATH}`,GATE_LOG:join(temp,'log'),GIT_DIR:join(root,'.git'),GIT_WORK_TREE:root,GIT_INDEX_FILE:join(root,'.git/index')});
        assert.equal(await readFile(join(temp,'log'),'utf8'),'unset unset unset\nunset unset unset\n');
      } finally { await rm(temp,{recursive:true,force:true}); }
    });
  });
  describe('given the refs git hands to pre-push',()=>{
    it('when the hook runs then passes the refs from stdin to the Harness push gate',async()=>{
      const temp=await mkdtemp(join(tmpdir(),'harness-hook-'));
      try {
        await writeFile(join(temp,'pnpm'),`#!/bin/sh\necho "$1 ${'$'}{HARNESS_PUSH_REFS-unset}" >> "$GATE_LOG"\n`);
        await chmod(join(temp,'pnpm'),0o755);
        const refs=`refs/heads/x ${sha('a')} refs/heads/x ${sha('b')}`;
        await hook({...process.env,PATH:`${temp}:${process.env.PATH}`,GATE_LOG:join(temp,'log')},`${refs}\n`);
        assert.equal(await readFile(join(temp,'log'),'utf8'),`harness:check unset\nharness:push-gate ${refs}\n`);
      } finally { await rm(temp,{recursive:true,force:true}); }
    });
    it('when an outer push gate exported its refs then the hook passes only the refs of this push',async()=>{
      const temp=await mkdtemp(join(tmpdir(),'harness-hook-'));
      try {
        await writeFile(join(temp,'pnpm'),`#!/bin/sh\necho "$1 ${'$'}{HARNESS_PUSH_REFS-unset}" >> "$GATE_LOG"\n`);
        await chmod(join(temp,'pnpm'),0o755);
        const refs=`refs/heads/x ${sha('a')} refs/heads/x ${sha('b')}`;
        await hook({...process.env,PATH:`${temp}:${process.env.PATH}`,GATE_LOG:join(temp,'log'),HARNESS_PUSH_REFS:`refs/heads/outer ${sha('c')} refs/heads/outer ${zero}`},`${refs}\n`);
        assert.equal(await readFile(join(temp,'log'),'utf8'),`harness:check unset\nharness:push-gate ${refs}\n`);
      } finally { await rm(temp,{recursive:true,force:true}); }
    });
    it('when reading the hook then it names no verifier, because Impact Analysis in the Harness decides them',async()=>{
      const text=await readFile(join(root,'.githooks/pre-push'),'utf8');
      const config=JSON.parse(await readFile(join(root,'.harness/config/harness.json'),'utf8'));
      for (const {id} of config.verifiers) assert.doesNotMatch(text,new RegExp(`\\b${id}\\b`),id);
      assert.doesNotMatch(text,/harness:(test|verify)|no-verify/);
    });
  });
});

describe('Push gate planning',()=>{
  const head=sha('a');
  describe('given a single branch push of HEAD',()=>{
    it('when the remote branch exists then analyses the impact against the remote commit',()=>{
      assert.deepEqual(planPushGate({refs:`refs/heads/x ${head} refs/heads/x ${sha('b')}\n`,head,fallbackBase:'origin/main'}),{mode:'impact',shas:[head],base:sha('b'),reasons:['remote:refs/heads/x']});
    });
    it('when the branch is new then analyses the impact against the default branch',()=>{
      assert.deepEqual(planPushGate({refs:`refs/heads/x ${head} refs/heads/x ${zero}\n`,head,fallbackBase:'origin/main'}),{mode:'impact',shas:[head],base:'origin/main',reasons:['new-branch:origin/main']});
    });
    it('when the pushed commit is not HEAD then still analyses the impact of the pushed commit',()=>{
      assert.deepEqual(planPushGate({refs:`refs/heads/x ${sha('d')} refs/heads/x ${sha('b')}\n`,head,fallbackBase:'origin/main'}),{mode:'impact',shas:[sha('d')],base:sha('b'),reasons:['remote:refs/heads/x']});
    });
  });
  describe('given a push the gate cannot scope safely',()=>{
    for (const [name,refs,fallbackBase,shas,reason] of [
      ['no ref is given','','origin/main',[head],'push refs unknown'],
      ['several refs are pushed',`refs/heads/x ${head} refs/heads/x ${sha('b')}\nrefs/heads/y ${sha('d')} refs/heads/y ${sha('c')}\n`,'origin/main',[head,sha('d')],'several refs pushed'],
      ['a new branch has no default branch to compare with',`refs/heads/x ${head} refs/heads/x ${zero}\n`,null,[head],'no base for a new branch'],
      ['a line is malformed','refs/heads/x\n','origin/main',[head],'push refs unknown'],
    ]) {
      it(`when ${name} then leaves the Harness tests to CI`,()=>{
        assert.deepEqual(planPushGate({refs,head,fallbackBase}),{mode:'unscoped',shas,reasons:[reason]});
      });
    }
  });
  describe('given only a branch deletion',()=>{
    it('when nothing new is pushed then runs no verifier beyond harness:check',()=>{
      assert.deepEqual(planPushGate({refs:`(delete) ${zero} refs/heads/x ${sha('b')}\n`,head,fallbackBase:'origin/main'}),{mode:'skip',reasons:['delete only']});
    });
  });
});

// #288: pre-push gives fast feedback. It runs only the Harness tests that name a changed module; the verifiers, the Full Gate and
// whatever it cannot narrow run in CI, and the push to main runs everything.
describe('Push gate execution',()=>{
  const branch=async (root,paths)=>{
    const base=(await git(root,['rev-parse','HEAD'])).stdout.trim();
    await git(root,['switch','-c','feature']);
    for (const [path,text] of Object.entries(Array.isArray(paths)?Object.fromEntries(paths.map(p=>[p,'export const changed = true;\n'])):paths)) {
      await mkdir(join(root,path,'..'),{recursive:true}); await writeFile(join(root,path),text);
    }
    await commitFixture(root);
    const head=(await git(root,['rev-parse','HEAD'])).stdout.trim();
    return `refs/heads/feature ${head} refs/heads/feature ${base}\n`;
  };
  const module={'tools/harness/light.mjs':'export const light = true;\n','tools/harness/light.test.mjs':"import { light } from './light.mjs';\n"};
  const gate=async (root,refs,{passes=true}={})=>{
    const ran=[]; let installed=0;
    const result=await runPushGate({root,refs,install:async()=>{ installed++; return true; },runTests:async (workspace,tests)=>{ ran.push(...tests); return passes; }});
    return {...result,ran,installed};
  };
  describe('given a change in one application area',()=>{
    for (const [area,path] of [['Admin','apps/admin/src/main.ts'],['Mobile','apps/mobile/src/app/index.tsx'],['Rails','apps/api/app/models/lesson.rb']]) {
      it(`when only ${area} changes then runs no verifier and no Harness test and installs nothing, leaving the verifiers to CI`,()=>fixture(async root=>{
        const result=await gate(root,await branch(root,[path]));
        assert.deepEqual(result.ran,[]);
        assert.equal(result.installed,0);
        assert.equal(result.passed,true);
      }));
    }
  });
  describe('given a change of a Harness module',()=>{
    it('when tests import the module then runs only those tests on the pushed commit',()=>fixture(async root=>{
      const result=await gate(root,await branch(root,module));
      assert.equal(result.mode,'impact');
      assert.deepEqual(result.ran,['tools/harness/light.test.mjs']);
      assert.equal(result.installed,1);
      assert.equal(result.passed,true);
    }));
    it('when a selected test fails then stops the push',()=>fixture(async root=>{
      const result=await gate(root,await branch(root,module),{passes:false});
      assert.equal(result.passed,false);
    }));
  });
  describe('given a change that only CI can narrow',()=>{
    for (const path of ['.harness/config/lanes.json','.github/workflows/harness.yml','.githooks/pre-push','.node-version']) {
      it(`when ${path} changes then runs no Harness test locally and says CI runs them`,()=>fixture(async root=>{
        const lines=[];
        const result=await runPushGate({root,refs:await branch(root,[path]),log:line=>lines.push(line),install:async()=>true,runTests:async()=>assert.fail('no local test')});
        assert.equal(result.passed,true);
        assert.ok(lines.some(l=>l.includes('CI')&&l.includes(path)),lines.join('\n'));
      }));
    }
    it('when the push cannot be scoped then runs no Harness test locally',()=>fixture(async root=>{
      await branch(root,['apps/admin/src/main.ts']);
      const head=(await git(root,['rev-parse','HEAD'])).stdout.trim();
      const result=await gate(root,`refs/heads/feature ${head} refs/heads/feature ${sha('e')}\n`);
      assert.equal(result.mode,'unscoped');
      assert.deepEqual(result.reasons,['remote commit unknown locally']);
      assert.deepEqual(result.ran,[]);
      assert.equal(result.passed,true);
    }));
  });
  describe('given only documentation changes',()=>{
    it('when no Harness test is selected then passes after harness:check alone',()=>fixture(async root=>{
      const result=await gate(root,await branch(root,['docs/architecture/notes.md']));
      assert.deepEqual(result.ran,[]);
      assert.equal(result.installed,0);
      assert.equal(result.passed,true);
    }));
  });
  describe('given a working tree that differs from the pushed commit',()=>{
    const worktrees=async root=>(await git(root,['worktree','list','--porcelain'])).stdout.split('\n').filter(l=>l.startsWith('worktree '));
    const gone=async path=>access(path).then(()=>false,()=>true);
    it('when HEAD is broken and only an uncommitted fix passes then tests the pushed commit and stops the push',()=>fixture(async root=>{
      const refs=await branch(root,module);
      await writeFile(join(root,'tools/harness/light.mjs'),'export const light = "fixed";\n');
      const result=await runPushGate({root,refs,install:async()=>true,
        runTests:async workspace=>(await readFile(join(workspace,'tools/harness/light.mjs'),'utf8')).includes('fixed')});
      assert.equal(result.passed,false);
    }));
    it('when the gate tests then hands over a detached worktree at the pushed commit outside the checkout and removes it afterwards',()=>fixture(async root=>{
      const refs=await branch(root,module);
      const pushed=refs.split(' ')[1];
      const seen=[];
      await runPushGate({root,refs,install:async()=>true,runTests:async workspace=>{
        seen.push({workspace,head:(await git(workspace,['rev-parse','HEAD'])).stdout.trim(),branch:(await git(workspace,['rev-parse','--abbrev-ref','HEAD'])).stdout.trim()});
        return true;
      }});
      assert.equal(seen.length,1);
      assert.notEqual(seen[0].workspace,root);
      assert.ok(!seen[0].workspace.startsWith(root));
      assert.equal(seen[0].head,pushed);
      assert.equal(seen[0].branch,'HEAD');
      assert.equal(await gone(seen[0].workspace),true);
      assert.deepEqual(await worktrees(root),[`worktree ${root}`]);
    }));
    it('when the dependencies cannot be installed in the worktree then stops the push and removes the worktree',()=>fixture(async root=>{
      const refs=await branch(root,module);
      let tested=0;
      const result=await runPushGate({root,refs,install:async()=>false,runTests:async()=>{ tested++; return true; }});
      assert.equal(result.passed,false);
      assert.equal(tested,0);
      assert.deepEqual(await worktrees(root),[`worktree ${root}`]);
    }));
    it('when a test run throws then still removes the worktree',()=>fixture(async root=>{
      const refs=await branch(root,module);
      await assert.rejects(runPushGate({root,refs,install:async()=>true,runTests:async()=>{ throw new Error('boom'); }}),/boom/);
      assert.deepEqual(await worktrees(root),[`worktree ${root}`]);
    }));
    it('when the tests leave untracked files then keeps the worktree without force and reports its path',()=>fixture(async root=>{
      const refs=await branch(root,module);
      const lines=[]; let workspace;
      const result=await runPushGate({root,refs,install:async()=>true,log:line=>lines.push(line),
        runTests:async w=>{ workspace=w; await writeFile(join(w,'stray.txt'),'left behind\n'); return true; }});
      try {
        assert.equal(result.passed,true);
        assert.deepEqual(result.leftovers,[workspace]);
        assert.ok(lines.some(l=>l.includes(workspace)));
        assert.equal(await gone(workspace),false);
      } finally { await rm(join(workspace,'stray.txt')); await git(root,['worktree','remove',workspace]); await rmdir(join(workspace,'..')); }
    }));
  });
});
