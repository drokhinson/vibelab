module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // Reanimated 4 — plugin moved into react-native-worklets. Must remain last.
      'react-native-worklets/plugin',
    ],
  };
};
