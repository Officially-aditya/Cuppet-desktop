import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

export class LocalTransformersEmbeddingProvider {
  #cacheDir; #localModelPath; #allowModelDownload; #loadTransformers; #extractor;
  constructor({ modelID = process.env.CUPPET_PE3_EMBED_MODEL ?? DEFAULT_MODEL_ID, cacheDir = process.env.CUPPET_PE3_MODEL_CACHE ?? join(homedir(),'.cache','cuppet','transformers'), localModelPath = process.env.CUPPET_PE3_MODEL_DIR, allowModelDownload = process.env.CUPPET_PE3_ALLOW_MODEL_DOWNLOAD !== '0', loadTransformers = defaultLoader } = {}) { this.modelID=modelID; this.#cacheDir=cacheDir; this.#localModelPath=localModelPath; this.#allowModelDownload=allowModelDownload; this.#loadTransformers=loadTransformers; }
  async embed(text) { const normalized=String(text).trim(); if(!normalized)throw new Error('cannot embed an empty task description'); const extractor=await this.#getExtractor(); const output=await extractor(normalized,{pooling:'mean',normalize:true}); const data=isArrayLike(output)?output:output?.data; if(!data?.length)throw new Error('local embedding model returned no values'); return Float32Array.from(data); }
  #getExtractor(){if(this.#extractor)return this.#extractor;const pending=this.#createExtractor();this.#extractor=pending;void pending.catch(()=>{if(this.#extractor===pending)this.#extractor=undefined;});return pending;}
  async #createExtractor(){const transformers=await this.#loadTransformers();transformers.env.allowLocalModels=true;transformers.env.allowRemoteModels=this.#allowModelDownload;transformers.env.cacheDir=this.#cacheDir;if(this.#localModelPath)transformers.env.localModelPath=this.#localModelPath;return transformers.pipeline('feature-extraction',this.modelID,{device:'cpu'});}
}
async function defaultLoader(){const moduleName='@huggingface/transformers';return import(moduleName);}
function isArrayLike(value){return Boolean(value)&&typeof value==='object'&&Number.isFinite(value.length)&&value.length>=0;}
