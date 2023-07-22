/**
 * @file        ctx-module.js
 *              A CommonJS-style module system for NodeJS which has a high degree of compatibility with 
 *              the default module system, npm, etc -- but which exists in a separate vm context and 
 *              does not share an exports object graph, cache, etc, with the default module system.
 *
 *              Supported Features:
 *              - CommonJS Modules/1.1.1
 *              - return exports idiom
 *              - __filename, __dirname
 *              - require.main
 *              - require.extensions
 *              - node_modules / package.json / index.js
 *              - JSON modules
 *              - MODULE_NOT_FOUND error code
 *              - module module with a Module class with limited support for userland manipulation of
 *                _resolveFilename, _cache, etc.
 *              - Monkey-patched vm module so that "this context" refers to CtxModule's context
 *
 * @author      Wes Garland, wes@distributive.network
 * @date        Feb 2023
 */
'use strict';

const debug = require('debug');
const fs    = require('fs');
const vm    = require('vm');

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
function CtxModule(ctx, cnId, moduleCache, parent)
{
  const that = this;
  
  /* Create the resources for new module long before eval so that circular deps work */
  this.exports = {};
  this.loaded  = false;

  if (!parent || !parent.require)
    parent = Object.assign({}, parent);

  if (!parent.require)
  {
    parent.require = {
      path: [],
      main: undefined,
      extensions: {
        '.js':   loadJSModule,
        '.json': loadJSONModule,
        '.node': loadNAPIModule,
      },
    };
  }

  if (cnId) /* false => completely virtual exports-only module, via Module.from */
  {
    this.filename = cnId;
    this.path = dirname(this.filename);
    this.paths = makeNodeModulesPaths(this.path);
  }

  /** 
   * Creates the path list for module.paths, eg
   *  /home/wes/git/dcp/node_modules
   *  /home/wes/git/node_modules
   *  /home/wes/node_modules
   *  /home/wes/node_modules
   *  /home/node_modules
   *  /node_modules
   */
  function makeNodeModulesPaths(fromPath)
  {
    const paths = [];
    
    if (!cnId)
      return paths;
    
    /* Create a new modules.path for node_modules resolution */
    for (let path = fromPath; path && path[0] === '/'; path = dirname(path))
    {
      if (path.endsWith('/node_modules'))
        continue;
      paths.push(relativeResolve(path, './node_modules'));
      if (path === '/')
        break;
    }

    return paths;
  }

  /** Implementation of require() for this module */
  this.require = function ctxRequire(moduleIdentifier)
  {
    debug('ctx-module:require')('require ' + moduleIdentifier);

    try
    {
      const moduleFilename = requireResolve(moduleIdentifier);
      if (moduleCache.hasOwnProperty(moduleFilename) && typeof moduleCache[moduleFilename] === 'object')
        return moduleCache[moduleFilename].exports;
      return loadModule(moduleFilename).exports;
    }
    catch(error)
    {
      if (error.code === 'ENOENT')
        error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
  }

  /* Decorate new module's require with API properties */
  this.require.id = cnId;
  this.require.cache = moduleCache;
  this.require.resolve = requireResolve;
  if (parent && parent.require)
  {
    this.require.extensions = parent.require.extensions;
    this.require.path       = parent.require.path;
    this.require.main       = parent.require.main;
  }
  
  /**
   * Make a canonical module identifier from an arbitrary module identifier that does not
   * need path-searching to resolve.
   *
   * @param {string} moduleIdentifier        any module identifier (argument to require)
   * @returns a canonical moduleIdentifier which can be used to resolve the module's filename
   */
  function canonicalize(moduleIdentifier)
  {
    if (moduleIdentifier.startsWith('./') || moduleIdentifier.startsWith('../') || moduleIdentifier === '.')
      moduleIdentifier = relativeResolve(that.path, moduleIdentifier);
    else
      moduleIdentifier = relativeResolve(moduleIdentifier);
    if (moduleCache.hasOwnProperty(moduleIdentifier))
    {
      if (typeof moduleCache[moduleIdentifier] === 'object')
        return moduleIdentifier;
      if (typeof moduleCache[moduleIdentifier] === 'string')
        moduleIdentifier = relativeResolve(moduleCache[moduleIdentifier]);
    }

    return moduleIdentifier;
  }
  
  function dirname(pathname)
  {
    pathname = pathname
      .replace(/[\/\\]$/, '')           /* strip trailing slash */
      .replace(/[\/\\][^/\\]+$/, '');   /* strip last slash to end */
    
    return pathname || '/';
  }

  /**
   * Resolve a pathname fragment, which could contain ../ etc, into a rooted pathname with no 
   * ../ or ./ components, relative to the given directory. Specifying only one argument simply
   * results in a flattened path.
   */
  function relativeResolve(relativeTo, relativePathname)
  {
    var pathname = relativeTo + (relativePathname ? '/' + relativePathname : '');
    var components;
    var newPath = [];
    
    if (pathname.startsWith('./') || pathname.startsWith('../'))
      pathname = that.path + '/' + pathname;
    if (pathname.startsWith('/'))
      newPath[0] = '';
    
    components = pathname.split('/');
    for (let i=0; i < components.length; i++)
    {
      let component = components[i];      
      switch(component)
      {
        case '..':
          newPath.pop();
          break;
        case '.': case '':
          break;
        default:
          newPath.push(component);
      }
    }

    return newPath.join('/');
  }

  /**
   * Search require.path and module.path to map a module identifier onto
   * a full pathname.
   */
  function requireResolve(moduleIdentifier)
  {
    var moduleFilename;
    
    moduleIdentifier = canonicalize(moduleIdentifier);
    if (moduleCache.hasOwnProperty(moduleIdentifier))
    {
      debug('ctx-module:requireResolve')('require.resolve', moduleIdentifier, '=>', moduleIdentifier, '(cache hit)');
      return moduleIdentifier;
    }
    
    if (moduleIdentifier[0] === '/' || moduleIdentifier.match(/^[A-Z]:[\/\\]/)) // absolute paths
      moduleFilename = locateModuleFile(relativeResolve(moduleIdentifier));
    else
    {
      let searchPath = that.require.path;
      if (that.paths.length)
        searchPath = that.require.path.length ? that.require.path.concat(that.paths) : that.paths;

      for (const path of searchPath)
      {
        moduleFilename = locateModuleFile(relativeResolve(path, moduleIdentifier));
        if (moduleFilename)
          break;
      }
    }

    if (!moduleFilename)
    {
      const error = new Error(`module not found -- require('${moduleIdentifier}') from ${that.filename || that.id}`);
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    
    debug('ctx-module:requireResolve')('require.resolve', moduleIdentifier, '=>', moduleFilename);
    return moduleFilename.split('\\').join('/');
  }

  function loadJSModule(module, filename)
  {
    const SHEBANG_REGEX = /^#!.*\r{0,1}\n/m;
    var moduleCode = fs.readFileSync(module.filename, 'utf-8');
    var moduleFun;
    var lineOffset = 0;
    
    /* Evaluate the module code and return its exports. We use IIFE as namespace and arguments for
     * symbol names. Fully-formed function provides unique 'this'. Newline in epilogue pushes past // comments,
     * and offset of prologue is accounted for so that stack traces will be accurate.
     */
    try
    {
      /* Parse the code to determine the line offset and if we are in Strict Mode or not */
      if (moduleCode.match(SHEBANG_REGEX))
      {
        moduleCode = moduleCode.replace(SHEBANG_REGEX, '');
        lineOffset = 1;
      }
      const bareCode = moduleCode
        .replace(/(\/\*([\s\S]*?)\*\/)|(\/\/(.*)$)/gm /* comments */, '')
        .replace(/^[\s]*[\r\n]/gm, '');
      const isStrictMode = !!bareCode.match(/^[\s ]*['"]use strict['"][\s]*(;?|[\r\n])/);
      const prologue = ''
            + `${isStrictMode ? '"use strict";' : ''}`
            + `(function ${filename.replace(/[^A-Za-z0-9_]+/g, '_')}(require, exports, module, __filename, __dirname) {`;
      const epilogue = '\n})';

      moduleFun = vm.runInContext(prologue + moduleCode + epilogue,ctx, {
        filename,
        lineOffset,
        columnOffset: prologue.length,
      });
    }
    catch(error)
    {
      if (error.name === 'SyntaxError')
        error.message += ' parsing ' + module.filename;
      throw error;
    }
    const retval = moduleFun(module.require, module.exports, module, module.filename, dirname(module.filename));
    if (typeof retval !== 'undefined') /* non-CJS idiom: return exports */
      module.exports = retval;
  }

  function loadNAPIModule(module, filename)
  {
    ctx.process.dlopen(module, filename); /* replaces module.exports */
  }

  function loadJSONModule(module, filename)
  {
    copyProps(module.exports, JSON.parse(fs.readFileSync(filename, 'utf-8')));
  }

  function loadModule(filename)
  {
    const module = moduleCache[filename] = new CtxModule(ctx, filename, moduleCache, { require: that.require });
    const match = filename.match(/\.[a-z]*$/);
    const ext = match && match[0];

    /* use either the correct-named or the .js loader to load this file as a module */
    const loader = that.require.extensions[ext] || that.require.extensions['.js'];

    debug('ctx-module:load')(loader.name, filename);

    try 
    {
      loader(module, filename);
    } 
    catch (error) 
    {
      delete moduleCache[filename];
      throw error;
    }

    module.loaded = true;
    return module;
  }
  
  /**
   * Locate a module file, given the base filename. This is where we handle resolution of various extensions, 
   * index.js, package.json 'main' property, etc. The base filename would also be the canonical module identifier
   * in most cases (special case for /index when we recurse).
   *
   * @param {string} filenameBase   rooted path plus most of filename
   */
  function locateModuleFile(filenameBase)
  {
    var filename;

    if (fs.existsSync(filename = `${filenameBase}/package.json`))
    {
      const pkg = JSON.parse(fs.readFileSync(filename, 'utf-8'));
      return locateModuleFile(relativeResolve(filenameBase, pkg.main || 'index.js'));
    }

    try
    {
      const sb = fs.statSync(filenameBase); /* no throw => either filenameBase is a module file or its directory */

      if (sb.mode & fs.constants.S_IFDIR)
      {
        if (!filenameBase.endsWith('/index'))
          if ((filename = locateModuleFile(`${filenameBase}/index`)))
            return filename;
      }
      else
      {
        return filenameBase;
      }
    }
    catch(error)
    {
      if (error.code !== 'ENOENT')
        throw error;
    }

    for (let ext in that.require.extensions)
    {
      if (fs.existsSync(filename = `${filenameBase}${ext}`))
        return filename;
    }

    /* module not found */
    return false;
  }

  /* Create the exports for the module module; it is special because it needs access to our internals. */
  if (cnId === 'module')
  {
    this.exports._nodeModulePaths = makeNodeModulesPaths;
    
    /* Create a _cache property which looks like Node's, and intercept mutations
     * so that we can change moduleCache to match.
     */
    this.exports._cache = new Proxy(moduleCache, {
      get (_moduleCache, moduleIdentifier) {
        const retval = (true
                        && typeof moduleCache.hasOwnProperty(moduleIdentifier)
                        && moduleCache[moduleIdentifier] === 'object')
              ? moduleCache[moduleIdentifier]
              : undefined;
        return retval;
      },
      set (_moduleCache, moduleIdentifier, value) {
        if (!(value instanceof CtxModule))
          throw new Error('value must be an instance of CtxModule');
        moduleCache[moduleIdentifier] = value;
        return true;
      }
    });

    /* Wrapper to mimic Node's Module constructor */
    this.exports.Module = function Module(id = '', parentModule)
    {
      const req = parentModule?.require || this.require;
      const ret = new CtxModule(ctx, id, moduleCache, { require: req });
      return ret;
    }

    this.exports.createRequire = function ctxCreateRequire(filename) {
      const dummy = new CtxModule(ctx, filename, moduleCache);
      return dummy.require;
    };
    this.exports._resolveFilename = requireResolve;
  }
}

/**
 * Creates a new CtxModule with the given exports. We try to be smart and create a new exports object
 * so that it can be safely mutated, but when that's not possible, we use the original exports object
 * and just punch it through to the new ctx.
 *
 * Warning -- creating modules with this method runs the risk of context leakage.
 */
CtxModule.from = function ctxModuleFrom(ctx, exports)
{
  const module = new CtxModule(ctx);

  if (typeof exports !== 'object')
    module.exports = exports; /* needed for exports which are functions */
  else
  {
    if (exports.constructor !== Object)
      module.exports = new (exports.constructor); /* magic modules like process need this */
    copyProps(module.exports, exports);
  }

  return module;
}

/**
 * Create the exports for a ctx-specific vm module. This monkey-patches vm.runInThisContext, and
 * replaces the Script constructor with a subclass that has a patched Script.runInThisContext, so that
 * we understand "this context" to mean ctx and not the "real" node context that we pulled the vm
 * module from.
 */
function vmModuleExportsFactory(ctx)
{
  const exp = copyProps({}, vm);
  
  exp.runInThisContext = function runInThisContext(code, options) {
    return vm.runInContext(code, ctx, options);
  };

  class CtxScript extends vm.Script
  {
    constructor(code, options = {})
    {
      super(code, options);
    }

    runInThisContext(options)
    {
      return this.runInContext(ctx, options);
    }
  }

  exp.Script = CtxScript;
  return exp;
}

const defaultGlobals = {
  setTimeout:     globalThis.setTimeout,
  clearTimeout:   globalThis.clearTimeout,
  setInterval:    globalThis.setInterval,
  clearInterval:  globalThis.clearInterval,
  setImmediate:   globalThis.setImmediate,
  clearImmediate: globalThis.clearImmediate,
  queueMicrotask: globalThis.queueMicrotask,
  console:        globalThis.console,
};

/**
 * Factory function which creates a fresh context suitable for running NodeJS programs. Default
 * modules such as fs, os, vm, path, process, tty, etc, are linked from the calling context.
 *
 * @param {object} options            [optional] object with the following optional properties which
 *                                    override internal defaults:
 *                 - contextName      name of the context
 *                 - modules          an object used to prepopulate moduleCache so we can inject modules
 *                                    from the outer context. Each property name is either the canonical
 *                                    module identifier (usually a rooted pathname) or a search-path
 *                                    module identifier (eg "path"). Each property must be either a 
 *                                    string containing the module's filename, or an object
 *                                    containing the module's exports.
 */
exports.makeNodeProgramContext = function makeNodeProgramContext(options)
{
  const ctx = vm.createContext({}, {
    name: options?.contextName,
  });
  const myPackage = require('./package.json');
  const moduleCache = {};
  
  moduleCache.vm = CtxModule.from(ctx, vmModuleExportsFactory(ctx));
  moduleCache.module = new CtxModule(ctx, 'module', moduleCache); /* ctor magic knows how to make exports */
  
  for (let id in options?.modules)
  {
    if (typeof options.modules[id] === 'string')
      moduleCache[id] = options.modules[id];
    else
      moduleCache[id] = CtxModule.from(ctx, options.modules[id]);
  }

  Object.assign(ctx, defaultGlobals, options?.globals);
  ctx.module         = new CtxModule(ctx, require.main.filename, moduleCache);
  ctx.global         = ctx;
  ctx.require        = ctx.module.require;
  ctx.require.main   = ctx.module;

  const localRequire = ctx.require('module').createRequire(__filename);
  
  /* Load all of the built-in node modules from the "real" context into this context, unless it is
   * listed as a direct dependency of ctx-module, in which case we prepare to load the polyfill package 
   * from disk into the new context.
   */
  require('module').builtinModules.filter(cnId => /^[a-z]/.test(cnId)).forEach((cnId) => {
    if (!moduleCache[cnId] && cnId !== 'sys')
    {
      if (myPackage.dependencies[cnId])
        moduleCache[cnId] = localRequire.resolve(cnId);
      else if (myPackage.dependencies[`${cnId}-browserify`])
        moduleCache[cnId] = localRequire.resolve(`${cnId}-browserify`);
      else
        moduleCache[cnId] = CtxModule.from(ctx, require(cnId));
    }
  });

  ctx.process         = ctx.require('process');
  ctx.Buffer          = ctx.require('buffer').Buffer;
  ctx.URL             = ctx.require('url').URL;
  ctx.URLSearchParams = ctx.require('url').URLSearchParams;

  return ctx;
}

function copyProps(dst, src)
{
  const pds = Object.getOwnPropertyDescriptors(src);
  Object.defineProperties(dst, pds);
  return dst;
}

exports.CtxModule = CtxModule;
