import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = (path) => readFile(join(root, path), 'utf8');
const [pkgText, main, index, entry, controls, app, chat, sidebar, search, settings, remote, permission, question] = await Promise.all([
  read('package.json'),
  read('src/main/main.mjs'),
  read('src/renderer/index.html'),
  read('src/renderer/main.tsx'),
  read('src/renderer/controls.css'),
  read('src/renderer/react/App.tsx'),
  read('src/renderer/react/ChatPane.tsx'),
  read('src/renderer/react/Sidebar.tsx'),
  read('src/renderer/react/SearchModal.tsx'),
  read('src/renderer/react/SettingsModal.tsx'),
  read('src/renderer/react/RemoteModal.tsx'),
  read('src/renderer/react/PermissionModal.tsx'),
  read('src/renderer/react/QuestionModal.tsx'),
]);
const pkg = JSON.parse(pkgText);

assert.equal(pkg.dependencies && Object.keys(pkg.dependencies).length, 0, 'React/Vite must stay build-time only so packaged runtime has no npm production dependencies');
for (const dependency of ['react','react-dom','vite','typescript','@vitejs/plugin-react','qrcode']) assert.ok(pkg.devDependencies?.[dependency], `renderer build dependency missing: ${dependency}`);
assert.equal(pkg.scripts?.['renderer:verify'], 'tsc --noEmit && vite build && node scripts/verify-renderer.mjs');
assert.ok(pkg.build.files.includes('dist-renderer/**/*'), 'compiled Vite renderer is not packaged');
assert.ok(!pkg.build.files.includes('src/renderer/**/*'), 'raw renderer source must not be packaged');
assert.match(main, /dist-renderer.*index\.html/s, 'Electron does not load compiled Vite renderer');
assert.doesNotMatch(main, /join\(here, '\.\.', 'renderer', 'index\.html'\)/, 'Electron still loads legacy renderer source');
assert.match(index, /id="root"/);
assert.match(index, /type="module"\s+src="(?:\.\/)?main\.tsx"/, 'Vite mount shell does not load the TypeScript entry');
assert.doesNotMatch(index, /app\.js|commands\.js|remote\.js|d1-navigation\.js|execution-ui\.mjs/);
assert.match(entry, /createRoot/);
assert.match(entry, /<App\s*\/>/);
assert.match(entry, /import '\.\/controls\.css'/, 'app-wide control skin is not loaded by the React renderer');
assert.match(controls, /-webkit-appearance:none/, 'native Chromium/macOS form appearance is not disabled');
assert.match(controls, /input\[type="checkbox"\].*input\[type="radio"\]/s, 'checkbox/radio controls are not custom skinned');
assert.match(controls, /select\{[\s\S]*background-image:/, 'select controls do not use custom Cuppet chrome');
assert.match(controls, /\.composer textarea/, 'chat composer textarea is not covered by the app-wide control skin');

assert.match(app, /if \((?:value|trimmed)\.startsWith\('\/'\)\)/, 'slash commands are not handled by the single React send path');
assert.match(app, /window\.cuppet\.commands\.execute/, 'React command path does not use the bounded preload command API');
assert.match(app, /const result = await window\.cuppet\.sessions\.send/, 'normal prompt send path missing');
assert.match(app, /sessions\.send\(session\.id, value, attachments\)/, 'composer attachments are not forwarded through the bounded session send path');
assert.match(app, /onNewProjectChat=\{\(projectId\) => startDraft\(projectId\)\}/, 'project hover new-chat action does not create a project-bound draft');
assert.match(app, /result\?\.sessionId/, 'React send path does not follow PE3-selected target sessions');
assert.match(app, /event\.type === 'pe3\.routed'/, 'React event path does not follow PE3 routing');
assert.match(chat, /currentSlashQuery/, 'typed slash palette activation missing');
assert.match(chat, /ArrowDown|ArrowUp/, 'slash palette keyboard navigation missing');
assert.match(chat, /aria-label=.*Send/s, 'arrow send action missing');
assert.match(chat, /aria-label="Attach files"/, 'composer attachment action missing');
assert.match(chat, /type="file"\s+multiple/, 'composer attachment action is not backed by the native OS file picker');
assert.match(chat, /composer-attachments/, 'selected attachment chips missing');
assert.match(chat, /data-message-id=\{message\.id\}/, 'messages are not addressable for exact search navigation');
assert.match(search, /sessions\.search/, 'React local search missing');
assert.match(search, /sessions\.restore/, 'React archived-search recovery missing');
assert.match(search, /focusMessage\(result\.itemId\)/, 'exact matching message navigation missing');
assert.match(search, /scrollIntoView/, 'exact message search result does not scroll into view');
assert.match(sidebar, /project-new-chat-button/, 'project hover new-chat button missing');
assert.match(sidebar, /New chat in \$\{project\.name\}/, 'project hover new-chat action is not labelled per project');
assert.match(sidebar, /Remove project/, 'project hamburger remove action missing');
assert.doesNotMatch(sidebar, /Remove registration/, 'legacy remove-registration wording returned');
assert.match(sidebar, /SIDEBAR_WIDTH_KEY/, 'resizable sidebar persistence missing');
assert.match(settings, /Account/);
assert.match(settings, /Personalisation/);
assert.match(settings, /Token usage/);
assert.match(settings, /Connected devices/);
assert.match(settings, /OpenRouter|presets\.map/, 'provider preset selector missing');
assert.match(settings, /Continue with ChatGPT/, 'Codex subscription connection UI missing');
assert.match(settings, /API key/, 'API-key provider credential UI missing');
assert.doesNotMatch(settings, /provider-base-url|provider-model|primary-effort/, 'advanced provider endpoint/model fields returned to the React UI');
assert.match(remote, /remote\.start/);
assert.match(remote, /remote\.stop/);
assert.match(remote, /QRCode\.toDataURL/, 'Remote pairing QR is not rendered locally');
assert.match(remote, /Connected to \{activeDevice\?\.name/, 'Remote active session does not show the authenticated device name');
assert.match(remote, /deviceConnected|activeDevice/, 'Remote UI does not distinguish an authenticated device from relay connectivity');
assert.doesNotMatch(remote, /remote\.revoke|remote\.devices|Paired devices|New code|Start remote/, 'Remote modal returned to device-management/start-stop plumbing instead of the pairing-or-session flow');
assert.doesNotMatch(remote, /relayUrl|apiBase|viewer/, 'consumer Remote UI exposes advanced relay/API/viewer configuration');
assert.match(permission, /onResolve/);
assert.match(permission, /Enable guarded auto/);
assert.match(question, /onAnswer/);

const deadControllers = [
  'src/renderer/app.js','src/renderer/commands.js','src/renderer/d1-navigation.js','src/renderer/execution-ui.mjs',
  'src/renderer/permissions.js','src/renderer/questions.js','src/renderer/remote.js','src/renderer/settings-hub.js',
  'src/renderer/sidebar-resize.js','src/renderer/undo.js',
];
for (const path of deadControllers) await assert.rejects(access(join(root, path)), { code: 'ENOENT' }, `legacy DOM controller still exists: ${path}`);

console.log('Renderer gate passed: React/Vite/TypeScript owns the desktop surface, the app-wide Cuppet control skin replaces native macOS form chrome, slash dispatch is single-path, project-scoped new chat and composer attachments are wired, Remote is pairing-or-active-session only, D1 exact search navigation is preserved, and legacy DOM controllers are absent.');
