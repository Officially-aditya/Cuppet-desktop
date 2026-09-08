import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pe3TaskRegistry } from '../src/runtime/pe3/registry.mjs';

function state(sessionID) {
  return { id:`task:${sessionID}`, sessionID, taskDescriptor:'auth task', activePaths:['src/auth.ts'], touchedPaths:['src/auth.ts'], recentSymbols:['login'], terms:['auth','login'], fingerprint:{ revision:1, paths:[{value:'src/auth.ts',weight:1,source:'touched',updatedAt:1}], symbols:[], terms:[] }, stalePaths:[], cacheEpoch:0, workspaceEpoch:0, createdAt:1, lastActiveAt:2, turns:2 };
}

test('PE3 registry stores routing metadata only and invalidates offline-changed privileged paths', async () => {
  const root = await mkdtemp(join(tmpdir(),'cuppet-pe3-root-'));
  const store = await mkdtemp(join(tmpdir(),'cuppet-pe3-store-'));
  try {
    await mkdir(join(root,'src'),{recursive:true});
    await writeFile(join(root,'src','auth.ts'),'export const login = 1;\n');
    const registry = new Pe3TaskRegistry(store,root);
    await registry.save([state('session-a')],'session-a');
    const raw = await readFile(registry.path,'utf8');
    assert.doesNotMatch(raw,/assistant message|provider prompt|embedding vector/i);
    assert.match(raw,/src\/auth\.ts/);

    await writeFile(join(root,'src','auth.ts'),'export const login = 22222;\n');
    const loaded = await registry.load(new Set(['session-a']));
    assert.equal(loaded.recoveredFromCorruption,false);
    assert.equal(loaded.agents.length,1);
    assert.deepEqual(loaded.agents[0].stalePaths,['src/auth.ts']);
    assert.equal(loaded.agents[0].activePaths.includes('src/auth.ts'),false);
    assert.equal(loaded.agents[0].touchedPaths.includes('src/auth.ts'),false);
    assert.equal(loaded.agents[0].fingerprint.paths.some((signal)=>signal.value==='src/auth.ts'),false);
    assert.equal(loaded.agents[0].cacheEpoch,1);
  } finally { await rm(root,{recursive:true,force:true}); await rm(store,{recursive:true,force:true}); }
});

test('corrupt registry fails closed to fresh routing state', async () => {
  const root = await mkdtemp(join(tmpdir(),'cuppet-pe3-root-'));
  const store = await mkdtemp(join(tmpdir(),'cuppet-pe3-store-'));
  try {
    const registry = new Pe3TaskRegistry(store,root);
    await mkdir(store,{recursive:true});
    await writeFile(registry.path,'{ definitely not json');
    const loaded = await registry.load(new Set(['session-a']));
    assert.equal(loaded.recoveredFromCorruption,true);
    assert.deepEqual(loaded.agents,[]);
  } finally { await rm(root,{recursive:true,force:true}); await rm(store,{recursive:true,force:true}); }
});
