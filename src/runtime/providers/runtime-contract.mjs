// @ts-check
/** @param {unknown} runtime @returns {import('../../shared/runtime-contracts').ProviderRuntime} */
export function assertProviderRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') throw new TypeError('Provider runtime must be an object.');
  const record = /** @type {Record<string, unknown>} */ (runtime);
  for (const method of ['start', 'capabilities', 'runTurn', 'cancel', 'close']) {
    if (typeof record[method] !== 'function') throw new TypeError(`Provider runtime requires ${method}().`);
  }
  return /** @type {import('../../shared/runtime-contracts').ProviderRuntime} */ (runtime);
}
