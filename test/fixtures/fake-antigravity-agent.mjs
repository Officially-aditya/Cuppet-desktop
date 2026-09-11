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
process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'fake-antigravity' }) + '\n');
process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Plan ' } }) + '\n');
process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'ready.' } }) + '\n');
process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Plan ready.', usage: { input_tokens: 11, output_tokens: 3, thinking_tokens: 2, cache_read_tokens: 4, total_tokens: 14 } } }) + '\n');
