import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { Pe3ProjectRouter } from '../src/runtime/pe3/router.mjs';

class DormantSemantic {
  modelID = 'fake-local';
  async decide(_prompt, _active, dormant) {
    return dormant.length ? { action:'reactivate', agent:dormant[0], reason:'semantic task fingerprint decisively matches a dormant agent', fallback:false, activeSimilarity:.1, bestDormantSimilarity:.9, promptEmbeddingCount:1, agentEmbeddingCount:dormant.length+1, embeddingLatencyMs:1, modelID:this.modelID } : { action:'continue', reason:'no dormant', fallback:true, activeSimilarity:0, promptEmbeddingCount:1, agentEmbeddingCount:1, embeddingLatencyMs:1, modelID:this.modelID };
  }
}

test('reactivated dormant task carries bounded stale-path refresh requirements', async () => {
  const dir = await mkdtemp(join(tmpdir(),'cuppet-pe3-reactivate-'));
  const db = new ConversationDatabase(join(dir,'db.sqlite3'));
  try {
    db.createProject({id:'p',name:'P',canonicalPath:dir});
    db.createSession({id:'a',projectId:'p'});
    const router = new Pe3ProjectRouter({projectId:'p',projectRoot:dir,projectStore:join(dir,'pe3'),db,tst:{configured:false},semanticRouter:new DormantSemantic()});
    await router.ready();

    const a = await router.prepare({sourceSessionId:'a',prompt:'Implement authentication validation in src/auth.ts'});
    router.accept(a.token); await router.commit(a.token,()=>null);

    const b = await router.prepare({sourceSessionId:'a',prompt:'New task: implement billing calculations in src/billing.ts'});
    assert.equal(b.action,'create');
    router.accept(b.token); await router.commit(b.token,(tx)=>{db.createSession({id:tx.targetSessionId,projectId:'p'});return null;});
    await router.noteWorkspaceMutation(b.targetSessionId,['src/auth.ts']);

    const back = await router.prepare({sourceSessionId:b.targetSessionId,prompt:'Please resume the earlier authentication validation behavior we discussed'});
    assert.equal(back.action,'reactivate');
    assert.equal(back.targetSessionId,'a');
    assert.deepEqual(back.refreshPaths,['src/auth.ts']);
    router.abort(back.token,'test complete');
  } finally { db.close(); await rm(dir,{recursive:true,force:true}); }
});
