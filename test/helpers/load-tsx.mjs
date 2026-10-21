// Loads a .ts/.tsx renderer module for tests by transpiling it with the project's TypeScript, so React components
// can be rendered to static HTML with react-dom/server without a bundler or a DOM.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const nodeRequire = createRequire(import.meta.url);

/**
 * @param {string} entry absolute path of the module to load
 * @param {Record<string, unknown>} [overrides] replacement exports keyed by the relative specifier a module imports
 *   (for example './sandbox-status'), so a test can control what a hook returns
 */
export function loadModule(entry, overrides = {}) {
  const cache = new Map();

  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    });
    const module = { exports: {} };
    cache.set(file, module);
    const localRequire = (specifier) => {
      if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
      if (!specifier.startsWith('.')) return nodeRequire(specifier);
      const base = resolve(dirname(file), specifier);
      const found = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((extension) => base + extension).find(existsSync);
      if (!found) throw new Error(`Cannot resolve ${specifier} from ${file}`);
      return load(found);
    };
    new Function('require', 'module', 'exports', outputText)(localRequire, module, module.exports);
    return module.exports;
  };

  return load(resolve(entry));
}
