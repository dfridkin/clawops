// Importing every adapter, for the registration side effect.
//
// Each adapter module calls `registerProvider(itself)` on import, and nothing can look one up
// until that has happened. `src/providers/index.ts` cannot do these imports — the adapters
// import *it* for `registerProvider` — so the imports live here, one module away from the
// cycle.
//
// The cost is four small modules at startup: they import types and their own Pulumi program,
// which pulls `@pulumi/*` inside the program function rather than at module scope. Nothing
// heavy is loaded until a stack operation actually runs.

import './aws/index.js'
import './gcp/index.js'
import './azure/index.js'
import './local/index.js'
