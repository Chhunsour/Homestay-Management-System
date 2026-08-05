import type { ExpoConfig } from 'expo/config';

// Deep-link scheme drives the OAuth redirect, so it stays environment-driven.
const scheme = process.env.EXPO_PUBLIC_APP_SCHEME ?? 'homestay';

const config: ExpoConfig = {
  name: 'Homestay Manager',
  slug: 'homestay-manager',
  scheme,
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  ios: {
    bundleIdentifier: 'com.homestay.manager',
    supportsTablet: true,
  },
  android: {
    package: 'com.homestay.manager',
  },
  plugins: [
    'expo-router',
    [
      // Native permission strings live in the manifest, so they cannot come from
      // the i18n dictionary. The in-app copy is translated.
      'expo-image-picker',
      { photosPermission: 'Allow $(PRODUCT_NAME) to use your photos for property images.' },
    ],
  ],
};

export default config;
