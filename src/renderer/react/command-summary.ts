// Describes, in plain language, what a shell command does, from its text alone.
//
// Deterministic and conservative on purpose: it only describes what it recognizes, flags constructs worth a
// second look, and says so when it could not read part of the command. It never calls a command "safe".
// It is an aid, not a guarantee: the full command is always shown next to it, because that text, not this
// summary, is what runs. (A model-written explanation would be steerable by the same prompt injection that
// wrote the command, so none is used.)

export type CommandSummary = {
  /** What the command does, in order, one short sentence per step. */
  steps: string[];
  /** Constructs worth a second look. */
  warnings: string[];
  /** False when part of the command could not be read or described. */
  complete: boolean;
};

const MAX_DEPTH = 3;

type Redirect = { op: string; target: string };
type Segment = {
  words: string[];
  dynamic: boolean[];
  redirects: Redirect[];
  pipedFrom: boolean;
  background: boolean;
  stdin: 'none' | 'heredoc' | 'herestring' | 'file';
  subs: string[];
  heredocBody: string;
};

const blank = (pipedFrom: boolean): Segment => ({ words: [], dynamic: [], redirects: [], pipedFrom, background: false, stdin: 'none', subs: [], heredocBody: '' });

/** A small shell lexer: quotes, escapes, comments, operators, redirects, here-documents and substitutions. */
function parse(source: string): { segments: Segment[]; ok: boolean } {
  const text = source.replace(/\r\n/g, '\n');
  const n = text.length;
  const segments: Segment[] = [];
  const heredocs: { delim: string; strip: boolean; owner: Segment }[] = [];
  let ok = true;
  let seg = blank(false);
  let i = 0;

  const endSegment = (pipe = false, background = false) => {
    if (background) seg.background = true;
    if (seg.words.length || seg.redirects.length) segments.push(seg);
    seg = blank(pipe);
  };

  // Index of the ")" matching an already-consumed "(", or -1.
  const balanced = (from: number): number => {
    let depth = 1;
    let j = from;
    while (j < n && depth > 0) {
      const c = text[j];
      if (c === '\\') { j += 2; continue; }
      if (c === "'") { const e = text.indexOf("'", j + 1); j = e < 0 ? n : e + 1; continue; }
      if (c === '"') { j += 1; while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1; j += 1; continue; }
      if (c === '(') depth += 1;
      if (c === ')') depth -= 1;
      j += 1;
    }
    return depth === 0 ? j - 1 : -1;
  };

  const readWord = (): { value: string; dynamic: boolean; quoted: boolean } | null => {
    let value = '';
    let dynamic = false;
    let quoted = false;
    let any = false;
    const substitution = (open: number, label: string): boolean => {
      const close = balanced(open);
      if (close < 0) { ok = false; value += text.slice(i); i = n; return false; }
      seg.subs.push(text.slice(open, close));
      value += `${label}…)`;
      dynamic = true;
      i = close + 1;
      return true;
    };
    while (i < n) {
      const c = text[i];
      if ((c === '<' || c === '>') && text[i + 1] === '(') { any = true; if (!substitution(i + 2, `${c}(`)) break; continue; }
      if (' \t\n;|&()<>'.includes(c)) break;
      any = true;
      if (c === '\\') {
        const next = text[i + 1] ?? '';
        if (next === '\n') { i += 2; continue; }
        // "\rm" is just rm (POSIX); "src\main" is a Windows-style path, so keep a mid-word backslash before a path character.
        if (value !== '' && /[A-Za-z0-9_.-]/.test(next)) { value += c; i += 1; continue; }
        value += next; quoted = true; i += 2; continue;
      }
      if (c === "'") {
        const end = text.indexOf("'", i + 1);
        quoted = true;
        if (end < 0) { ok = false; value += text.slice(i + 1); i = n; break; }
        value += text.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      if (c === '"') {
        quoted = true;
        i += 1;
        while (i < n && text[i] !== '"') {
          if (text[i] === '\\' && i + 1 < n) { value += '"\\$`'.includes(text[i + 1]) ? text[i + 1] : `\\${text[i + 1]}`; i += 2; continue; }
          if (text[i] === '$' && text[i + 1] === '(' && text[i + 2] !== '(') { if (!substitution(i + 2, '$(')) break; continue; }
          if (text[i] === '`') {
            const end = text.indexOf('`', i + 1);
            if (end < 0) { ok = false; i = n; break; }
            seg.subs.push(text.slice(i + 1, end)); value += '`…`'; dynamic = true; i = end + 1; continue;
          }
          if (text[i] === '$') dynamic = true;
          value += text[i];
          i += 1;
        }
        if (i >= n) ok = false; else i += 1;
        continue;
      }
      if (c === '$' && text[i + 1] === '(') {
        if (text[i + 2] === '(') { const close = balanced(i + 2); if (close < 0) { ok = false; i = n; break; } value += '$((…))'; dynamic = true; i = close + 1; continue; }
        if (!substitution(i + 2, '$(')) break;
        continue;
      }
      if (c === '`') {
        const end = text.indexOf('`', i + 1);
        if (end < 0) { ok = false; i = n; break; }
        seg.subs.push(text.slice(i + 1, end)); value += '`…`'; dynamic = true; i = end + 1; continue;
      }
      if (c === '$') dynamic = true;
      value += c;
      i += 1;
    }
    return any ? { value, dynamic, quoted } : null;
  };

  const consumeHeredocs = () => {
    for (const { delim, strip, owner } of heredocs.splice(0)) {
      let found = false;
      const body: string[] = [];
      while (i < n) {
        const eol = text.indexOf('\n', i);
        const line = text.slice(i, eol < 0 ? n : eol);
        i = eol < 0 ? n : eol + 1;
        if ((strip ? line.replace(/^\t+/, '') : line) === delim) { found = true; break; }
        body.push(strip ? line.replace(/^\t+/, '') : line);
      }
      owner.heredocBody += body.join('\n');
      if (!found) ok = false;
    }
  };

  const redirect = () => {
    const m = /^(<<<|<<-|<<|<&|>&|&>>|&>|>>|>\||>|<)/.exec(text.slice(i, i + 3));
    if (!m) { i += 1; return; }
    const op = m[1];
    i += op.length;
    while (text[i] === ' ' || text[i] === '\t') i += 1;
    const target = readWord();
    if (!target) { ok = false; return; }
    if (op === '<<' || op === '<<-') { heredocs.push({ delim: target.value, strip: op === '<<-', owner: seg }); seg.stdin = 'heredoc'; return; }
    if (op === '<<<') { seg.stdin = 'herestring'; return; }
    if (op === '<') { seg.stdin = 'file'; return; }
    if (op === '<&' || op === '>&') return; // file-descriptor duplication such as 2>&1
    seg.redirects.push({ op, target: target.value });
  };

  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t') { i += 1; continue; }
    if (c === '\\' && text[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') { while (i < n && text[i] !== '\n') i += 1; continue; }
    if (c === '\n') { i += 1; endSegment(); consumeHeredocs(); continue; }
    if (c === ';' || c === '(' || c === ')') { i += 1; endSegment(); continue; }
    if (c === '&' && text[i + 1] === '&') { i += 2; endSegment(); continue; }
    if (c === '&' && text[i + 1] !== '>') { i += 1; endSegment(false, true); continue; }
    if (c === '|') { const dbl = text[i + 1] === '|'; i += dbl || text[i + 1] === '&' ? 2 : 1; endSegment(!dbl); continue; }
    if ((c === '<' || c === '>' || c === '&') && text[i + 1] !== '(') { redirect(); continue; }
    const word = readWord();
    if (!word) { i += 1; continue; }
    if (/^\d+$/.test(word.value) && !word.quoted && (text[i] === '<' || text[i] === '>')) continue; // fd prefix like 2>
    seg.words.push(word.value);
    seg.dynamic.push(word.dynamic);
  }
  endSegment();
  if (heredocs.length) ok = false;
  return { segments, ok };
}

// ---------------------------------------------------------------------------------------------------------

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'cmd']);
const POWERSHELLS = new Set(['powershell', 'pwsh']);
const INTERPRETERS: Record<string, string> = { python: 'Python', python3: 'Python', py: 'Python', node: 'Node.js', deno: 'Deno', bun: 'Bun', ruby: 'Ruby', perl: 'Perl', php: 'PHP', lua: 'Lua' };
const DOWNLOADERS = new Set(['curl', 'wget', 'aria2c', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']);
const TRUSTED_DIRS = /^(\/usr\/local\/bin|\/usr\/bin|\/bin|\/usr\/sbin|\/sbin|\/opt\/homebrew\/bin)\//;
const CONTROL_HEAD = new Set(['for', 'case', 'select', 'function']);
const CONTROL_SKIP = new Set(['in', 'done', 'fi', 'esac', '}', 'then', 'do', 'else', '{', '!']);
const CONTROL_WITH_COMMAND = new Set(['if', 'elif', 'while', 'until']);
const ENV_THAT_CHANGES_WHAT_RUNS = /^(LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP|PATH|BASH_ENV|ENV|GIT_SSH_COMMAND|GIT_EXTERNAL_DIFF|RUBYOPT|PERL5OPT)=/;
const CREDENTIAL_PATH = /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.kube|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_rsa|id_ed25519|credentials(\.json)?|\.env(\.(?!example|sample|template)[\w.-]+)?)([\\/]|$)/i;

const short = (value: string, max = 48) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const listOf = (items: string[], max = 3) => (items.length <= max ? items.map((x) => short(x)).join(', ') : `${items.slice(0, max).map((x) => short(x)).join(', ')} and ${items.length - max} more`);
const baseName = (word: string) => (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
const outside = (path: string) => /^(~|\$HOME|%USERPROFILE%|\.\.([\\/]|$)|\/|[A-Za-z]:[\\/])/.test(path) && !/^\/(tmp|var\/tmp|dev\/(null|stdout|stderr|tty))(\/|$)/.test(path);
const hostOf = (args: string[]) => {
  for (const arg of args) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@\s]*@)?([^/\s:?#]+)/i.exec(arg.replace(/^(--?[\w-]+=)/, ''));
    if (m) return m[1];
  }
  return '';
};
const flagsOf = (args: string[]) => {
  const set = new Set<string>();
  for (const arg of args) {
    if (arg === '--') break;
    if (arg.startsWith('--')) set.add(arg.split('=')[0]);
    else if (/^-[A-Za-z]+$/.test(arg)) { set.add(arg); for (const letter of arg.slice(1)) set.add(`-${letter}`); }
  }
  return set;
};
const positional = (args: string[]) => args.filter((arg) => !arg.startsWith('-') && arg !== '');

type Described = { step: string; warns: string[]; known: boolean; prog: string; host: string; readsStdin: boolean; saved: string };

function describeProgram(prog: string, args: string[], seg: Segment, perItem: boolean, depth: number, nested: { complete: boolean }): Described {
  const warns: string[] = [];
  const flags = flagsOf(args);
  const pos = positional(args);
  const host = hostOf(args);
  let known = true;
  let readsStdin = false;
  let step = '';
  let saved = '';
  const files = (items: string[]) => (items.length ? listOf(items) : 'its input');
  const warnOutside = (items: string[], what: string) => {
    const hits = items.filter(outside);
    if (hits.length) warns.push(`${what} outside the current folder (${listOf(hits)})`);
  };

  if (SHELLS.has(prog) || POWERSHELLS.has(prog)) {
    const cIndex = args.findIndex((a) => a === '-c' || /^-[A-Za-z]*c$/.test(a) || /^-(command|c)$/i.test(a) || (prog === 'cmd' && /^\/[ck]$/i.test(a)));
    const encoded = args.some((a) => /^-(e|ec|enc|encodedcommand)$/i.test(a));
    if (encoded) { warns.push('Runs an encoded command that cannot be read here'); step = `Runs an encoded ${prog} command`; nested.complete = false; }
    else if (cIndex >= 0 && args[cIndex + 1] !== undefined) {
      const inner = summarizeCommand(prog === 'cmd' ? args.slice(cIndex + 1).join(' ') : args[cIndex + 1], depth + 1);
      step = inner.steps.length ? `Runs a nested ${prog} command that: ${inner.steps.join('; ')}` : `Runs a nested ${prog} command`;
      warns.push(...inner.warnings);
      if (!inner.complete) nested.complete = false;
    } else if (pos.length && !flags.has('-s')) step = `Runs the ${prog} script ${short(pos[0])}`;
    else { step = `Runs ${prog}, reading its commands from input`; readsStdin = true; }
    return { step, warns, known, prog, host, readsStdin, saved: '' };
  }
  if (INTERPRETERS[prog]) {
    const lang = INTERPRETERS[prog];
    const inline = args.some((a) => /^(-c|-e|-p|--eval|--print|-r)$/.test(a)) || flags.has('-c') || flags.has('-e');
    if (inline) step = `Runs inline ${lang} code`;
    else if (pos.length && pos[0] !== '-') step = `Runs the ${lang} script ${short(pos[0])}`;
    else { step = `Runs ${lang}, reading a program from input`; readsStdin = true; }
    if (args.includes('-')) readsStdin = true;
    if (seg.stdin === 'heredoc' || seg.stdin === 'herestring') { step = `Runs inline ${lang} code from a here-document`; readsStdin = true; }
    return { step, warns, known, prog, host, readsStdin, saved: '' };
  }

  switch (prog) {
    case 'cd': step = `Changes directory to ${short(pos[0] ?? '~')}`; break;
    case 'ls': case 'tree': case 'pwd': case 'which': case 'whoami': case 'uname': case 'date': case 'hostname': case 'id': case 'ps': case 'stat': case 'du': case 'df': case 'printenv': case 'uptime': case 'file': case 'type': case 'fd':
      step = 'Lists or inspects files and system state'; break;
    case 'echo': case 'printf': case 'true': case 'false': case 'sleep': case 'test': case '[': step = prog === 'sleep' ? 'Waits' : 'Prints text or checks a condition'; break;
    case 'cat': case 'head': case 'tail': case 'less': case 'more': case 'bat': case 'wc': case 'sort': case 'uniq': case 'cut': case 'tr': case 'diff': case 'jq': case 'nl': case 'strings': case 'xxd': case 'md5sum': case 'shasum': case 'sha256sum':
      step = `Reads ${files(pos)}`; if (!pos.length) readsStdin = true; break;
    case 'grep': case 'rg': case 'ag': case 'ack': step = 'Searches text for a pattern'; break;
    case 'awk': step = 'Processes text with awk'; break;
    case 'sed':
      if (flags.has('-i') || [...flags].some((f) => f.startsWith('-i'))) { step = `Edits files in place with sed (${files(pos.slice(1))})`; warnOutside(pos.slice(1), 'Edits files'); }
      else step = 'Transforms text with sed';
      break;
    case 'find': {
      step = 'Searches for files';
      if (args.includes('-delete')) { step = 'Finds files and deletes them'; warns.push('Deletes every file that matches (find -delete)'); }
      if (args.some((a) => a === '-exec' || a === '-execdir' || a === '-ok')) { step += ' and runs a command on each match'; warns.push('Runs a command on every match (find -exec)'); }
      warnOutside(pos.slice(0, 1), 'Searches');
      break;
    }
    case 'mkdir': step = `Creates folders (${files(pos)})`; warnOutside(pos, 'Creates files'); break;
    case 'touch': step = `Creates or updates files (${files(pos)})`; warnOutside(pos, 'Changes files'); break;
    case 'cp': case 'rsync': case 'scp': case 'ln':
      step = prog === 'ln' ? 'Creates links' : prog === 'cp' ? 'Copies files' : 'Copies files, possibly to another machine';
      warnOutside(pos.slice(-1), 'Writes files'); if (prog === 'scp' || prog === 'rsync') { if (pos.some((p) => /^[^/\s]+@?[\w.-]+:/.test(p))) warns.push('Copies data to or from another machine'); }
      break;
    case 'mv': step = 'Moves or renames files'; warnOutside(pos, 'Moves files'); break;
    case 'tee': step = `Writes its input to files (${files(pos)}) and prints it`; warnOutside(pos, 'Writes files'); readsStdin = true; break;
    case 'chmod': {
      step = /^[ugoa]*\+[rwxst]*x[rwxst]*$/.test(pos[0] ?? '') ? `Makes ${files(pos.slice(1))} executable` : 'Changes file permissions';
      if (/^(0?777|a\+rwx|o\+w|a\+w)$/.test(pos[0] ?? '')) warns.push('Makes files writable by everyone');
      if (flags.has('-R') && pos.slice(1).some(outside)) warns.push('Changes permissions recursively outside the current folder');
      break;
    }
    case 'chown': case 'chgrp': step = 'Changes file ownership'; warns.push('Changes who owns files'); break;
    case 'rm': case 'rmdir': case 'unlink': case 'shred': case 'del': case 'erase': case 'rd': case 'remove-item': {
      const recursive = flags.has('-r') || flags.has('-R') || flags.has('--recursive') || flags.has('-recurse') || args.some((a) => /^\/s$/i.test(a) || /^-recurse$/i.test(a));
      const targets = pos.filter((p) => !/^\/[sqfa]$/i.test(p));
      step = `Deletes ${targets.length ? listOf(targets) : 'files'}${recursive ? ' and everything inside' : ''}`;
      const broad = targets.filter((t) => /^(\/|~|~\/|\$HOME|\.|\.\.|\*|\/\*|\.\/\*)$/.test(t) || /^[A-Za-z]:[\\/]?$/.test(t));
      if (broad.length) warns.push(`Targets a very broad path (${listOf(broad)})`);
      const decided = targets.filter((t) => /[$`]/.test(t));
      if (decided.length) warns.push(`Deletes paths decided at runtime (${listOf(decided)})`);
      if (perItem) warns.push('Deletes whatever the previous command prints');
      warnOutside(targets, 'Deletes files');
      break;
    }
    case 'dd': step = 'Copies raw data'; if (args.some((a) => a.startsWith('of='))) warns.push('Can overwrite files or disks (dd of=)'); break;
    case 'mkfs': case 'fdisk': case 'parted': case 'format': case 'diskutil': step = 'Works on disks or file systems'; warns.push('Can erase disks or partitions'); break;
    case 'tar': step = flags.has('-x') || /^-?[A-Za-z]*x[A-Za-z]*$/.test(args[0] ?? '') ? 'Extracts an archive' : 'Creates or lists an archive'; break;
    case 'zip': case 'unzip': case 'gzip': case 'gunzip': case '7z': step = 'Packs or unpacks an archive'; break;
    case 'curl': case 'wget': case 'aria2c': case 'iwr': case 'irm': case 'invoke-webrequest': case 'invoke-restmethod': {
      const methodAt = args.findIndex((a) => a === '-X' || a === '--request' || /^-method$/i.test(a));
      const method = methodAt >= 0 ? args[methodAt + 1] ?? '' : '';
      const sends = args.some((a) => /^(-d|-F|-T|--data(-[a-z]+)?|--form|--upload-file|--post-(data|file)|-body)$/i.test(a)) || /^(POST|PUT|PATCH|DELETE)$/i.test(method);
      const out = args.findIndex((a) => a === '-o' || a === '--output' || /^-outfile$/i.test(a));
      step = sends ? `Sends data to ${host || 'a server'}` : `Downloads from ${host || 'a server'}`;
      if (out >= 0 && args[out + 1] && !args[out + 1].startsWith('-')) { saved = args[out + 1]; step += ` and saves it to ${short(saved)}`; }
      else if (args.includes('-O') || args.includes('--remote-name')) { saved = (/\/([^/?#]+)(?:[?#].*)?$/.exec(args.find((a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(a)) ?? '') ?? [])[1] ?? ''; if (saved) step += ` and saves it as ${short(saved)}`; }
      if (sends) warns.push(`Uploads data to ${host || 'a server'}`);
      if (flags.has('-k') || flags.has('--insecure') || args.includes('--no-check-certificate')) warns.push('Skips TLS certificate checks');
      break;
    }
    case 'ssh': case 'sftp': case 'nc': case 'ncat': case 'netcat': case 'socat': case 'telnet': case 'ftp':
      step = `Connects to another machine${pos[0] ? ` (${short(pos[0])})` : ''} over the network`; warns.push('Opens a network connection'); break;
    case 'ping': case 'dig': case 'nslookup': case 'traceroute': step = 'Checks network connectivity'; break;
    case 'sudo': case 'doas': case 'su': case 'runas': step = 'Runs with administrator privileges'; warns.push('Runs with administrator privileges'); break;
    case 'kill': case 'pkill': case 'killall': case 'taskkill': step = 'Stops processes'; break;
    case 'eval': step = 'Runs text as a command (eval)'; warns.push('Runs text built at runtime (eval), so the real command is not visible here'); nested.complete = false; break;
    case 'source': case '.': step = `Runs the commands in ${short(pos[0] ?? 'a file')} in this shell`; if (pos[0]?.startsWith('<(') || /^[a-z]+:\/\//i.test(pos[0] ?? '')) warns.push('Runs commands from a download or another command'); break;
    case 'iex': case 'invoke-expression': step = 'Runs text as a command (Invoke-Expression)'; warns.push('Runs text built at runtime, so the real command is not visible here'); readsStdin = true; break;
    case 'base64': step = 'Encodes or decodes data (base64)'; if (flags.has('-d') || flags.has('-D') || flags.has('--decode')) warns.push('Decodes hidden text (base64)'); break;
    case 'export': case 'set': case 'unset': case 'alias': step = 'Sets shell variables or options'; break;
    case 'git': describeGit(args, warns, (text) => { step = text; }); break;
    case 'npm': case 'pnpm': case 'yarn': case 'bun': case 'npx': case 'pnpx': case 'bunx': describeNode(prog, pos, flags, warns, (text) => { step = text; }); break;
    case 'pip': case 'pip3': case 'uv': case 'poetry': case 'pipx': case 'conda': {
      const sub = pos[0] ?? '';
      step = /^(install|add|sync|update|upgrade)$/.test(sub) ? `Installs Python packages (${listOf(pos.slice(1)) || 'from a lockfile'}); downloads code and may run build scripts` : `Runs ${prog} ${sub}`.trim();
      if (prog === 'pipx' && sub === 'run') warns.push('Downloads and runs code from a registry');
      break;
    }
    case 'cargo': case 'go': case 'make': case 'cmake': case 'ninja': case 'just': case 'task': case 'mvn': case 'gradle': case 'gradlew': case 'dotnet': case 'bundle': case 'rake': case 'composer': {
      const sub = pos[0] ?? '';
      const verb = /^(test|check|clippy|vet|verify)$/.test(sub) ? 'Tests or checks the project' : /^(build|compile|install|package|assemble)$/.test(sub) ? 'Builds the project' : /^(run|exec)$/.test(sub) ? 'Builds and runs the project' : prog === 'make' || prog === 'just' || prog === 'task' ? `Runs the ${sub || 'default'} target` : `Runs ${prog} ${sub}`.trim();
      step = `${verb} (${prog}${sub ? ` ${sub}` : ''})`;
      if (/^(install|add|get)$/.test(sub) && ['cargo', 'go', 'composer', 'bundle'].includes(prog)) step += '; downloads code';
      break;
    }
    case 'tsc': case 'vite': case 'webpack': case 'esbuild': case 'rollup': case 'next': case 'nuxt': case 'turbo': case 'nx': step = `Builds the project (${prog})`; break;
    case 'eslint': case 'prettier': case 'ruff': case 'black': case 'flake8': case 'mypy': case 'rustfmt': case 'biome': step = `Lints or formats code (${prog})`; break;
    case 'jest': case 'vitest': case 'pytest': case 'mocha': case 'playwright': case 'cypress': case 'phpunit': step = `Runs tests (${prog})`; break;
    case 'brew': case 'apt': case 'apt-get': case 'yum': case 'dnf': case 'pacman': case 'apk': case 'winget': case 'choco': case 'scoop': {
      const sub = pos[0] ?? '';
      step = /^(install|add|upgrade|update|reinstall)$/.test(sub) ? `Installs or updates system software (${listOf(pos.slice(1)) || prog})` : /^(remove|uninstall|purge|autoremove)$/.test(sub) ? 'Removes system software' : `Runs ${prog} ${sub}`.trim();
      if (/^(install|add|upgrade|update|remove|uninstall|purge)$/.test(sub)) warns.push('Changes software outside the project');
      break;
    }
    case 'docker': case 'podman': case 'docker-compose': case 'kubectl': case 'helm': case 'terraform': case 'tofu': case 'ansible': case 'aws': case 'gcloud': case 'az': case 'gh': case 'vercel': case 'netlify': case 'fly': case 'heroku': {
      const words = (prog === 'docker' || prog === 'podman') && pos[0] !== 'compose' ? 1 : 2;
      const sub = pos.slice(0, words).join(' ');
      step = `Runs ${prog}${sub ? ` ${sub}` : ''}`;
      if (['kubectl', 'helm', 'terraform', 'tofu', 'ansible', 'aws', 'gcloud', 'az', 'vercel', 'netlify', 'fly', 'heroku'].includes(prog) && /\b(apply|delete|destroy|create|deploy|rm|remove|publish|push|scale|rollout|upgrade|install|put|sync|terminate)\b/.test(sub)) warns.push('May change remote infrastructure or services');
      if ((prog === 'docker' || prog === 'podman') && (args.includes('--privileged') || args.some((a) => /^-v$|^--volume/.test(a) && /^(\/|\/:)/.test(args[args.indexOf(a) + 1] ?? '')))) warns.push('Gives a container broad access to this machine');
      break;
    }
    default:
      known = false;
      step = /[\\/]/.test(prog) || prog.startsWith('.') ? `Runs the local program ${short(prog)}` : `Runs ${short(prog)}`;
  }
  if (!step) step = `Runs ${prog}`;
  if (perItem) step = `For each input item: ${step.charAt(0).toLowerCase()}${step.slice(1)}`;
  return { step, warns, known, prog, host, readsStdin, saved };
}

function describeGit(args: string[], warns: string[], set: (step: string) => void) {
  let sub = '';
  let rest: string[] = [];
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(a)) { k += 1; continue; }
    if (a.startsWith('-')) continue;
    sub = a; rest = args.slice(k + 1); break;
  }
  const flags = flagsOf(rest);
  const pos = positional(rest);
  const url = hostOf(rest);
  if (rest.includes('--no-verify') || flags.has('-n') && sub === 'commit') warns.push('Skips git hooks (--no-verify)');
  switch (sub) {
    case 'status': case 'log': case 'diff': case 'show': case 'blame': case 'rev-parse': case 'ls-files': case 'describe': case 'shortlog': case 'reflog': case 'grep': case 'remote': case 'config': case 'tag':
      set(`Reads git history or status (git ${sub})`); break;
    case 'branch':
      if (flags.has('-D') || flags.has('-d') || flags.has('--delete')) { set('Deletes a git branch'); warns.push('Deletes a branch'); } else set('Lists or creates git branches'); break;
    case 'add': set(rest.some((a) => a === '-A' || a === '--all' || a === '.' || a === '-u') ? 'Stages all changes (git add)' : `Stages changes (git add ${listOf(pos)})`.trim()); break;
    case 'commit': set(`Creates a git commit${flags.has('-a') ? ' of all tracked changes' : ''}`); if (flags.has('--amend')) warns.push('Rewrites the previous commit (--amend)'); break;
    case 'push':
      set(`Pushes commits to a remote repository${pos[0] ? ` (${short(pos[0])})` : ''}`);
      if (flags.has('--force') || flags.has('-f') || flags.has('--force-with-lease') || rest.some((a) => /^\+\S/.test(a))) warns.push('Overwrites history on the remote (force push)');
      if (flags.has('--delete') || rest.some((a) => /^:\S/.test(a))) warns.push('Deletes a branch or tag on the remote');
      break;
    case 'pull': case 'fetch': case 'clone': case 'submodule': set(`Downloads from a git remote${url ? ` (${url})` : ''} (git ${sub})`); break;
    case 'reset': set('Moves the current branch (git reset)'); if (flags.has('--hard')) warns.push('Discards uncommitted changes (reset --hard)'); break;
    case 'clean': set('Removes untracked files (git clean)'); if (flags.has('-f') || flags.has('--force') || flags.has('-d') || flags.has('-x')) warns.push('Deletes untracked files for good (git clean)'); break;
    case 'checkout': case 'restore': case 'switch':
      set(`Changes the working tree (git ${sub})`); if (rest.some((a) => a === '.' || a === '--') && sub !== 'switch') warns.push('Can discard uncommitted changes'); break;
    case 'rebase': case 'filter-branch': case 'filter-repo': case 'commit-tree': set(`Rewrites git history (git ${sub})`); warns.push('Rewrites git history'); break;
    case 'stash': case 'merge': case 'cherry-pick': case 'revert': case 'apply': case 'am': case 'mv': case 'rm': case 'init': case 'worktree': case 'gc': case 'prune':
      set(`Changes the repository (git ${sub})`); break;
    default: set(`Runs git${sub ? ` ${sub}` : ''}`);
  }
}

function describeNode(prog: string, pos: string[], flags: Set<string>, warns: string[], set: (step: string) => void) {
  const where = flags.has('--workspaces') || flags.has('-ws') || flags.has('--recursive') || flags.has('-r') ? ' in all workspaces' : '';
  if (prog === 'npx' || prog === 'pnpx' || prog === 'bunx') { set(`Downloads (if needed) and runs the package ${short(pos[0] ?? '')}`.trim()); warns.push('Downloads and runs code from a registry'); return; }
  const sub = pos[0] ?? '';
  const rest = pos.slice(1);
  if (/^(run|run-script|r)$/.test(sub)) set(`Runs the project's ${short(rest[0] ?? 'default')} script${where}`);
  else if (/^(test|t|tst)$/.test(sub)) set(`Runs the project's tests${where}`);
  else if (/^(install|i|add|ci|update|upgrade|up|link)$/.test(sub)) set(`Installs dependencies (${rest.length ? listOf(rest) : 'from the lockfile'}); downloads code and may run install scripts`);
  else if (/^(remove|uninstall|rm|un)$/.test(sub)) set(`Removes dependencies (${listOf(rest)})`);
  else if (sub === 'publish') { set('Publishes a package to a registry'); warns.push('Publishes code publicly or to a registry'); }
  else if (/^(exec|dlx|x)$/.test(sub)) { set(`Downloads and runs the package ${short(rest[0] ?? '')}`.trim()); warns.push('Downloads and runs code from a registry'); }
  else if (/^(audit|outdated|ls|list|why|view|info|pack)$/.test(sub)) set(`Inspects dependencies (${prog} ${sub})`);
  else if (sub && (prog === 'yarn' || prog === 'pnpm' || prog === 'bun')) set(`Runs the project's ${short(sub)} script${where}`);
  else set(`Runs ${prog}${sub ? ` ${sub}` : ''}`);
}

// ---------------------------------------------------------------------------------------------------------

export function summarizeCommand(command: string, depth = 0): CommandSummary {
  const steps: string[] = [];
  const warnings: string[] = [];
  let complete = true;
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message); };
  if (depth > MAX_DEPTH) return { steps: ['Runs a deeply nested command'], warnings: ['Nested too deeply to describe'], complete: false };
  if (!command.trim()) return { steps, warnings, complete };

  const { segments, ok } = parse(command);
  if (!ok) { complete = false; warn('Could not read the whole command (an unclosed quote, bracket or here-document)'); }

  let previous: Described | null = null;
  let previousBody = '';
  let sawControl = false;
  const downloaded: string[] = [];

  for (const seg of segments) {
    let words = seg.words.slice();
    let dynamic = seg.dynamic.slice();
    const assigned: string[] = [];
    let perItem = false;

    // Substitutions are commands too: describe them and carry their warnings up.
    for (const sub of seg.subs) {
      const inner = summarizeCommand(sub, depth + 1);
      warn(`Builds part of the command by running another command (${short(sub.trim(), 60)})`);
      for (const w of inner.warnings) warn(w);
      if (!inner.complete) complete = false;
    }

    // Leading shell syntax: assignments, keywords.
    for (;;) {
      if (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
        if (ENV_THAT_CHANGES_WHAT_RUNS.test(words[0])) warn(`Sets ${words[0].split('=')[0]}, which can change what gets run`);
        assigned.push(words[0].split('=')[0]); words.shift(); dynamic.shift(); continue;
      }
      if (words.length && CONTROL_HEAD.has(words[0])) { sawControl = true; words = []; break; }
      if (words.length && CONTROL_WITH_COMMAND.has(words[0])) { sawControl = true; words.shift(); dynamic.shift(); continue; }
      if (words.length && CONTROL_SKIP.has(words[0])) { words.shift(); dynamic.shift(); continue; }
      break;
    }
    if (!words.length) {
      if (assigned.length && !seg.redirects.length) steps.push(`Sets shell variables (${assigned.join(', ')})`);
      for (const r of seg.redirects) { if (!/^\/dev\/(null|stdout|stderr)$/.test(r.target)) steps.push(`${/>>/.test(r.op) ? 'Appends to' : 'Creates or empties'} ${short(r.target)}`); }
      continue;
    }

    // Wrappers that run another program.
    for (let guard = 0; guard < 6 && words.length; guard += 1) {
      const wrapper = baseName(words[0]);
      const takesValue: Record<string, string[]> = { sudo: ['-u', '-g', '-C', '-h', '-p', '-r', '-t'], doas: ['-u'], nice: ['-n'], ionice: ['-c', '-n'], xargs: ['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a'], watch: ['-n', '-d'], env: ['-u', '-C', '-S'], stdbuf: ['-i', '-o', '-e'] };
      if (!['sudo', 'doas', 'env', 'nice', 'ionice', 'nohup', 'time', 'command', 'builtin', 'exec', 'setsid', 'stdbuf', 'timeout', 'watch', 'xargs', 'caffeinate'].includes(wrapper)) break;
      if (wrapper === 'sudo' || wrapper === 'doas') warn('Runs with administrator privileges');
      if (wrapper === 'xargs') perItem = true;
      if (wrapper === 'exec') steps.push('Replaces the shell with the next program');
      words.shift(); dynamic.shift();
      while (words.length && (words[0].startsWith('-') || (wrapper === 'env' && /^[A-Za-z_]\w*=/.test(words[0])))) {
        const takes = (takesValue[wrapper] ?? []).includes(words[0]);
        words.shift(); dynamic.shift();
        if (takes && words.length) { words.shift(); dynamic.shift(); }
      }
      if (wrapper === 'timeout' && words.length && /^[\d.]+[smhd]?$/.test(words[0])) { words.shift(); dynamic.shift(); }
    }
    if (!words.length) { steps.push('Runs a wrapper command with nothing to run'); continue; }

    const head = words[0];
    if (dynamic[0]) { warn('Runs a command whose name is decided at runtime'); complete = false; steps.push('Runs a command chosen at runtime'); previous = null; continue; }
    let prog = baseName(head);
    const qualified = /[\\/]/.test(head);
    const trusted = !qualified || TRUSTED_DIRS.test(head);
    if (qualified && !trusted) prog = head; // a path we do not trust to be what its name suggests

    const nested = { complete: true };
    const info = describeProgram(trusted ? prog : head, words.slice(1), seg, perItem, depth, nested);
    if (!nested.complete) complete = false;
    if (!info.known) complete = false;
    steps.push(info.step);
    for (const w of info.warns) warn(w);
    if (qualified && !trusted && !info.step.startsWith('Runs the local program')) warn(`Runs a program from ${short(head)}, which is not a standard location`);
    const justDownloaded = words.slice(0, 3).map((w) => w.replace(/^\.[\\/]/, '')).find((w) => downloaded.includes(w));
    if (justDownloaded) warn(`Runs a file it just downloaded (${short(justDownloaded)})`);
    if (info.saved) downloaded.push(info.saved);

    // Redirects: where output goes.
    for (const r of seg.redirects) {
      if (/^\/dev\/(null|stdout|stderr|tty)$/.test(r.target) || /^&/.test(r.target)) continue;
      steps.push(`${/>>/.test(r.op) ? 'Appends its output to' : 'Writes its output to'} ${short(r.target)}`);
      if (outside(r.target)) warn(`Writes outside the current folder (${short(r.target)})`);
      if (CREDENTIAL_PATH.test(r.target)) warn(`Touches a credentials or secrets file (${short(r.target)})`);
    }
    if (seg.background) steps.push('Starts it in the background');

    // Credential-like paths anywhere in the arguments.
    const credentialHits = words.slice(1).filter((w) => CREDENTIAL_PATH.test(w));
    if (credentialHits.length) warn(`Touches credentials or secrets (${listOf(credentialHits)})`);

    // Text piped or fed into a program that executes it.
    const executes = (SHELLS.has(info.prog) || POWERSHELLS.has(info.prog) || !!INTERPRETERS[info.prog] || ['iex', 'invoke-expression', 'source', '.'].includes(info.prog)) && info.readsStdin;
    if (executes && seg.pipedFrom) {
      if (previous && DOWNLOADERS.has(previous.prog)) warn(`Downloads from ${previous.host || 'a server'} and runs it immediately as a program`);
      else warn('Runs piped text as a program');
    } else if (executes && (seg.stdin === 'heredoc' || seg.stdin === 'herestring')) {
      if (SHELLS.has(info.prog) || POWERSHELLS.has(info.prog)) warn('Runs inline text as a shell program');
    }
    const script = seg.stdin === 'heredoc' ? seg.heredocBody : seg.pipedFrom ? previousBody : '';
    if (executes && script && SHELLS.has(info.prog) && info.prog !== 'cmd') {
      const inner = summarizeCommand(script, depth + 1);
      if (inner.steps.length) steps.push(`Runs the script it is given, which: ${inner.steps.join('; ')}`);
      for (const w of inner.warnings) warn(w);
      if (!inner.complete) complete = false;
    }
    previousBody = seg.heredocBody;
    previous = info;
  }

  if (sawControl) { complete = false; steps.push('Uses a loop, condition or function, so what runs can depend on input'); }
  return { steps, warnings, complete };
}

// ---------------------------------------------------------------------------------------------------------
// Plain-language form, shown under the approval panel: one or two short sentences, informational only.

// Characters that make text look different from what it is: control characters, zero-width and
// bidirectional-control characters (which can reorder or hide text), line/paragraph separators, and look-alike
// spaces. The summary repeats hosts and paths taken from an untrusted command, so these are made visible.
const HIDDEN_OR_LOOKALIKE =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00A0\u00AD\u061C\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u206F\u3000\uFEFF\uFFF9-\uFFFB]/g;

/** Replaces hidden or look-alike characters with a visible marker such as `⟦U+202E⟧`. */
export function revealHiddenCharacters(input: string): string {
  return String(input).replace(HIDDEN_OR_LOOKALIKE, (char) => `⟦U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟧`);
}

export type PlainSummary = {
  /** What the command does, as one sentence. Empty when nothing could be described. */
  what: string;
  /** Constructs worth a second look, as one sentence. Empty when there are none. */
  headsUp: string;
  /** A pointer back to the command when the summary is incomplete or empty. */
  note: string;
};

const MAX_PROSE_STEPS = 3;
const MAX_PROSE_WARNINGS = 2;
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const withAnd = (items: string[]) => (items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`);
const plural = (count: number, noun: string) => `${count} more ${noun}${count === 1 ? '' : 's'}`;

/**
 * A short, deterministic description of a command for people who do not read shell syntax. It says what the
 * command appears to do and what deserves a second look; it never says a command is safe, and it points back
 * to the command when it could not describe all of it. The command itself stays the authority.
 */
export function plainLanguageSummary(command: string): PlainSummary {
  const result = summarizeCommand(command);
  const steps = result.steps.map(revealHiddenCharacters);
  const warnings = result.warnings.map(revealHiddenCharacters);

  let what = '';
  if (steps.length) {
    const shown = steps.slice(0, MAX_PROSE_STEPS).map((step, index) => (index === 0 ? step : lowerFirst(step)));
    if (steps.length > shown.length) shown.push(plural(steps.length - shown.length, 'step'));
    what = `${withAnd(shown)}.`;
  }

  let headsUp = '';
  if (warnings.length) {
    const shown = warnings.slice(0, MAX_PROSE_WARNINGS).map(lowerFirst);
    if (warnings.length > shown.length) shown.push(`${plural(warnings.length - shown.length, 'other point')}`);
    headsUp = `Worth a second look: ${shown.join('; ')}.`;
  }

  let note = '';
  if (!what && !headsUp) note = 'Review the command above before approving.';
  else if (!result.complete) note = "Parts of it aren't described here, so review the command above before approving.";
  else if (result.steps.some((step) => /^Runs the .*\bscript\b/.test(step))) note = 'What it changes depends on what the script itself does.';
  return { what, headsUp, note };
}
