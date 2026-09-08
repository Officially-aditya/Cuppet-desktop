import { validateApiBase } from './enroll.mjs';

export async function runRemoteSetup({ apiBase, identity, displayName, fetcher=fetch, timeoutMs=10*60_000, pollIntervalMs=1500, signal, onSetup=()=>{} }) {
  const base=validateApiBase(apiBase);
  const session=await createSetupSession({base,identity,displayName,fetcher,signal});
  const setupUrl=addApiBase(session.setupUrl,base);
  onSetup({code:session.setupCode,url:setupUrl,expiresAt:session.expiresAt});
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const status=await requestStatus({base,session,fetcher,signal});
    if(status==='expired')throw new Error('The Cuppet setup code expired. Start remote setup again.');
    if(status==='approved')return claimSetup({base,session,identity,fetcher,signal});
    if(status==='claimed')throw new Error('This Cuppet setup session was already claimed.');
    await wait(pollIntervalMs,signal);
  }
  throw new Error('Timed out waiting for Cuppet approval. Start remote setup again.');
}

async function createSetupSession({base,identity,displayName,fetcher,signal}){
  const response=await fetcher(`${base}/remote/setup/sessions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hostId:identity.hostId,displayName:String(displayName??identity.deviceName??'').slice(0,120),platform:process.platform}),...(signal?{signal}:{})});
  const payload=await readPayload(response);
  if(!response.ok)throw new Error(`Remote setup failed (${response.status}): ${errorMessage(payload)}`);
  for(const key of ['setupId','setupCode','pollSecret','setupUrl','expiresAt'])if(typeof payload[key]!=='string'||!payload[key])throw new Error('Remote setup returned an invalid session.');
  return payload;
}
async function requestStatus({base,session,fetcher,signal}){
  const response=await fetcher(`${base}/remote/setup/sessions/${encodeURIComponent(session.setupId)}/status`,{headers:{authorization:`Bearer ${session.pollSecret}`},...(signal?{signal}:{})});
  const payload=await readPayload(response); if(!response.ok)throw new Error(`Remote setup status failed (${response.status}): ${errorMessage(payload)}`);
  if(!['pending','approved','claimed','expired'].includes(payload.status))throw new Error('Remote setup returned an invalid status.');
  return payload.status;
}
async function claimSetup({base,session,identity,fetcher,signal}){
  const response=await fetcher(`${base}/remote/setup/sessions/${encodeURIComponent(session.setupId)}/claim`,{method:'POST',headers:{authorization:`Bearer ${session.pollSecret}`,'content-type':'application/json'},body:JSON.stringify({relaySecret:identity.relaySecret}),...(signal?{signal}:{})});
  const payload=await readPayload(response); if(!response.ok)throw new Error(`Remote setup claim failed (${response.status}): ${errorMessage(payload)}`);
  if(typeof payload.relayUrl!=='string'||!payload.relayUrl||payload.relayRegistered!==true)throw new Error('Remote setup did not return a registered relay.');
  return {relayUrl:payload.relayUrl,relayRegistered:true,...(typeof payload.remoteTokenPublicKey==='string'?{remoteTokenPublicKey:payload.remoteTokenPublicKey}:{})};
}
async function readPayload(response){const payload=await response.json().catch(()=>({}));return payload&&typeof payload==='object'?payload:{};}
function errorMessage(payload){return typeof payload?.error?.message==='string'?payload.error.message:'unexpected server response';}
function addApiBase(setupUrl,apiBase){const url=new URL(setupUrl);url.searchParams.set('api',apiBase.replace(/\/$/,''));return url.toString();}
function wait(ms,signal){if(signal?.aborted)return Promise.reject(signal.reason??abortError());return new Promise((resolve,reject)=>{const timer=setTimeout(done,Math.max(0,ms));const onAbort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);reject(signal?.reason??abortError());};function done(){signal?.removeEventListener('abort',onAbort);resolve();}signal?.addEventListener('abort',onAbort,{once:true});});}
function abortError(){const error=new Error('Remote setup cancelled.');error.name='AbortError';return error;}
