// Metro config — self-contained. Unlike sauceboss, BoardgameBuddy native does
// NOT consume a sibling shared/ folder; all logic lives under app/src. So this
// is just the default Expo config plus the Windows single-worker guard.

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Windows + Node 22/24 has a known jest-worker IPC bug that throws
// `Error: write UNKNOWN` (errno -4094) when Metro spawns transform workers.
// Pinning to a single in-process worker on Windows sidesteps it.
if (process.platform === 'win32') {
  config.maxWorkers = 1;
}

module.exports = config;
