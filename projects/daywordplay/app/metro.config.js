// Metro config — exposes the sibling shared/ folder to Metro and aliases #shared.
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
