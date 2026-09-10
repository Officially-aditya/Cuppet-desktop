import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [app,chat]=await Promise.all([readFile(new URL('../src/renderer/react/App.tsx',import.meta.url),'utf8'),readFile(new URL('../src/renderer/react/ChatPane.tsx',import.meta.url),'utf8')]);
test('React running composer exposes explicit queue and steer paths',()=>{assert.match(chat,/setDeliveryMode\('queue'\)/);assert.match(chat,/setDeliveryMode\('steer'\)/);assert.match(app,/cuppet\.steer\.interrupt/);assert.match(app,/window\.cuppet\.sessions\.send/);assert.match(app,/queue\.queued/);assert.match(app,/queue\.dispatched/);});
test('React activity surface consumes tool and validation events',()=>{assert.match(app,/tool\.started/);assert.match(app,/tool\.finished/);assert.match(app,/validation\.completed/);assert.match(chat,/ActivityPanel/);assert.match(chat,/Agent activity/);});
