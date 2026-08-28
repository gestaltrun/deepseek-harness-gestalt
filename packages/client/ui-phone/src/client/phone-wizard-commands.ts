/**
 * Command-level install guidance copied from the locked settings-card mockup.
 * Copy buttons write these strings verbatim.
 */

/** Download the Android emulator binary and the API 35 Google APIs ARM64 image. */
export const ANDROID_INSTALL_SYSTEM_IMAGE
  = 'sdkmanager --install "emulator" "system-images;android-35;google_apis;arm64-v8a"'

/** Create the Pixel_6_API_35 AVD using the API 35 Google APIs ARM64 image. */
export const ANDROID_CREATE_AVD
  = 'avdmanager create avd -n Pixel_6_API_35 -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_6'

/** Start the Pixel_6_API_35 AVD. */
export const ANDROID_LAUNCH_EMULATOR = 'emulator -avd Pixel_6_API_35'

/** Install Android platform-tools when adb is missing from PATH and ANDROID_HOME. */
export const ANDROID_INSTALL_PLATFORM_TOOLS = 'sdkmanager "platform-tools"'

/** Download the Xcode iOS simulator runtime. */
export const IOS_DOWNLOAD_PLATFORM = 'xcodebuild -downloadPlatform iOS'

/** Create an iPhone 16 Pro simulator targeting iOS 18.4. */
export const IOS_CREATE_SIMULATOR = 'xcrun simctl create "iPhone 16 Pro" "iPhone 16 Pro" iOS18.4'
