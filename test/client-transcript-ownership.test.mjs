import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const chatPane = await readFile(new URL('../src/renderer/react/ChatPane.tsx', import.meta.url), 'utf8');
const clientTranscript = await readFile(new URL('../src/renderer/react/client-transcript.ts', import.meta.url), 'utf8');

test('ChatPane consumes transcript state without owning runtime event reduction', () => {
  assert.match(chatPane, /const transcript = useClientTranscript\(session\)/);
  assert.doesNotMatch(chatPane, /useState<TranscriptState>/);
  assert.doesNotMatch(chatPane, /setTranscript\(/);
  assert.doesNotMatch(chatPane, /window\.cuppet\.onEvent/);
  assert.doesNotMatch(chatPane, /hydrateTranscript\(/);
  assert.doesNotMatch(chatPane, /reduceTranscriptEvent\(/);
});

test('client transcript store owns one external subscription and durable/live merge', () => {
  assert.match(clientTranscript, /useSyncExternalStore/);
  assert.match(clientTranscript, /window\.cuppet\.onEvent/);
  assert.match(clientTranscript, /hydrateTranscript\(activities\)/);
  assert.match(clientTranscript, /mergeTranscriptState\(current, durable\)/);
  assert.match(clientTranscript, /reduceTranscriptEvent\(current,/);
  assert.match(clientTranscript, /if \(!listeners\.size\) releaseRuntimeSubscription\(\)/);
});
