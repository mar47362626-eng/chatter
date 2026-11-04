# Chatter Android app

This Android Studio project wraps the live Chatter app at `https://chatter-n6rv.onrender.com/app` in a native Android WebView. It has a branded loading screen, a retry screen for network errors, safe-area-aware system bars, and camera/microphone permission support for browser calls.

## Build an installable APK

1. Install Android Studio (including its Android SDK) and a JDK supported by Android Studio.
2. Open this `android` folder in Android Studio and allow Gradle sync to finish.
3. Use **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
4. Android Studio writes the debug APK to `app/build/outputs/apk/debug/app-debug.apk`.
5. To share a release build, use **Build → Generate Signed Bundle / APK… → APK** and keep your signing key private.

The latest automatically built APK can be downloaded from the [Chatter Android releases](https://github.com/mar47362626-eng/chatter/releases/latest). Open the release and download `chatter.apk`; share that release page with Android users. This is a debug-signed APK, so Android may ask users to allow installation from their browser or file manager. The APK opens the live Chatter app and needs an internet connection.

The APK needs internet access and uses the same Chatter account and server as the web app. The Android SDK and Java are not bundled in this project.
