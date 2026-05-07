module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      [
        'module-resolver',
        {
          alias: {
            '#shared': '../shared',
          },
        },
      ],
      // Reanimated 4 — plugin moved into react-native-worklets. Must remain last.
      'react-native-worklets/plugin',
    ],
  };
};
