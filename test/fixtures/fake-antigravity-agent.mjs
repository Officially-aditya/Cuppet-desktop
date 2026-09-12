const args = process.argv.slice(2);
const required = ['--mode=plan', '--sandbox', '--output-format', 'stream-json'];
for (const flag of required) {
  if (!args.includes(flag)) {
    process.stderr.write(`missing ${flag}\n`);
    process.exit(2);
  }
}
if (args.includes('--dangerously-skip-permissions')) {
  process.stderr.write('unsafe permission bypass present\n');
  process.exit(3);
}

const modelIndex = args.indexOf('--model');
const selectedModel = modelIndex >= 0 ? args[modelIndex + 1] : '';
const effortIndex = args.indexOf('--effort');
const selectedEffort = effortIndex >= 0 ? args[effortIndex + 1] : '';

if (selectedModel === 'fake-requires-effort' && selectedEffort !== 'high') {
  process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '', error: 'model fake-requires-effort requires --effort high', usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } } }) + '\n');
  process.exit(1);
}

if (selectedModel === 'error-model') {
  process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '', error: 'invalid model selection: error-model is unavailable', usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } } }) + '\n');
  process.exit(1);
}

process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'fake-antigravity' }) + '\n');
process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Plan ' } }) + '\n');
process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'ready.' } }) + '\n');
process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Plan ready.', usage: { input_tokens: 11, output_tokens: 3, thinking_tokens: 2, cache_read_tokens: 4, total_tokens: 14 } } }) + '\n');
