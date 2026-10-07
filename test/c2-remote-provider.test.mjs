import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteCommandAdapter } from '../src/runtime/remote/commands.mjs';
import { RemoteManager } from '../src/runtime/remote/manager.mjs';
import { resolveProviderBackend } from '../src/runtime/providers/default-registry.mjs';
import { createUntrackedChatProvider } from '../src/runtime/provider-factory.mjs';
import { providerRequest } from '../src/runtime/provider-policy.mjs';
import { remoteProviderProjection, remoteProviderRequest } from '../src/runtime/remote/provider-config.mjs';

function configuration(providerID, apiKey = '') {
  return { providerID, apiKey, baseUrl: providerID === 'codex' ? 'codex://app-server' : 'https://provider.invalid/v1',
    primary: {providerID,modelID:'primary-model',variant:'high'},
    secondary: {providerID,modelID:'background-model',variant:'low'},
    models: ['primary-model','background-model'].map((modelID)=>({providerID,modelID,context:200000,
      capabilities:{tools:true,streaming:true,input:['text'],output:['text']},
      api:{id:`transport-${modelID}`},variants:[{id:'high',body:{reasoning_effort:'high'}},{id:'low',body:{reasoning_effort:'low'}}]})),
  };
}

for (const providerID of ['codex','opencode','claude-code','antigravity']) {
  test(`remote ${providerID} uses the desktop provider and model without a Cuppet API key`,async()=>{
    const config=configuration(providerID);
    const calls=[];
    const adapter=new RemoteCommandAdapter({identity:{hostId:'host_test',deviceName:'Laptop'},providerConfig:config,
      call:async(method,params)=>{calls.push({method,params});if(method==='project.list'||method==='session.list')return[];
        if(method==='session.send'||method==='session.steer')return{accepted:true,sessionId:params.sessionId};throw new Error(`unexpected ${method}`);},
    });
    const actor={deviceID:'phone'};
    const host=await adapter.execute(actor,'host.get');
    assert.equal(host.provider.ready,true);
    assert.equal((await adapter.execute(actor,'provider.list'))[0].connected,true);
    await adapter.execute(actor,'session.submit',{sessionID:'s1',prompt:'Continue coding'},{id:'submit'});
    await adapter.execute(actor,'session.steer',{sessionID:'s1',instruction:'Use the desktop settings'},{id:'steer'});
    for(const call of calls.filter((call)=>['session.send','session.steer'].includes(call.method))){
      const request=call.params.provider;
      assert.equal(request.providerID,providerID);
      assert.deepEqual(request.primary,config.primary);
      assert.deepEqual(request.secondary,config.secondary);
      assert.equal(request.primaryEffort,'high');
      assert.equal(request.apiKey,'');
      assert.equal(request.contextWindow,200000);
      const runtime=createUntrackedChatProvider(request);
      assert.equal(resolveProviderBackend(request).id,providerID);
      assert.equal(typeof runtime.stream,'function');
    }
    const manager=new RemoteManager({dataDir:'/private/tmp/cuppet-unused-provider-check',call:async()=>null});
    assert.equal(manager.setProviderConfig(config).providerConfigured,true);
    await manager.close();
  });
}

test('HTTP providers still require API keys and preserve desktop model, effort, and secondary selection',()=>{
  const missing=configuration('openai-compatible');
  assert.equal(remoteProviderProjection(missing).configured,false);
  assert.throws(()=>remoteProviderRequest(missing,missing.primary),/API key is required/);
  const config=configuration('openai-compatible','host-only-key');
  const request=remoteProviderRequest(config,config.primary);
  assert.deepEqual(request.primary,config.primary);
  assert.deepEqual(request.secondary,config.secondary);
  assert.equal(request.apiKey,'host-only-key');
  assert.equal(request.models.length,2);
  const lowered=providerRequest(request,'primary');
  assert.equal(lowered.model,'transport-primary-model');
  assert.equal(lowered.variant,'high');
  assert.equal(lowered.requestBody.reasoning_effort,'high');
  assert.doesNotMatch(JSON.stringify(remoteProviderProjection(config)),/host-only-key|apiKey|baseUrl/);
});
