import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadModule } from './helpers/load-tsx.mjs';

const form = loadModule(fileURLToPath(new URL('../src/renderer/react/mcp-form.ts', import.meta.url)));
const { McpPanel } = loadModule(fileURLToPath(new URL('../src/renderer/react/McpPanel.tsx', import.meta.url)));

const server = (overrides = {}) => ({ id: 'files', name: 'Files', command: 'npx', args: ['-y', 'pkg', '/my folder'], enabled: true, envKeys: ['TOKEN'], status: null, ...overrides });

test('the form turns lines into arguments, trims, and drops blank lines', () => {
  const payload = form.payloadFromForm({ ...form.emptyForm(), name: ' Files ', command: ' npx ', args: ' -y \r\n\r\n@scope/pkg\n   \n/my folder with spaces ' });
  assert.equal(payload.name, 'Files');
  assert.equal(payload.command, 'npx');
  assert.deepEqual(payload.args, ['-y', '@scope/pkg', '/my folder with spaces']);
  assert.equal('id' in payload, false, 'a new server has no id');
  assert.equal(payload.enabled, true);
});

test('editing never needs the stored secret: unchanged rows are sent as null, new text replaces, removed rows disappear', () => {
  const existing = form.formFromServer(server({ envKeys: ['KEEP', 'REPLACE', 'DROP'] }));
  assert.equal(existing.id, 'files');
  assert.deepEqual(existing.env.map((row) => [row.name, row.value, row.saved]), [['KEEP', '', true], ['REPLACE', '', true], ['DROP', '', true]]);

  const edited = {
    ...existing,
    env: [
      existing.env[0],
      { ...existing.env[1], value: 'new-secret' },
      // DROP row removed by the user
      { ...form.newEnvRow('ADDED'), value: 'fresh' },
      form.newEnvRow('EMPTY_NEW'),
      form.newEnvRow('   '),
    ],
  };
  assert.deepEqual(form.payloadFromForm(edited).env, { KEEP: null, REPLACE: 'new-secret', ADDED: 'fresh', EMPTY_NEW: '' });
  assert.equal(form.payloadFromForm(edited).id, 'files');
});

test('env rows get distinct keys so React can track them while editing', () => {
  const keys = new Set([form.newEnvRow().key, form.newEnvRow().key, form.newEnvRow().key]);
  assert.equal(keys.size, 3);
});

test('status presentation explains each state in plain words', () => {
  const ready = (toolCount, message = '') => server({ status: { id: 'files', name: 'Files', state: 'ready', message, toolCount, tools: [] } });
  assert.deepEqual(form.statusPresentation(server({ enabled: false })), { label: 'Disabled', tone: 'muted', detail: '' });
  assert.equal(form.statusPresentation(server()).label, 'Checking…');
  assert.deepEqual(form.statusPresentation(ready(1)), { label: 'Running · 1 tool', tone: 'ready', detail: '' });
  assert.equal(form.statusPresentation(ready(12)).label, 'Running · 12 tools');
  assert.equal(form.statusPresentation(ready(0, 'This server does not provide tools.')).detail, 'This server does not provide tools.');
  const failing = form.statusPresentation(server({ status: { id: 'files', name: 'Files', state: 'error', message: 'Command not found: "npx".', toolCount: 0, tools: [] } }));
  assert.deepEqual(failing, { label: 'Error', tone: 'warning', detail: 'Command not found: "npx".' });
  assert.equal(form.statusPresentation(server({ status: { id: 'files', name: 'Files', state: 'starting', message: '', toolCount: 0, tools: [] } })).label, 'Starting…');
  assert.equal(form.statusPresentation(server({ status: { id: 'files', name: 'Files', state: 'stopped', message: '', toolCount: 0, tools: [] } })).label, 'Stopped');
});

test('runtime status events update servers in place and leave unknown ones alone', () => {
  const servers = [server(), server({ id: 'other', name: 'Other' })];
  const merged = form.mergeStatuses(servers, [{ id: 'files', name: 'Files', state: 'ready', message: '', toolCount: 2, tools: [] }, { id: 'gone', name: 'Gone', state: 'error', message: '', toolCount: 0, tools: [] }]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].status.toolCount, 2);
  assert.equal(merged[1].status, null, 'a server with no status in the event keeps what it had');
});

test('command line display is a plain join and never invokes anything', () => {
  assert.equal(form.commandLine(server()), 'npx -y pkg /my folder');
});

test('Electron error prefixes are removed so users see only the validation message', () => {
  assert.equal(form.cleanErrorMessage(new Error("Error invoking remote method 'cuppet:mcp:save': McpConfigError: Command is required.")), 'Command is required.');
  assert.equal(form.cleanErrorMessage(new Error("Error invoking remote method 'cuppet:mcp:save': Error: An MCP server named \"x\" already exists.")), 'An MCP server named "x" already exists.');
  assert.equal(form.cleanErrorMessage('plain'), 'plain');
  assert.equal(form.cleanErrorMessage(new Error('')), 'Something went wrong.');
});

test('the panel renders its first frame without touching the main process', () => {
  const html = renderToStaticMarkup(createElement(McpPanel));
  assert.match(html, /<h3>MCP servers<\/h3>/);
  assert.match(html, /Loading…/);
  assert.match(html, /Cuppet asks before every tool call/);
  assert.match(html, /outside the command sandbox/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Add server<\/button>/, 'adding is disabled until settings have loaded');
});
