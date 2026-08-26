import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.alibaba.gestalt.mobile',
  appName: 'DeepSeek Gestalt',
  webDir: 'dist',
  bundledWebRuntime: false,
  loggingBehavior: 'none',
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
}

export default config
