import { registerHooks, isBuiltin } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
// #295: loaded with --import into a Trusted Acceptance process. A bare import from code outside the trusted installation (the PR tree
// under test) resolves as if imported from the trusted root, and must land inside <trusted-root>/node_modules. There is no fallback:
// neither the PR tree nor a directory above the trusted root can satisfy it. Packages inside the trusted installation keep their own
// resolution.
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
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!bare(specifier)) return nextResolve(specifier, context);
    const trusted = installation();
    if (trusted && path(context.parentURL).startsWith(trusted)) return nextResolve(specifier, context);
    const resolved = trusted && nextResolve(specifier, { ...context, parentURL: parent });
    if (!resolved || !path(resolved.url).startsWith(trusted)) throw new Error(`${specifier} is not in the trusted installation ${root}/node_modules`);
    return resolved;
  },
});
