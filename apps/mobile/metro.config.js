// Metro configuration for the standalone mobile app.
//
// apps/mobile is NOT one of the root npm workspaces: it has its own node_modules. The only code it
// shares with the web app and the API is the TypeScript source of @holysai/shared
// (packages/shared/src), which Metro compiles directly — nothing is copied or pre-built.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '../../packages/shared');
const sharedEntry = path.join(sharedRoot, 'src/index.ts');

const config = getDefaultConfig(projectRoot);

// Let Metro see (and watch) the shared source outside the project root.
config.watchFolders = [...(config.watchFolders ?? []), sharedRoot];

// Resolve packages from this app's own node_modules first, so the root workspace's React
// (used by the web app) is never picked up by mistake.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];

const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@holysai/shared') {
    return { type: 'sourceFile', filePath: sharedEntry };
  }
  return defaultResolve ? defaultResolve(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
