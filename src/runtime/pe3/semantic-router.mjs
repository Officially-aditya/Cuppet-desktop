import { taskFingerprintText } from './task-agents.mjs';

export const DEFAULT_SEMANTIC_THRESHOLDS = { activeContinueMin: .52, dormantMatchMin: .60, dormantActiveMargin: .10, dormantRunnerUpMargin: .04, noveltyMax: .34 };

export class SemanticTaskRouter {
  #provider; #thresholds; #cache = new Map(); #now;
  constructor(provider, thresholds = {}, { now = Date.now } = {}) { this.#provider = provider; this.#thresholds = { ...DEFAULT_SEMANTIC_THRESHOLDS, ...thresholds }; this.#now = now; }
  get modelID() { return this.#provider.modelID; }
  get thresholds() { return { ...this.#thresholds }; }
  async decide(prompt, active, dormant = []) {
    const started = this.#now(); let promptEmbeddingCount = 0, agentEmbeddingCount = 0;
    try {
      const promptVector = await this.#provider.embed(String(prompt)); promptEmbeddingCount = 1; ensureVector(promptVector);
      const activeResult = await this.#taskVector(active); if (activeResult.created) agentEmbeddingCount++; const activeSimilarity = cosineSimilarity(promptVector, activeResult.vector);
      const scores = [];
      for (const agent of dormant) { const result = await this.#taskVector(agent); if (result.created) agentEmbeddingCount++; scores.push({ agent, similarity: cosineSimilarity(promptVector, result.vector) }); }
      scores.sort((a,b)=>b.similarity-a.similarity||b.agent.lastActiveAt-a.agent.lastActiveAt); const best=scores[0], runnerUp=scores[1];
      if (best && best.similarity >= this.#thresholds.dormantMatchMin && best.similarity-activeSimilarity >= this.#thresholds.dormantActiveMargin && best.similarity-(runnerUp?.similarity??-1) >= this.#thresholds.dormantRunnerUpMargin) return result('reactivate',{agent:best.agent,reason:'semantic task fingerprint decisively matches a dormant agent',confidence:Math.min(best.similarity,best.similarity-activeSimilarity+.5),activeSimilarity,best,runnerUp,promptEmbeddingCount,agentEmbeddingCount,started,modelID:this.modelID});
      if (activeSimilarity >= this.#thresholds.activeContinueMin) return result('continue',{reason:'semantic task fingerprint supports the active agent',confidence:activeSimilarity,activeSimilarity,best,runnerUp,promptEmbeddingCount,agentEmbeddingCount,started,modelID:this.modelID});
      const bestKnown = Math.max(activeSimilarity,best?.similarity??-1);
      if (bestKnown <= this.#thresholds.noveltyMax) return result('create',{reason:'semantic novelty is low against every known task agent',confidence:1-bestKnown,activeSimilarity,best,runnerUp,promptEmbeddingCount,agentEmbeddingCount,started,modelID:this.modelID});
      return result('continue',{reason:'semantic evidence is low-confidence; preserve the active task',confidence:activeSimilarity,activeSimilarity,best,runnerUp,promptEmbeddingCount,agentEmbeddingCount,started,modelID:this.modelID,fallback:true});
    } catch (error) {
      return { action:'continue', reason:'semantic routing unavailable; deterministic fallback preserves the active task', confidence:0, modelID:this.modelID, activeSimilarity:0, promptEmbeddingCount, agentEmbeddingCount, embeddingLatencyMs:Math.max(0,this.#now()-started), fallback:true, error:error instanceof Error?error.message:String(error) };
    }
  }
  clear(agentID) { if (agentID) this.#cache.delete(agentID); else this.#cache.clear(); }
  async #taskVector(agent) { const signature=[agent.fingerprint.revision,agent.cacheEpoch,agent.workspaceEpoch,agent.taskDescriptor].join(':'); const cached=this.#cache.get(agent.id); if(cached?.signature===signature)return{vector:cached.vector,created:false}; const vector=await this.#provider.embed(taskFingerprintText(agent)||agent.taskDescriptor||`task session ${agent.sessionID}`); ensureVector(vector); this.#cache.set(agent.id,{signature,vector}); return{vector,created:true}; }
}

export function cosineSimilarity(left,right){if(!(left instanceof Float32Array)||!(right instanceof Float32Array)||!left.length||left.length!==right.length)throw new Error('embedding dimension mismatch');let dot=0,aNorm=0,bNorm=0;for(let i=0;i<left.length;i++){const a=left[i],b=right[i];if(!Number.isFinite(a)||!Number.isFinite(b))throw new Error('embedding vector has non-finite value');dot+=a*b;aNorm+=a*a;bNorm+=b*b;}if(aNorm<=0||bNorm<=0)throw new Error('embedding vector has zero norm');return dot/Math.sqrt(aNorm*bNorm);}
function ensureVector(vector){if(!(vector instanceof Float32Array)||!vector.length)throw new Error('embedding provider returned an empty vector');for(const value of vector)if(!Number.isFinite(value))throw new Error('embedding provider returned a non-finite vector');}
function result(action,{agent,reason,confidence,activeSimilarity,best,runnerUp,promptEmbeddingCount,agentEmbeddingCount,started,modelID,fallback=false}){return{action,...(agent?{agent:clone(agent)}:{}),reason,confidence:Math.max(0,Math.min(1,confidence)),modelID,activeSimilarity,...(best?{bestDormantSimilarity:best.similarity}:{}),...(runnerUp?{runnerUpDormantSimilarity:runnerUp.similarity}:{}),promptEmbeddingCount,agentEmbeddingCount,embeddingLatencyMs:Math.max(0,Date.now()-started),fallback};}
function clone(agent){return{...agent,activePaths:[...agent.activePaths],touchedPaths:[...agent.touchedPaths],recentSymbols:[...agent.recentSymbols],terms:[...agent.terms],stalePaths:[...agent.stalePaths],fingerprint:{revision:agent.fingerprint.revision,paths:agent.fingerprint.paths.map((s)=>({...s})),symbols:agent.fingerprint.symbols.map((s)=>({...s})),terms:agent.fingerprint.terms.map((s)=>({...s}))}};}
