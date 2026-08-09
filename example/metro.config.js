const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { getConfig } = require('react-native-builder-bob/metro-config');
const pkg = require('../package.json');

const root = path.resolve(__dirname, '..');

/**
 * Metro configuration
 * https://docs.expo.dev/guides/customizing-metro/
 *
 * @type {import('expo/metro-config').MetroConfig}
 */
const config = getConfig(getDefaultConfig(__dirname), {
  root,
  pkg,
  project: __dirname,
});

// Resolve the library to its TypeScript source rather than the built `lib/`
// output, so editing `src/` shows up on the next refresh with no build step.
//
// react-native-builder-bob normally does this from `babel-config`, with a
// `babel-plugin-module-resolver` alias inside a Babel `overrides` entry. That
// cannot be used here: the override is selected by a path pattern
// (`exclude: /\/node_modules\//`), and Expo's Babel transformer calls
// `loadPartialConfigSync` with no filename when it computes its cache key, so
// Babel rejects the whole config before the bundler ever starts:
//
//   ConfigError: Configuration contains string/RegExp pattern, but no filename
//   was passed to Babel
//
// Metro's resolver has no such constraint, and the alias is all bob's Babel
// config was contributing.
const sourceEntry = path.join(root, pkg.source);
const upstreamResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === pkg.name) {
    return { type: 'sourceFile', filePath: sourceEntry };
  }

  const next = upstreamResolveRequest || context.resolveRequest;
  return next(context, moduleName, platform);
};

module.exports = config;
