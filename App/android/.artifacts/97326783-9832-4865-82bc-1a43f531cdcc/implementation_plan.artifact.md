# Fix FFmpegKit Resolution Issue

The build is failing because `com.arthenica:ffmpeg-kit-full:6.0-2` has been removed from Maven Central following the retirement of the original FFmpegKit project. The recommended solution is to migrate to the community-maintained fork, which is a drop-in replacement.

## Proposed Changes

### [app](file:///C:/Users/SystemAdmin/Desktop/Coding/Project/bad-apple-studio/App/android/app)

#### [MODIFY] [build.gradle.kts](file:///C:/Users/SystemAdmin/Desktop/Coding/Project/bad-apple-studio/App/android/app/build.gradle.kts)
- Update the FFmpegKit dependency from `com.arthenica:ffmpeg-kit-full:6.0-2` to `dev.ffmpegkit-maintained:ffmpeg-kit-full:8.1.7`.

## Verification Plan

### Automated Tests
- Run `./gradlew :app:assembleDebug` to verify that the dependency resolves and the project builds successfully.
- Verify that the configuration cache issue is resolved as a result.

### Manual Verification
- None required as the package names remain unchanged.
