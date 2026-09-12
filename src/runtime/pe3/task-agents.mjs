const MAX_TERMS = 32;
const MAX_PATHS = 16;
const MAX_SYMBOLS = 16;
const MAX_DESCRIPTOR_BYTES = 320;
const FINGERPRINT_DECAY = 0.96;
const MIN_FINGERPRINT_WEIGHT = 0.08;
const SHORT_FOLLOW_UP_WORDS = 10;

const PATH_TOKEN = /(?:\.?\.?\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_.@-]+\.(?:ts|tsx|js|jsx|rs|py|go|java|json|md|yaml|yml|toml|css|html)/g;
const CONTINUATION_CUES = ['also','that','those','the previous','same task','same issue','continue','keep going','update the tests','fix the tests','what about'];
const RETURN_CUES = ['go back to','return to','back to','resume the','resume that','previous task','earlier task'];
const FOLLOW_UP_CUES = ['try again','before answering','actual files','check the actual','look at the actual',"isn't helping",'isnt helping',"doesn't answer",'doesnt answer','you missed','be specific','based on that','based on this','from your last','from the previous','what do you mean','which ones','show me those','show me these'];
const CONTEXT_REFERENCE = /\b(?:this|that|these|those|it|them|they|same|above|previous|earlier|again)\b/;
const FOLLOW_UP_PREFIX = /^(?:yeah|yes|yep|no|nope|okay|ok|right|wait|but|actually)\b/;
const QUESTION_PREFIX = /^(?:what|why|how|which|where|when|who|can|could|would|should|did|does|do|is|are|was|were)\b/;
const EXPLICIT_SWITCH = /^(?:new task\b|separate task\b|unrelated(?: task)?\b|switch (?:tasks?|to)\b|move on to\b|let(?:'s| us) move on to\b)/;
const TASK_ACTION = /\b(?:implement|build|add|create|remove|delete|migrate|refactor|debug|investigate|research|audit|design|write|test|optimize|upgrade|replace|rename|configure|integrate|fix|review|analyze|analyse|inspect|check|update|compare|benchmark|document|trace|profile)\b/;
const STOP_TERMS = new Set(['about','after','again','also','and','are','been','before','build','can','change','code','could','create','does','doing','file','files','fix','for','from','have','here','into','issue','just','make','more','need','now','please','should','task','that','the','their','then','there','these','they','this','those','update','use','using','want','what','when','where','which','with','work','working','would','you']);

const SOURCE_STRENGTH = { prompt: 0, localized: 1, active: 2, symbol: 2, touched: 3 };

export class TaskAgentRouter {
  #agents = new Map(); #activeID; #workspaceEpoch = 0; #now;
  constructor({ now = Date.now } = {}) { this.#now = now; }
  get active() { return this.#activeID ? cloneAgent(this.#agents.get(this.#activeID)) : undefined; }
  list() { return [...this.#agents.values()].sort((a,b)=>b.lastActiveAt-a.lastActiveAt).map(cloneAgent); }
  checkpoint() { return { agents: this.list(), activeID: this.#activeID, workspaceEpoch: this.#workspaceEpoch }; }
  restoreCheckpoint(checkpoint = {}) { this.#agents.clear(); for (const agent of checkpoint.agents ?? []) this.restore(agent); this.#workspaceEpoch = nonNegative(checkpoint.workspaceEpoch); this.#activeID = checkpoint.activeID && this.#agents.has(checkpoint.activeID) ? checkpoint.activeID : undefined; }
  register(sessionID, prompt = '', evidence = {}) {
    const id = agentID(sessionID); const existing = this.#agents.get(id);
    if (existing) { this.#activeID = id; if (prompt.trim()) this.recordTurn(prompt, evidence); return cloneAgent(existing); }
    const now = this.#now();
    const state = { id, sessionID, taskDescriptor: bounded(prompt, MAX_DESCRIPTOR_BYTES), activePaths: boundedUnique(normalizePaths(evidence.activePaths ?? extractPaths(prompt)), MAX_PATHS), touchedPaths: boundedUnique(normalizePaths(evidence.touchedPaths ?? []), MAX_PATHS), recentSymbols: boundedUnique(normalizeSymbols(evidence.recentSymbols ?? extractSymbols(prompt)), MAX_SYMBOLS), terms: boundedUnique(extractTerms(prompt), MAX_TERMS), fingerprint: { revision: 0, paths: [], symbols: [], terms: [] }, stalePaths: [], cacheEpoch: 0, workspaceEpoch: Math.max(this.#workspaceEpoch, nonNegative(evidence.workspaceEpoch)), createdAt: now, lastActiveAt: now, turns: prompt.trim() ? 1 : 0 };
    seedFingerprint(state, prompt, evidence, now); this.#agents.set(id, state); this.#activeID = id; return cloneAgent(state);
  }
  restore(state) { const restored = sanitizeAgent(state); this.#agents.set(restored.id, restored); this.#workspaceEpoch = Math.max(this.#workspaceEpoch, restored.workspaceEpoch); return cloneAgent(restored); }
  activate(idOrSession) { const id = String(idOrSession).startsWith('task:') ? idOrSession : agentID(idOrSession); const state = this.#agents.get(id); if (!state) return undefined; this.#activeID = id; state.lastActiveAt = this.#now(); return cloneAgent(state); }
  select(idOrSession) { return this.activate(idOrSession); }
  recordSessionEvidence(sessionID, evidence = {}) { const state = this.#agents.get(agentID(sessionID)); if (!state) return undefined; mergeEvidence(state, evidence, this.#now()); return cloneAgent(state); }
  route(prompt, evidence = {}) {
    const active = this.#activeID ? this.#agents.get(this.#activeID) : undefined;
    if (!active) return { action: 'create', reason: 'no active task agent', affinity: emptyAffinity() };
    mergeEvidence(active, evidence, this.#now());
    const affinity = affinityFor(active, prompt, evidence); const normalized = normalizeText(prompt); const explicitSwitch = isExplicitSwitchPrompt(normalized); const explicitReturn = hasCue(normalized, RETURN_CUES); const dormant = bestDormant(this.#agents, active, prompt, evidence);
    if (explicitReturn && dormant) return { action: 'reactivate', agent: cloneAgent(dormant.agent), reason: 'explicit return language matches a dormant task agent', affinity: dormant.affinity, refreshPaths: [...dormant.agent.stalePaths] };
    if (explicitSwitch) {
      if (dormant) return { action: 'reactivate', agent: cloneAgent(dormant.agent), reason: 'explicit task switch matches a dormant task agent', affinity: dormant.affinity, refreshPaths: [...dormant.agent.stalePaths] };
      return { action: 'create', reason: 'explicit task switch creates a sibling task agent', affinity };
    }
    if (hasCue(normalized, CONTINUATION_CUES)) return { action: 'continue', agent: cloneAgent(active), reason: 'continuation language defaults to the active agent', affinity };
    if (isContextDependentPrompt(normalized)) return { action: 'continue', agent: cloneAgent(active), reason: 'context-dependent follow-up preserves the active agent', affinity };
    if (strongMatch(affinity)) return { action: 'continue', agent: cloneAgent(active), reason: 'active working-set affinity is sufficient', affinity };
    if (strongMismatch(active, prompt, affinity, evidence)) {
      if (dormant) return { action: 'reactivate', agent: cloneAgent(dormant.agent), reason: 'hard workspace mismatch with a matching dormant task agent', affinity: dormant.affinity, refreshPaths: [...dormant.agent.stalePaths] };
      return { action: 'create', reason: 'hard workspace mismatch with no matching dormant agent', affinity };
    }
    if (isLikelyConversationalFollowUp(prompt, normalized)) return { action: 'continue', agent: cloneAgent(active), reason: 'short or elliptical prompt preserves the active agent', affinity };
    return { action: 'continue', agent: cloneAgent(active), reason: 'ambiguous or weak mismatch stays on the active agent', affinity, ...(semanticEligible(prompt, affinity) ? { semanticEligible: true } : {}) };
  }
  recordTurn(prompt, evidence = {}) {
    const active = this.#activeID ? this.#agents.get(this.#activeID) : undefined; if (!active) return undefined;
    const text = String(prompt).trim(); const now = this.#now();
    if (text) {
      decayFingerprint(active.fingerprint);
      const paths = extractPaths(text), symbols = extractSymbols(text), terms = extractTerms(text), normalized = normalizeText(text);
      const establishesTask = active.turns === 0 || !active.taskDescriptor || isSelfContainedTaskPrompt(text, normalized);
      if (establishesTask && (paths.length || symbols.length || terms.length)) active.taskDescriptor = bounded(text, MAX_DESCRIPTOR_BYTES);
      active.activePaths = mergeRecent(active.activePaths, paths, MAX_PATHS); active.recentSymbols = mergeRecent(active.recentSymbols, symbols, MAX_SYMBOLS); active.terms = mergeRecent(active.terms, terms, MAX_TERMS); active.turns += 1;
      mergeSignals(active.fingerprint.paths, paths, .45, 'prompt', MAX_PATHS, now); mergeSignals(active.fingerprint.symbols, symbols, .42, 'prompt', MAX_SYMBOLS, now); mergeSignals(active.fingerprint.terms, terms, .26, 'prompt', MAX_TERMS, now);
    }
    mergeEvidence(active, evidence, now); active.lastActiveAt = now; return cloneAgent(active);
  }
  noteWorkspaceChange(paths) {
    const changed = new Set(normalizePaths(paths)); if (!changed.size) return; this.#workspaceEpoch += 1;
    for (const agent of this.#agents.values()) {
      const privileged = new Set([...agent.activePaths, ...agent.touchedPaths]); const stale = [...changed].filter((path)=>privileged.has(path)); if (!stale.length) continue;
      agent.activePaths = agent.activePaths.filter((path)=>!changed.has(path)); agent.touchedPaths = agent.touchedPaths.filter((path)=>!changed.has(path)); agent.fingerprint.paths = agent.fingerprint.paths.filter((signal)=>!changed.has(signal.value)); agent.stalePaths = mergeRecent(agent.stalePaths, stale, MAX_PATHS); agent.cacheEpoch += 1; agent.workspaceEpoch = this.#workspaceEpoch; agent.fingerprint.revision += 1;
    }
  }
  acknowledgeRefresh(sessionID, paths) { const agent = this.#agents.get(agentID(sessionID)); if (!agent) return; const refreshed = new Set(normalizePaths(paths)); agent.stalePaths = agent.stalePaths.filter((path)=>!refreshed.has(path)); }
}

export function taskFingerprintText(agent) {
  const strongest = (signals, limit) => [...signals].sort((a,b)=>b.weight-a.weight || b.updatedAt-a.updatedAt).slice(0,limit).map((s)=>`${s.value}(${s.weight.toFixed(2)})`);
  return [agent.taskDescriptor ? `task: ${agent.taskDescriptor}` : '', strongest(agent.fingerprint.paths,10).length ? `artifacts: ${strongest(agent.fingerprint.paths,10).join(', ')}` : '', strongest(agent.fingerprint.symbols,10).length ? `symbols: ${strongest(agent.fingerprint.symbols,10).join(', ')}` : '', strongest(agent.fingerprint.terms,16).length ? `terms: ${strongest(agent.fingerprint.terms,16).join(', ')}` : ''].filter(Boolean).join('\n');
}
export function extractRoutingPaths(value) { return extractPaths(value); }
export function normalizeRoutingPath(value) { return normalizePath(value); }

function seedFingerprint(agent, prompt, evidence, now) { mergeSignals(agent.fingerprint.paths, extractPaths(prompt), .45, 'prompt', MAX_PATHS, now); mergeSignals(agent.fingerprint.symbols, extractSymbols(prompt), .42, 'prompt', MAX_SYMBOLS, now); mergeSignals(agent.fingerprint.terms, extractTerms(prompt), .26, 'prompt', MAX_TERMS, now); mergeEvidence(agent, evidence, now); }
function mergeEvidence(agent, evidence, now) {
  const active = normalizePaths(evidence.activePaths ?? []), touched = normalizePaths(evidence.touchedPaths ?? []), localized = normalizePaths(evidence.localizedPaths ?? []), symbols = normalizeSymbols(evidence.recentSymbols ?? []), localizedSymbols = normalizeSymbols(evidence.localizedSymbols ?? []);
  agent.activePaths = mergeRecent(agent.activePaths, active, MAX_PATHS); agent.touchedPaths = mergeRecent(agent.touchedPaths, touched, MAX_PATHS); agent.recentSymbols = mergeRecent(agent.recentSymbols, symbols, MAX_SYMBOLS);
  mergeSignals(agent.fingerprint.paths, localized, .62, 'localized', MAX_PATHS, now); mergeSignals(agent.fingerprint.paths, active, .78, 'active', MAX_PATHS, now); mergeSignals(agent.fingerprint.paths, touched, 1, 'touched', MAX_PATHS, now); mergeSignals(agent.fingerprint.symbols, localizedSymbols, .64, 'localized', MAX_SYMBOLS, now); mergeSignals(agent.fingerprint.symbols, symbols, .84, 'symbol', MAX_SYMBOLS, now);
  if (active.length || touched.length || localized.length || symbols.length || localizedSymbols.length) agent.fingerprint.revision += 1;
  if (evidence.workspaceEpoch !== undefined) agent.workspaceEpoch = Math.max(agent.workspaceEpoch, nonNegative(evidence.workspaceEpoch));
}
function affinityFor(agent, prompt, evidence) {
  const paths = new Set([...extractPaths(prompt), ...normalizePaths(evidence.localizedPaths ?? [])]), symbols = new Set([...extractSymbols(prompt), ...normalizeSymbols(evidence.localizedSymbols ?? [])]), terms = new Set(extractTerms(prompt));
  const agentPaths = new Set(agent.fingerprint.paths.filter((s)=>s.weight>=.35).map((s)=>s.value)), agentSymbols = new Set(agent.fingerprint.symbols.filter((s)=>s.weight>=.35).map((s)=>s.value)), agentTerms = new Set(agent.fingerprint.terms.filter((s)=>s.weight>=.12).map((s)=>s.value));
  const pathOverlap = overlap(paths, agentPaths), symbolOverlap = overlap(symbols, agentSymbols), termOverlap = overlap(terms, agentTerms), lexicalRatio = termOverlap / Math.max(1, Math.min(terms.size, agentTerms.size));
  let weightedOverlap = 0; for (const signal of [...agent.fingerprint.paths,...agent.fingerprint.symbols,...agent.fingerprint.terms]) if (paths.has(signal.value)||symbols.has(signal.value)||terms.has(signal.value)) weightedOverlap += signal.weight;
  const score = Math.min(1, pathOverlap*.48 + symbolOverlap*.28 + Math.min(.24, lexicalRatio*.24) + Math.min(.24, weightedOverlap*.08)); return { score, pathOverlap, symbolOverlap, termOverlap, lexicalRatio, weightedOverlap };
}
function bestDormant(agents, active, prompt, evidence) { return [...agents.values()].filter((a)=>a.id!==active.id).map((agent)=>({agent,affinity:affinityFor(agent,prompt,evidence)})).filter(({affinity})=>affinity.pathOverlap>0||affinity.symbolOverlap>0||affinity.score>=.54).sort((a,b)=>b.affinity.score-a.affinity.score||b.agent.lastActiveAt-a.agent.lastActiveAt)[0]; }
function strongMatch(a) { return a.pathOverlap>0 || a.symbolOverlap>0 || a.weightedOverlap>=1.15 || (a.termOverlap>=2 && a.lexicalRatio>=.55) || a.score>=.58; }
function strongMismatch(active, prompt, affinity, evidence) {
  const paths = [...extractPaths(prompt),...normalizePaths(evidence.localizedPaths??[])];
  const known = new Set(active.fingerprint.paths.filter((s)=>s.weight>=.35).map((s)=>s.value));
  return Boolean(paths.length && known.size && paths.every((p)=>!known.has(p)) && affinity.symbolOverlap===0);
}
function semanticEligible(prompt, affinity) {
  const normalized = normalizeText(prompt);
  return isSelfContainedTaskPrompt(prompt, normalized) && affinity.pathOverlap===0 && affinity.symbolOverlap===0 && affinity.score<.58;
}
function isSelfContainedTaskPrompt(prompt, normalized = normalizeText(prompt)) {
  if (!TASK_ACTION.test(normalized) || isContextDependentPrompt(normalized) || QUESTION_PREFIX.test(normalized)) return false;
  if (extractPaths(prompt).length) return true;
  return wordCount(normalized) > SHORT_FOLLOW_UP_WORDS && extractTerms(prompt).length >= 4;
}
function isLikelyConversationalFollowUp(prompt, normalized = normalizeText(prompt)) {
  if (isContextDependentPrompt(normalized)) return true;
  if (QUESTION_PREFIX.test(normalized) && !extractPaths(prompt).length) return true;
  return wordCount(normalized) <= SHORT_FOLLOW_UP_WORDS && extractPaths(prompt).length === 0;
}
function isContextDependentPrompt(normalized) { return FOLLOW_UP_PREFIX.test(normalized) || CONTEXT_REFERENCE.test(normalized) || hasCue(normalized,FOLLOW_UP_CUES); }
function isExplicitSwitchPrompt(normalized) { return EXPLICIT_SWITCH.test(normalized); }
function wordCount(normalized) { return (String(normalized).match(/[a-z0-9_$.-]+/g) ?? []).length; }
function mergeSignals(target, values, weight, source, limit, now) { for (const value of boundedUnique(values, limit)) { const existing = target.find((s)=>s.value===value); if (existing) { if (weight > existing.weight || SOURCE_STRENGTH[source] >= SOURCE_STRENGTH[existing.source]) { existing.weight = Math.max(existing.weight, weight); existing.source = source; } existing.updatedAt = now; } else target.push({ value, weight, source, updatedAt: now }); } target.sort((a,b)=>b.weight-a.weight||b.updatedAt-a.updatedAt); target.splice(limit); }
function decayFingerprint(fp) { for (const list of [fp.paths,fp.symbols,fp.terms]) { for (const signal of list) if (signal.source==='prompt'||signal.source==='localized') signal.weight*=FINGERPRINT_DECAY; for (let i=list.length-1;i>=0;i--) if (list[i].weight<MIN_FINGERPRINT_WEIGHT) list.splice(i,1); } fp.revision += 1; }
function extractPaths(value) { return boundedUnique((String(value).match(PATH_TOKEN)??[]).map(normalizePath).filter(Boolean), MAX_PATHS); }
function normalizePaths(values) { return boundedUnique([...values].map(normalizePath).filter(Boolean), MAX_PATHS); }
function normalizePath(value) { return String(value).trim().replace(/^[`'"(]+|[`'"),.;:]+$/g,'').replace(/\\/g,'/').replace(/^\.\//,'').replace(/\/+/g,'/'); }
function extractSymbols(value) { return boundedUnique((String(value).match(/\b[A-Za-z_$][\w$]{2,}\b/g)??[]).filter((v)=>/[A-Z_$]|[a-z][A-Z]/.test(v)), MAX_SYMBOLS); }
function normalizeSymbols(values) { return boundedUnique([...values].map((v)=>String(v).trim()).filter(Boolean), MAX_SYMBOLS); }
function extractTerms(value) { return boundedUnique(normalizeText(value).match(/[a-z0-9_$.-]{3,}/g)??[], MAX_TERMS).filter((term)=>!STOP_TERMS.has(term)&&!term.includes('/')); }
function normalizeText(value) { return String(value).toLowerCase().replace(/\s+/g,' ').trim(); }
function hasCue(value,cues){return cues.some((cue)=>value.includes(cue));}
function overlap(a,b){let n=0;for(const value of a)if(b.has(value))n++;return n;}
function emptyAffinity(){return{score:0,pathOverlap:0,symbolOverlap:0,termOverlap:0,lexicalRatio:0,weightedOverlap:0};}
function mergeRecent(left,right,limit){return boundedUnique([...left,...right],limit);}
function boundedUnique(values,limit){const out=[];for(const raw of values){const value=String(raw).trim();if(!value)continue;const i=out.indexOf(value);if(i>=0)out.splice(i,1);out.push(value);if(out.length>limit)out.splice(0,out.length-limit);}return out;}
function bounded(value,maxBytes){const normalized=String(value??'').trim().replace(/\s+/g,' ');if(Buffer.byteLength(normalized)<=maxBytes)return normalized;let end=normalized.length;while(end>0&&Buffer.byteLength(normalized.slice(0,end))>maxBytes)end--;return normalized.slice(0,end);}
function nonNegative(value){const n=Number(value);return Number.isFinite(n)?Math.max(0,Math.trunc(n)):0;}
function agentID(sessionID){return`task:${String(sessionID).slice(0,256)}`;}
function sanitizeAgent(agent){return{...agent,id:agentID(agent.sessionID),sessionID:String(agent.sessionID).slice(0,256),taskDescriptor:bounded(agent.taskDescriptor,MAX_DESCRIPTOR_BYTES),activePaths:boundedUnique(agent.activePaths??[],MAX_PATHS),touchedPaths:boundedUnique(agent.touchedPaths??[],MAX_PATHS),recentSymbols:boundedUnique(agent.recentSymbols??[],MAX_SYMBOLS),terms:boundedUnique(agent.terms??[],MAX_TERMS),fingerprint:{revision:nonNegative(agent.fingerprint?.revision),paths:(agent.fingerprint?.paths??[]).slice(0,MAX_PATHS).map((s)=>({...s,weight:Math.max(0,Math.min(1,Number(s.weight)||0))})),symbols:(agent.fingerprint?.symbols??[]).slice(0,MAX_SYMBOLS).map((s)=>({...s,weight:Math.max(0,Math.min(1,Number(s.weight)||0))})),terms:(agent.fingerprint?.terms??[]).slice(0,MAX_TERMS).map((s)=>({...s,weight:Math.max(0,Math.min(1,Number(s.weight)||0))}))},stalePaths:boundedUnique(agent.stalePaths??[],MAX_PATHS),cacheEpoch:nonNegative(agent.cacheEpoch),workspaceEpoch:nonNegative(agent.workspaceEpoch),createdAt:Number(agent.createdAt)||Date.now(),lastActiveAt:Number(agent.lastActiveAt)||Date.now(),turns:nonNegative(agent.turns)};}
function cloneAgent(agent){if(!agent)return undefined;return{...agent,activePaths:[...agent.activePaths],touchedPaths:[...agent.touchedPaths],recentSymbols:[...agent.recentSymbols],terms:[...agent.terms],stalePaths:[...agent.stalePaths],fingerprint:{revision:agent.fingerprint.revision,paths:agent.fingerprint.paths.map((s)=>({...s})),symbols:agent.fingerprint.symbols.map((s)=>({...s})),terms:agent.fingerprint.terms.map((s)=>({...s}))}};}
