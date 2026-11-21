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
  manifest: () => {
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
      data_collection_permissions: {
        required: ['authenticationInfo', 'websiteContent', 'websiteActivity'],
        optional: [],
      },
    };

    const manifest: UserManifest = {
      name: 'Citizen Hangar Pledge Sync',
      description:
        'Sync Robert Space Industries pledges to the Citizen Hangar backend; pairing and uploads',
      version: '1.4.0',
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
      // Firefox-specific manifest field recommended by AMO
      browser_specific_settings: { gecko },
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
