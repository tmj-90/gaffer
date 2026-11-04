// One dashboard per boot, modules included.
//
// The DOM tests boot the SPA afresh per test case with a cache-busting query
// (`import(app.js?t=…)`), so every boot gets its own module instance and nothing a
// boot leaves behind (DOM handles taken at load, counters, caches, pollers) reaches
// the next. app.js is the entry of an ES-module graph under src/api/web/js/, and its
// imports are plain relative specifiers, which Node's loader would resolve to one URL
// for every boot: the modules under js/ would be shared across boots. This resolve
// hook carries the query of the importing dashboard module onto each relative import
// it makes, so `app.js?t=7` loads `js/router.js?t=7` and that loads `js/api.js?t=7`:
// each boot gets a whole fresh graph, exactly as when app.js was one file. Nothing
// outside src/api/web is touched, and the page itself (a browser, no query) loads
// the same files once.
//
// The modules are handed to Node's loader by vitest.config.ts (server.deps.external),
// so this in-thread hook (module.registerHooks, Node 22.15+) sees every one of them.

import { registerHooks } from "node:module";

const DASHBOARD_MODULE = /\/src\/api\/web\/(?:app\.js|js\/[^?]+\.js)\?([^#]+)/;
const FLAG = Symbol.for("gaffer.test.webModuleHooks");
const g = globalThis as typeof globalThis & { [FLAG]?: boolean };

if (!g[FLAG]) {
  g[FLAG] = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const m = context.parentURL ? DASHBOARD_MODULE.exec(context.parentURL) : null;
      if (m && /^\.\.?\//.test(specifier) && !specifier.includes("?"))
        return nextResolve(`${specifier}?${m[1]}`, context);
      return nextResolve(specifier, context);
    },
  });
}
