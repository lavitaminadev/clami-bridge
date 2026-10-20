'use strict';

const Module = require('node:module');
const path = require('node:path');

// Passenger/cPanel commonly looks for app.js as the application entry point.
// CloudLinux Node Selector can expose modules through NODE_PATH while Passenger
// loads this CommonJS file through its own wrapper. Honor it before loading app code.
const selectorPaths = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
if (selectorPaths.length) {
  Module._initPaths();
  const originalNodeModulePaths = Module._nodeModulePaths;
  Module._nodeModulePaths = function nodeSelectorModulePaths(from) {
    return [...new Set([...selectorPaths, ...originalNodeModulePaths.call(this, from)])];
  };
}

const { start } = require('./server');

start().catch((error) => {
  console.error('Startup failed:', error instanceof Error ? error.message : 'unknown_error');
  process.exit(1);
});
