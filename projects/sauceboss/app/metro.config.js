// Metro config — exposes the sibling shared/ folder to Metro and aliases #shared.
//
// Two key bits make the cross-folder import work:
//   1. `watchFolders` includes ../shared so Metro picks up file changes there.
//   2. `nodeModulesPaths` is explicit so files compiled from ../shared still
//      resolve runtime helpers (e.g. @babel/runtime) from the app's own
//      node_modules instead of looking next to themselves.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '..', 'shared');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [sharedRoot];

config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];

config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  '#shared': sharedRoot,
};

module.exports = config;
