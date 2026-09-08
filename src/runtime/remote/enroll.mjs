import { hostname } from 'node:os';

export async function registerHost({ apiBase, token, identity, relaySecret, displayName, fetcher=fetch }) {
  const base=validateApiBase(apiBase);
  if(typeof token!=='string'||!token)throw new Error('A Cuppet session token is required for enrollment.');
  if(typeof relaySecret!=='string'||relaySecret.length<32)throw new Error('relay secret must be at least 32 characters');
  const response=await fetcher(`${base}/remote/hosts`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({hostId:identity.hostId,displayName:String(displayName??identity.deviceName??hostname()).trim().slice(0,120),platform:process.platform,relaySecret})});
  if(response.status===409)throw new Error('This machine is already registered to a different Cuppet account.');
  if(!response.ok){const body=await response.text().catch(()=>'');throw new Error(`Enrollment failed (${response.status}): ${body.slice(0,300)||response.statusText}`);}
  const payload=await response.json().catch(()=>({}));
  return { ...(typeof payload.relayUrl==='string'?{relayUrl:payload.relayUrl}:{}), relayRegistered:payload.relayRegistered===true, ...(typeof payload.remoteTokenPublicKey==='string'?{remoteTokenPublicKey:payload.remoteTokenPublicKey}:{}) };
}

export function validateApiBase(value){
  const url=new URL(String(value??''));
  if(!['http:','https:'].includes(url.protocol))throw new Error('apiBase must use http(s)');
  url.pathname=url.pathname.replace(/\/$/,''); url.search=''; url.hash='';
  return url.toString().replace(/\/$/,'');
}
