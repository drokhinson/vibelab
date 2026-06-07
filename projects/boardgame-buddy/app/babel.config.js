module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Reanimated 4 — plugin moved into react-native-worklets. Must remain last.
    plugins: ['react-native-worklets/plugin'],
  };
};
