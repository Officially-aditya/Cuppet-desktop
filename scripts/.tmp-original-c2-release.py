from pathlib import Path
import json

pkg_path = Path('package.json')
pkg = json.loads(pkg_path.read_text())
pkg['version'] = '0.9.0-alpha.1'
pkg.setdefault('scripts', {})['original-c2:verify'] = 'node scripts/verify-original-c2.mjs'
pkg_path.write_text(json.dumps(pkg, indent=2) + '\n')

for name in ['src/runtime/main.mjs', 'src/runtime/remote/commands.mjs', 'src/cli/main.mjs']:
    path = Path(name)
    text = path.read_text()
    count = text.count('0.8.0-alpha.1')
    if count < 1:
        raise SystemExit(f'{name}: no old version constant found')
    path.write_text(text.replace('0.8.0-alpha.1', '0.9.0-alpha.1'))

readme = Path('README.md')
r = readme.read_text()
start = r.find('## Current increment\n')
end = r.find('## Run it\n', start)
if start < 0 or end < 0:
    raise SystemExit('README current increment markers missing')
block = '''## Current increment

**Original C2 — command & interaction surface: implemented candidate (`0.9.0-alpha.1`).**

Cuppet now owns its command layer independently across Desktop, headless CLI, and authorized Remote devices:

- one canonical registry for the reviewed 16 slash commands, aliases, Remote scopes, bounded parsing, and dispatch contracts;
- `/models` is canonical while `/model` remains intentionally excluded; `/remote-control` aliases `/remote` and `/login` aliases `/platform`;
- recognized and unknown slash-prefixed input fails closed before provider inference and does not become synthetic transcript messages;
- Desktop has visible `/` discovery plus structured palette actions for memory remember/forget/clear, background pause/resume, interrupt-and-steer, and Plan/Build mode;
- local control commands work without inference credentials, while provider/model/effort commands continue to use host-local provider authority;
- `RuntimeService.session.steer` is the single steer authority used by Desktop, headless, and Remote;
- Remote `session.submit` reauthorizes the inner slash command's declared scope before dispatch, preventing a lower-scope wrapper from escalating authority.

Original C1 and Phases A through E remain intact: SQLite conversation/project state, detached context compilation, lossless plans, TST/STM, evidence-gated background memory, PE3 task routing, runtime-owned permissions/questions/undo, host-authoritative Remote, provider/model/effort policy, and revision-bound structural editing.

The production source has **no legacy controller dependency**. The next increment should be selected from the remaining original-plan migration inventory rather than inventing a new authority layer.

'''
readme.write_text(r[:start] + block + r[end:])
