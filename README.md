# About
`ctx-modules.js` implements a CommonJS-style module system for NodeJS which has a high degree of 
compatibility with the default module system, npm, etc -- but which exists in a separate vm context and
not share an exports object graph, cache, etc, with the default module system.

# Raison d'Etre
This library was created so that we could run unit tests of client-server architecture libraries which
have namespace collisions and are intended to operate as singletons. Rather than making our tests rely
on starting/stopping external daemons, we create the daemon in the test and connect to it from the same
client.  This also lets deeply inspect the state of both components during a test, and step through
both sides of a conversation with a single debugger.

This module system is sufficiently complete to load Distributive's `dcp-client` library, which has
signficant dependencies and tinkers with module filename resolution.

# Unsupported Features
- ESMs (undefined behaviour)

# Supported Features
- CommonJS Modules/1.1.1
- return exports idiom
- module.exports re-assignment
- __filename, __dirname
- require.main
- require.extensions
- node_modules / package.json / index.js
- JSON modules
- MODULE_NOT_FOUND error code
- `module` module with a Module class with limited support for userland manipulation of
  _resolveFilename, _cache, etc.
- Monkey-patched `vm` module so that "this context" refers to CtxModule's contextLoad node modules into an alternate context

# API
## CtxModule
```javascript
/**
 * CtxModule constructor; creates a new module.
 *
 * @param {object} ctx          the context in which the module will be executed
 * @param {string} cnId         [optional] the canonical module id (usually filename) of the module.
 *                                         This parameter must be a filename for any module which wants
 *                                         to use require for relative-named modules.
 * @param {object} moduleCache  [optional] per-ctx object which holds loaded modules, or strings which
 *                                         hold the filenames where the source code for the module is
 *                                         located. This parameter is necessary for any module which
 *                                         wants to use require. Properties of this object are either
 *                                         search-path or canonical module identifiers.
 * @param {object} parent       [optional] instanceof CtxModule or CtxModule-duck which at least has a
 *                                         require function 
 */
```

## makeNodeProgramContext
```javascript
/**
 * Factory function which creates a fresh context suitable for running NodeJS programs. Default
 * modules such as fs, os, vm, path, process, tty, etc, are linked from the calling context.
 *
 * @param {string} contextName        [optional] name of the context
 * @param {object} moreModules        [optional] an object shaped like moduleCache which can inject 
 *                                    modules from the outer context. Each property name is either
 *                                    the canonical module identifier (usually a rooted pathname) or
 *                                    a search-path module identifier (eg "path"). Each property must
 *                                    be either a string containing the module's filename, or an object
 *                                    containing the module's exports.
 */
```

# Example
```javascript
const vm = require('vm');
const ctx = require('ctx-module').makeNodeProgramContext();

await vm.runInContext('require("dcp-client").init()', ctx);
```

# Author
Wes Garland, Distributive Corp.

# LICENSE
Released under the terms of the MIT License; see LICENSE file.