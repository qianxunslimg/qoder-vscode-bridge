const Module = require('node:module');
const path = require('node:path');
const originalLoad = Module._load;
const mockPath = path.join(__dirname, 'vscode-mock-runtime.cjs');

Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return originalLoad(mockPath, parent, isMain);
  }
  return originalLoad(request, parent, isMain);
};
