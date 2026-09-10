import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = (path) => readFile(join(root, path), 'utf8');
const [pkgText, main, codexAuth, providerSettings, providerPresets, customModels, preload, index, entry, controls, reactCss, settingsCss, usageCss, composerCss, selectControl, modelPicker, app, chat, sidebar, search, settings, newChat, remote, permission, question] = await Promise.all([
  read('package.json'),
  read('src/main/main.mjs'),
  read('src/main/codex-auth.mjs'),
  read('src/main/provider-settings.mjs'),
  read('src/main/provider-presets.mjs'),
  read('src/main/custom-models.mjs'),
  read('src/preload/preload.cjs'),
  read('src/renderer/index.html'),
  read('src/renderer/main.tsx'),
  read('src/renderer/controls.css'),
  read('src/renderer/react.css'),
  read('src/renderer/settings.css'),
  read('src/renderer/usage.css'),
  read('src/renderer/composer-refinements.css'),
  read('src/renderer/react/SelectControl.tsx'),
  read('src/renderer/react/ModelPicker.tsx'),
  read('src/renderer/react/App.tsx'),
  read('src/renderer/react/ChatPane.tsx'),
  read('src/renderer/react/Sidebar.tsx'),
  read('src/renderer/react/SearchModal.tsx'),
  read('src/renderer/react/SettingsModal.tsx'),
  read('src/renderer/react/NewChatModal.tsx'),
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
assert.match(main, /cuppet:usage:summary/, 'Electron does not bridge exact token usage');
assert.doesNotMatch(main, /join\(here, '\.\.', 'renderer', 'index\.html'\)/, 'Electron still loads legacy renderer source');
assert.match(index, /id="root"/);
assert.match(index, /type="module"\s+src="(?:\.\/)?main\.tsx"/, 'Vite mount shell does not load the TypeScript entry');
assert.doesNotMatch(index, /app\.js|commands\.js|remote\.js|d1-navigation\.js|execution-ui\.mjs/);
assert.match(entry, /createRoot/);
assert.match(entry, /<App\s*\/>/);
assert.match(entry, /import '\.\/controls\.css'/, 'app-wide control skin is not loaded by the React renderer');
assert.match(entry, /import '\.\/usage\.css'/, 'token usage dashboard styles are not loaded');
assert.match(entry, /import '\.\/composer-refinements\.css'/, 'composer refinement layer is not loaded');
assert.match(controls, /-webkit-appearance:none/, 'native Chromium/macOS form appearance is not disabled');
assert.match(controls, /input\[type="checkbox"\].*input\[type="radio"\]/s, 'checkbox/radio controls are not custom skinned');
assert.match(controls, /\.cuppet-select-menu/, 'custom dropdown surface is not styled');
assert.match(controls, /\.composer textarea/, 'chat composer textarea is not covered by the app-wide control skin');
assert.match(controls, /\.model-picker-menu/, 'composer model picker surface is not styled');
assert.match(selectControl, /role="listbox"/, 'custom dropdown does not expose a listbox');
assert.match(selectControl, /aria-haspopup="listbox"/, 'custom dropdown trigger does not expose listbox semantics');
assert.doesNotMatch(settings, /<select\b/, 'Settings returned to a native select control');
assert.doesNotMatch(newChat, /<select\b/, 'New Chat returned to a native select control');
assert.match(settings, /<SelectControl/, 'Settings provider dropdown is not using the shared custom control');
assert.match(newChat, /<SelectControl/, 'New Chat project dropdown is not using the shared custom control');

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
assert.match(chat, /aria-label="Pause"/, 'running composer does not reuse the send slot as a pause action');
assert.doesNotMatch(chat, /className="stop-button"/, 'separate Stop button returned to the composer');
assert.match(chat, /thread-activity/, 'tool activity is not rendered in the chat thread');
assert.doesNotMatch(chat, /function ActivityPanel|activity-status.*✓/s, 'separate/ticked activity component returned');
assert.match(composerCss, /\.thread-activity-line\.running\{[^}]*animation:thread-activity-pulse/s, 'running tool activity does not pulse');
assert.match(composerCss, /@keyframes thread-activity-pulse/, 'tool activity pulse keyframes missing');
assert.match(chat, /aria-label="Attach files"/, 'composer attachment action missing');
assert.match(chat, /type="file"\s+multiple/, 'composer attachment action is not backed by the native OS file picker');
assert.match(chat, /composer-attachments/, 'selected attachment chips missing');
assert.match(chat, /<ModelPicker disabled=\{running\}\s*\/>/, 'composer does not expose the active model picker');
assert.doesNotMatch(chat, /className=\{`mode-inline-button/, 'Build/Plan button returned to the permanent composer controls');
assert.match(chat, /data-message-id=\{message\.id\}/, 'messages are not addressable for exact search navigation');
assert.match(modelPicker, /aria-label="Select model"/, 'model picker trigger is not accessible');
assert.match(modelPicker, /stage === 'models'/, 'model picker does not transition from model selection to effort selection in one menu');
assert.doesNotMatch(modelPicker, /effort-picker-trigger|model-picker-custom|Custom model ID|placeholder="Model ID"/, 'model picker returned a second effort control or manual model ID field');
assert.match(modelPicker, /window\.cuppet\.settings\.get/, 'model picker does not read the authoritative current model');
assert.match(modelPicker, /window\.cuppet\.settings\.save/, 'model picker does not persist model selection');
assert.match(modelPicker, /window\.cuppet\.codexAuth\.models/, 'Codex model picker does not use the app-server catalog');
assert.match(modelPicker, /providerPreset\?\.models/, 'provider-family model choices are not merged into the picker');
assert.match(modelPicker, /settings\?\.customModels/, 'validated provider custom models are not merged into the picker');
assert.match(modelPicker, /Custom model · validated in Provider settings/, 'custom models are not identified in the picker');
assert.match(modelPicker, /providerLabel\} · Models/, 'model picker no longer identifies its provider model list');
assert.match(modelPicker, /codex-default/, 'Codex automatic default selection is not preserved');
assert.match(codexAuth, /client\.request\('model\/list'/, 'Codex model catalog is not sourced from the official app-server model/list API');
assert.match(codexAuth, /includeHidden:\s*false/, 'hidden Codex models should not be shown in the consumer picker');
assert.match(providerSettings, /const model = requestedModel \|\| currentPrimaryModel \|\| modelID\(preset\?\.model\)/, 'provider presets still force the default model instead of allowing user selection');
assert.match(providerSettings, /customModels:\s*customModelEntries\(this\.#customModels\)/, 'provider-scoped custom models are not projected to the renderer');
assert.match(providerSettings, /await probeCustomModel\(this\.runtimeValue\(\), customModel\)/, 'custom model IDs are persisted without a real provider validation request');
assert.match(customModels, /Reply only with OK\./, 'custom model validation prompt is no longer tiny');
assert.match(customModels, /tools:\s*\[\]/, 'custom model validation must remain tool-free');
for (const id of ['gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','claude-fable-5','claude-opus-5','claude-sonnet-5','qwen3.8-max','qwen3.8-flash','deepseek-v4-pro','deepseek-v4-flash','kimi-k3','kimi-k2.6','kimi-k2.5','glm-5.3','glm-5.3-flash','glm-5.1','glm-5-turbo','glm-5','gemini-3.8-flash','gemini-3.1-pro-preview','gemini-3.5-flash-lite','muse-spark-1.3']) {
  assert.ok(providerPresets.includes(id), `latest provider-family model missing from picker catalog: ${id}`);
}
assert.match(providerPresets, /id:\s*'kimi'.*baseUrl:\s*'https:\/\/api\.moonshot\.ai\/v1'/s, 'Kimi provider preset or standard API endpoint missing');
assert.match(providerPresets, /id:\s*'zai'.*baseUrl:\s*'https:\/\/api\.z\.ai\/api\/paas\/v4'/s, 'Z.ai provider preset or general API endpoint missing');
assert.match(providerPresets, /models:\s*models\.map/, 'provider preset projection does not expose its model family');
assert.match(preload, /platform:\s*process\.platform/, 'renderer cannot detect macOS for native sidebar affordances');
assert.match(preload, /cuppet:usage:summary/, 'bounded preload does not expose token usage summary');
assert.match(search, /sessions\.search/, 'React local search missing');
assert.match(search, /sessions\.restore/, 'React archived-search recovery missing');
assert.match(search, /focusMessage\(result\.itemId\)/, 'exact matching message navigation missing');
assert.match(search, /scrollIntoView/, 'exact message search result does not scroll into view');
assert.match(sidebar, /project-new-chat-button/, 'project hover new-chat button missing');
assert.match(sidebar, /New chat in \$\{project\.name\}/, 'project hover new-chat action is not labelled per project');
assert.match(sidebar, /window\.cuppet\.sessions\.rename/, 'chat rename is not wired through the bounded renderer API');
assert.match(sidebar, /sidebar-rename-dialog/, 'chat rename does not use the custom React surface');
assert.match(sidebar, /Remove project/, 'project hamburger remove action missing');
assert.doesNotMatch(sidebar, /Remove registration/, 'legacy remove-registration wording returned');
assert.match(sidebar, /SIDEBAR_WIDTH_KEY/, 'resizable sidebar persistence missing');
assert.match(sidebar, /SIDEBAR_COLLAPSED_KEY/, 'macOS sidebar collapse persistence missing');
assert.match(sidebar, /sidebar-toggle-button/, 'macOS sidebar collapse button missing');
assert.match(sidebar, /event\.metaKey.*event\.altKey.*event\.key\.toLowerCase\(\) !== 's'/s, 'macOS sidebar toggle shortcut is missing');
assert.match(sidebar, /window\.cuppet\.native\.platform === 'darwin'/, 'sidebar collapse control is not scoped to macOS');
assert.match(reactCss, /\.react-sidebar \.nav-button\{[^}]*font-size:13px/, 'primary sidebar navigation text is not 13px');
assert.match(reactCss, /\.react-sidebar \.project-name\{[^}]*font-size:13px/, 'project sidebar text is not 13px');
assert.match(reactCss, /\.react-sidebar \.session-title\{[^}]*font-size:13px/, 'chat/session sidebar text is not 13px');
assert.match(reactCss, /\.react-sidebar \.sidebar-bottom \.ghost-button\{[^}]*font-size:13px/, 'sidebar footer action text is not 13px');
assert.match(settingsCss, /\.settings-hub-nav button\{[^}]*font-size:12px/, 'Settings navigation baseline font size changed unexpectedly');
assert.match(reactCss, /\.react-sidebar\.collapsed\{[^}]*42px/, 'collapsed macOS sidebar rail styling missing');
assert.match(settings, /Account/);
assert.match(settings, /Personalisation/);
assert.match(settings, /Token usage/);
assert.match(settings, /window\.cuppet\.usage\.summary/, 'Token usage settings do not read runtime telemetry');
assert.doesNotMatch(settings, /Not tracked yet|does not yet persist exact provider token counts/, 'placeholder token usage UI returned');
assert.match(usageCss, /\.usage-stats/, 'token usage totals are not styled');
assert.match(settings, /Connected devices/);
assert.match(settings, /OpenRouter|presets\.map/, 'provider preset selector missing');
assert.match(settings, /Continue with ChatGPT/, 'Codex subscription connection UI missing');
assert.match(settings, /API key/, 'API-key provider credential UI missing');
assert.match(settings, /Custom model ID/, 'provider settings custom-model field missing');
assert.match(settings, /Test & add/, 'custom model validation action missing');
assert.match(settings, /customModel:\s*value/, 'custom model settings action does not use the host settings boundary');
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

console.log('Renderer gate passed: React/Vite/TypeScript owns the desktop surface, provider custom model IDs are tested with one tiny real request and persisted per provider before entering the picker, the model picker is a single staged model-to-effort menu, running tool activity pulses only in the transcript, the send action becomes pause while running, exact provider token usage is rendered in Settings, chat rename uses a custom React surface, the app-wide Cuppet control skin replaces native macOS form chrome, the macOS sidebar has a persisted collapse control with 13px item text, Remote is pairing-or-active-session only, D1 exact search navigation is preserved, and legacy DOM controllers are absent.');
