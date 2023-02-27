#! /usr/bin/env node
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
  const fs = require('fs');
  const vm = require('vm');
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
        '.js': loadJSModule,
        '.json': loadJSONModule,
      },
    };
  }

  if (cnId) /* false => completely virtual exports-only module, via Module.from */
  {
    this.filename = cnId;
    this.path = dirname(this.filename);
    this.paths = makeNodeModulesPaths(this.path);
  }

  /** Creates the path list for module.paths, eg
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
      paths.push(pathResolve(`${path}/node_modules`));
      if (path === '/')
        break;
    }

    return paths;
  }

  /** Implementation of require() for this module */
  this.require = function ctxRequire(moduleIdentifier)
  {
    try
    {     
      if (typeof moduleCache[moduleIdentifier] === 'object')
        return moduleCache[moduleIdentifier].exports;

      const filenameBase = requireResolve(moduleIdentifier);
      if (typeof moduleCache[filenameBase] === 'object')
        return moduleCache[filenameBase].exports;
      
      const moduleFilename = locateModuleFile(filenameBase);
      if (typeof moduleCache[moduleFilename] === 'object')
        return moduleCache[moduleFilename].exports;

      const module = moduleFilename && loadModule(moduleFilename);
      if (!module)
        throw new Error(`module not found -- require('${moduleIdentifier}') from ${that.filename || that.id}`);

      return module.exports;
    }
    catch(error)
    {
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
  }

  /* Decorate new module's require with API properties */
  this.require.id = cnId;
  this.require.resolve = requireResolve;
  if (parent && parent.require)
  {
    this.require.extensions = parent.require.extensions;
    this.require.path       = parent.require.path;
    this.require.main       = parent.require.main;
  }
  
  function dirname(pathname)
  {
    pathname = pathname
      .replace(/\/$/, '')         /* strip trailing slash */
      .replace(/\/[^/]+$/, '');   /* strip last slash to end */
    
    return pathname || '/';
  }

  function pathResolve(pathname)
  {
    if (pathname.startsWith('./') || pathname.startsWith('../'))
      pathname = that.path + '/' + pathname;

    pathname = pathname
      .replace(/[^\/]+\/\.\.\//g, '') /* /xyz/.. becomes / */
      .replace(/\/\.\//g, '/')        /* /./     becomes / */
      .replace(/\/\//g, '/');         /* //      becomes / */

    return pathname;
  }
  
  /**
   * Search require.path and module.path to map a module identifier onto
   * a full pathname.
   */
  function requireResolve(moduleIdentifier)
  {
    moduleIdentifier = pathResolve(moduleIdentifier);
    if (typeof moduleCache[moduleIdentifier] === 'object')
      return moduleIdentifier;
    if (typeof moduleCache[moduleIdentifier] === 'string')
      moduleIdentifier = moduleCache[moduleIdentifier];
    if (moduleIdentifier[0] !== '/')
    {
      let searchPath = that.require.path;
      if (that.paths.length)
        searchPath = that.require.path.length ? that.require.path.concat(that.paths) : that.paths;

      for (const path of searchPath)
      {
        const moduleFilename = locateModuleFile(`${pathResolve(path)}/${moduleIdentifier}`);
        if (moduleFilename)
          return moduleFilename;
      }
    }
    return moduleIdentifier;
  }

  function loadJSModule(module, filename)
  {
    const moduleCode = fs.readFileSync(module.filename, 'utf-8');
    var moduleFun;
    
    /* Evaluate the module code and return its exports. We use IIFE as namespace and arguments for
     * symbol names. Fully-formed function provides unique 'this'. Newline in epilogue pushes past // comments,
     * and offset of prologue is accounted for so that stack traces will be accurate.
     */
    try
    {
      const prologue = `(require, exports, module, __filename, __dirname) => {/* ctxModule ${module.filename} */`;
      const epilogue = '\n}';

      moduleFun = vm.runInContext(prologue + moduleCode + epilogue,ctx, {
        filename: filename,
        lineOffset: 0,
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
    that.exports = module.exports; /* non-CJS idiom: re-assign module.exports */
  }

  function loadJSONModule(module, filename)
  {
    Object.assign(module.exports, JSON.parse(fs.readFileSync(filename, 'utf-8')));
  }

  function loadModule(filename)
  {
    const module = moduleCache[filename] = new CtxModule(ctx, filename, moduleCache, { require: that.require });
    const match = filename.match(/\.[a-z]*$/);
    const ext = match && match[0];

    /* use either the correct-named or the .js loader to load this file as a module */
    const loader = that.require.extensions[ext] || that.require.extensions['.js'];

    loader(module, filename);
    module.loaded = true;
    return module;
  }
  
  /**
   * Locate a module file, given the base filename. This is where we handle resolution of various extensions, 
   * index.js, package.json 'main' property, etc.
   *
   * @param {string} filenameBase   rooted path plus most of filename
   */
  function locateModuleFile(filenameBase)
  {
    var filename;

    if (fs.existsSync(filename = `${filenameBase}/package.json`))
    {
      const pkg = JSON.parse(fs.readFileSync(filename, 'utf-8'));
      return locateModuleFile(pathResolve(`${filenameBase}/${pkg.main || 'index.js'}`));
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

  if (cnId === 'module')
  {
    this.exports._resolveFilename = requireResolve;
    this.exports._nodeModulePaths = makeNodeModulesPaths;
    
    /* Create a _cache property which looks like Node's, and intercept mutations
     * so that we can change moduleCache to match.
     */
    this.exports._cache = new Proxy(moduleCache, {
      get (_moduleCache, moduleIdentifier) {
        return typeof moduleCache[moduleIdentifier] === 'object' ? moduleCache[moduleIdentifier] : undefined;
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
    Object.assign(module.exports, exports);
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
  const vm = require('vm');
  const exp = Object.assign({}, vm);
  
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
exports.makeNodeProgramContext = function makeNodeProgramContext(contextName, moreModules)
{
  const vm = require('vm');
  const ctx = vm.createContext({}, {
    name: contextName,
  });

  const moduleCache = {};
  moduleCache.vm = CtxModule.from(ctx, vmModuleExportsFactory(ctx));
  moduleCache.module = new CtxModule(ctx, 'module', moduleCache); /* ctor magic knows how to make exports */

  require('module').builtinModules.filter(cnId => /^[a-z]/.test(cnId)).forEach((cnId) => {
    if (!moduleCache[cnId] && cnId !== 'sys')
      moduleCache[cnId] = CtxModule.from(ctx, require(cnId));
  });

  ctx.module         = new CtxModule(ctx, require.main.filename, moduleCache);
  ctx.global         = ctx;
  ctx.require        = ctx.module.require;
  ctx.require.main   = ctx.module;
  ctx.process        = ctx.require('process');
  ctx.setTimeout     = global.setTimeout;
  ctx.clearTimeout   = global.clearTimeout;
  ctx.setInterval    = global.setInterval;
  ctx.clearInterval  = global.clearInterval;
  ctx.setImmediate   = global.setImmediate;
  ctx.clearImmediate = global.clearImmediate;
  ctx.queueMicrotask = global.queueMicrotask;
  ctx.console        = global.console;
  ctx.URL            = global.URL;
  ctx.Buffer         = global.Buffer;
  
  if (moreModules)
    Object.assign(moduleCache, moreModules);

  return ctx;
}
