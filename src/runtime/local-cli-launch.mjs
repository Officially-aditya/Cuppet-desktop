const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Preserve native executable arguments and escape Windows batch launchers. */
export function localCliLaunch(command, args = [], { platform = process.platform, shell } = {}) {
  const useShell = shell ?? (platform === 'win32' && /\.(cmd|bat)$/i.test(command));
  if (platform !== 'win32' || !useShell) return { command, args, shell: useShell };
  const npmShim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(command);
  return {
    command: String(command).replace(CMD_META, '^$1'),
    args: args.map((value) => {
      const quoted = quoteWindowsArgument(String(value));
      const escaped = quoted.replace(CMD_META, '^$1');
      return npmShim ? escaped.replace(CMD_META, '^$1') : escaped;
    }),
    shell: true,
  };
}

function quoteWindowsArgument(value) {
  let quoted = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === '\\') { slashes += 1; continue; }
    quoted += '\\'.repeat(character === '"' ? slashes * 2 + 1 : slashes) + character;
    slashes = 0;
  }
  return quoted + '\\'.repeat(slashes * 2) + '"';
}
