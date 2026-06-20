// Metro config. BoardgameBuddy's native app is self-contained (no sibling
// shared/ folder), so this is the stock Expo config plus the Windows
// single-worker workaround.

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Windows + Node 22/24 has a known jest-worker IPC bug that throws
// `Error: write UNKNOWN` (errno -4094) when Metro spawns transform workers.
// Pinning to a single in-process worker on Windows sidesteps it.
// See https://github.com/jestjs/jest/issues/15486. Linux / macOS use the
// default worker pool for full speed.
if (process.platform === 'win32') {
  config.maxWorkers = 1;
}

module.exports = config;
