const DEFAULT_DIMENSIONS = 512;
const MAX_TEXT_CHARS = 16_384;
const MAX_TOKENS = 512;

/**
 * Dependency-free local feature embedding used only for PE3's conservative
 * ambiguity breaker. It is intentionally lexical/subword rather than a claim
 * of neural semantic equivalence: deterministic task affinity and TST remain
 * the higher-authority routing signals, and low-confidence results preserve
 * the active task.
 */
export class LocalFeatureEmbeddingProvider {
  modelID = 'cuppet/subword-hash-v1';
  #dimensions;

  constructor({ dimensions = DEFAULT_DIMENSIONS } = {}) {
    const requested = Number(dimensions);
    this.#dimensions = Number.isInteger(requested) && requested >= 128 && requested <= 4096
      ? nextPowerOfTwo(requested)
      : DEFAULT_DIMENSIONS;
  }

  async embed(text) {
    const normalized = normalizeText(text);
    if (!normalized) throw new Error('cannot embed an empty task description');
    const tokens = normalized.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, MAX_TOKENS) ?? [];
    if (!tokens.length) throw new Error('task description contains no embeddable tokens');

    const vector = new Float32Array(this.#dimensions);
    const counts = new Map();
    const add = (feature, weight) => {
      if (!feature) return;
      const count = counts.get(feature) ?? 0;
      counts.set(feature, count + 1);
      // Damp repeated boilerplate while retaining a stable contribution.
      const scaled = weight / Math.sqrt(count + 1);
      const hash = fnv1a(feature);
      const index = hash & (this.#dimensions - 1);
      const sign = hash & 0x80000000 ? -1 : 1;
      vector[index] += sign * scaled;
    };

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      add(`w:${token}`, 2.4);
      if (index > 0) add(`b:${tokens[index - 1]}\u0001${token}`, 1.4);
      if (index > 1) add(`t:${tokens[index - 2]}\u0001${tokens[index - 1]}\u0001${token}`, 0.7);
      for (const gram of subwordGrams(token)) add(`g:${gram}`, 0.42);
    }

    // Order-insensitive task vocabulary helps fingerprints remain stable when
    // descriptors are rewritten but still discuss the same identifiers.
    const unique = [...new Set(tokens)].sort().slice(0, 96);
    for (let index = 1; index < unique.length; index += 1) add(`u:${unique[index - 1]}\u0001${unique[index]}`, 0.35);

    normalize(vector);
    return vector;
  }
}

export const LOCAL_EMBEDDING_MODEL_ID = 'cuppet/subword-hash-v1';

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

function subwordGrams(token) {
  const source = `^${token}$`;
  const output = [];
  for (const size of [3, 4]) {
    if (source.length < size) continue;
    for (let index = 0; index <= source.length - size && output.length < 48; index += 1) output.push(source.slice(index, index + size));
  }
  return output;
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalize(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (!(norm > 0)) throw new Error('local feature embedding produced a zero vector');
  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < vector.length; index += 1) vector[index] *= scale;
}

function nextPowerOfTwo(value) {
  let result = 1;
  while (result < value && result < 4096) result <<= 1;
  return result;
}
