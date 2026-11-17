#!/usr/bin/env node
// The tick's long-lived dispatch process (serveCore.ts says what it does and why).
// Like index.ts it turns on the compile cache before it loads anything else.
import { enableCompileCache } from "../util/compileCache.js";

enableCompileCache();

const { main } = await import("./serveCore.js");
// Exit explicitly: nothing a command left behind (a timer, a handle) may keep this
// process, which holds no database connection between commands, alive past its stop.
process.exit(await main(process.argv.slice(2)));
