# Fix for com.google.common.base.VerifyException in MsDosDateTimeUtils

The build failure `com.google.common.base.VerifyException` in `MsDosDateTimeUtils.packDate` is a known issue occurring when the system locale uses a calendar (like the Buddhist calendar) where the current year exceeds the MS-DOS limit of 2107. For the year 2026, the Buddhist calendar year is 2569, which triggers this verification failure in the Android Gradle Plugin.

## User Review Required

> [!NOTE]
> This change forces the Gradle worker processes to use the `en-US` locale (Gregorian calendar) to ensure compatibility with MS-DOS date formats used in APK/JAR zipping. This only affects the build environment and not your app's runtime locale.

## Proposed Changes

### Build Configuration

#### [MODIFY] [gradle.properties](file:///C:/Users/SystemAdmin/Desktop/Coding/Project/bad-apple-studio/App/android/gradle.properties)
Update `org.gradle.jvmargs` to include `-Duser.language=en -Duser.country=US`.

## Verification Plan

### Automated Tests
- Run the failing task: `gradlew :app:mergeDebugJavaResource` (or a full build `gradlew assembleDebug`).

### Manual Verification
- Verify that the build completes without the `VerifyException`.
