import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.gestalt.mobile',
  appName: '獭子哥',
  webDir: 'dist',
  bundledWebRuntime: false,
  loggingBehavior: 'none',
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
}

export default config
