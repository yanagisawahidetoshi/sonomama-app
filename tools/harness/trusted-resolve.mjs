import { createRequire, registerHooks, isBuiltin } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
// #295: loaded with --import into a Trusted Acceptance process. A bare import or require() from code outside the trusted installation
// (the PR tree under test) resolves as if made from the trusted root. Every bare resolution, a trusted package's own dependencies
// included, must land inside <trusted-root>/node_modules; a symlink or a lookup that leaves it fails the run. There is no fallback to
// the PR tree or to a directory above the trusted root.
const root = new URL(import.meta.url).searchParams.get('root');
if (!root) throw new Error('trusted-resolve needs ?root=<trusted root>');
const parent = pathToFileURL(`${root}/`).href;
let installed;
const installation = () => {
  if (installed === undefined) { try { installed = `${realpathSync(`${root}/node_modules`)}/`; } catch { installed = null; } }
  return installed;
};
const bare = specifier => !isBuiltin(specifier) && !/^(\.{1,2}\/|\/|[a-z][a-z0-9+.-]*:)/i.test(specifier);
const path = url => url?.startsWith('file:') ? fileURLToPath(url) : '';
// require() ignores a replaced parentURL, so a CommonJS lookup from outside the installation starts from the trusted root explicitly.
const fromRoot = createRequire(`${root}/`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!bare(specifier)) return nextResolve(specifier, context);
    const trusted = installation();
    if (!trusted) throw new Error(`${specifier}: the trusted installation ${root}/node_modules does not exist`);
    const inside = path(context.parentURL).startsWith(trusted);
    const resolved = inside ? nextResolve(specifier, context)
      : context.conditions?.includes('require') ? { url: pathToFileURL(fromRoot.resolve(specifier)).href, shortCircuit: true }
      : nextResolve(specifier, { ...context, parentURL: parent });
    if (!path(resolved.url).startsWith(trusted)) throw new Error(`${specifier} is not in the trusted installation ${root}/node_modules`);
    return resolved;
  },
});
