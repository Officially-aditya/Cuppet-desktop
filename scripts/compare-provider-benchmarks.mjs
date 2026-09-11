import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compareBenchmarkSuites } from '../src/runtime/execution/benchmark.mjs';

const [, , baselinePath, optimizedPath] = process.argv;
if (!baselinePath || !optimizedPath) {
  console.error('Usage: node scripts/compare-provider-benchmarks.mjs <raw-baseline.json|jsonl> <optimized.json|jsonl>');
  process.exitCode = 2;
} else {
  const [baseline, optimized] = await Promise.all([
    readRecords(resolve(baselinePath)),
    readRecords(resolve(optimizedPath)),
  ]);
  const result = compareBenchmarkSuites({ baseline, optimized });
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}

async function readRecords(path) {
  const source = (await readFile(path, 'utf8')).trim();
  if (!source) return [];
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.records)) return parsed.records;
    return [parsed];
  } catch {
    return source.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); }
      catch (error) { throw new Error(`${path}:${index + 1}: invalid JSONL (${error.message})`); }
    });
  }
}
