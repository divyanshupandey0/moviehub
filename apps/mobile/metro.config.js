const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');
const sharedPkgDir = path.resolve(monorepoRoot, 'packages/shared');
const subtitleSyncDir = path.resolve(monorepoRoot, 'modules/subtitle-sync');

const config = getDefaultConfig(projectRoot);

// Ensure Metro watches the monorepo root and workspace packages
config.watchFolders = [monorepoRoot, sharedPkgDir, subtitleSyncDir];

config.resolver.extraNodeModules = {
  '@filmsnaps/shared': sharedPkgDir,
  'expo-subtitle-sync': subtitleSyncDir,
  stream: require.resolve('readable-stream'),
  crypto: path.resolve(projectRoot, 'lib/nuvio/shims/cryptoShim.js'),
};

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

config.resolver.unstable_enablePackageExports = true;

module.exports = withNativeWind(config, { input: './app/globals.css' });
