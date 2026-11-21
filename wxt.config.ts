import { defineConfig, type UserManifest } from 'wxt';
import path from 'path';

const userDataDir = path.resolve(process.cwd(), '.wxt', 'chrome-data').replace(/\\/g, '/');

export default defineConfig({
  // Generated coverage contains machine-specific paths and is only a CI artifact.
  zip: {
    excludeSources: ['coverage', 'coverage/**', '.coverage-compiled', '.coverage-compiled/**'],
  },
  vite: () => ({
    define: {
      'process.env.CH_BUILD_PROFILE': JSON.stringify(process.env.CH_BUILD_PROFILE || 'production'),
    },
  }),
  manifest: ({ browser }) => {
    const isDev = process.env.CH_BUILD_PROFILE === 'development';
    const hostPermissionsBase = [
      'https://citizenhangar.space/*',
      'https://robertsspaceindustries.com/*',
    ];
    const host_permissions = isDev
      ? [...hostPermissionsBase, 'http://localhost/*', 'http://127.0.0.1/*']
      : hostPermissionsBase;

    const gecko = {
      id: 'citizenhangar@sctr.space',
      strict_min_version: '124.0',
      data_collection_permissions: {
        required: ['authenticationInfo', 'websiteContent', 'websiteActivity'],
        optional: [],
      },
    };

    const manifest: UserManifest = {
      name: 'Citizen Hangar Pledge Sync',
      description:
        'Sync Robert Space Industries pledges to the Citizen Hangar backend; pairing and uploads',
      action: {
        default_popup: 'entrypoints/popup/index.html',
      },
      icons: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
      background: {
        service_worker: 'entrypoints/background.js',
      },
      // AbortSignal.any is used to combine request deadlines with cancellation.
      ...(browser === 'firefox'
        ? { browser_specific_settings: { gecko } }
        : { minimum_chrome_version: '116' }),
      permissions: ['storage', 'alarms'],
      host_permissions,
      // content scripts are declared via `defineContentScript` in entrypoints/content.ts
    };

    return manifest;
  },

  // Persist browser profile between `wxt dev` runs (see WXT docs: Persist Data)
  webExt: {
    chromiumArgs: [`--user-data-dir=${userDataDir}`],
  },
});
