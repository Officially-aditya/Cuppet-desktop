export function assertProviderRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') throw new TypeError('Provider runtime must be an object.');
  for (const method of ['start', 'capabilities', 'runTurn', 'cancel', 'close']) {
    if (typeof runtime[method] !== 'function') throw new TypeError(`Provider runtime requires ${method}().`);
  }
  return runtime;
}
