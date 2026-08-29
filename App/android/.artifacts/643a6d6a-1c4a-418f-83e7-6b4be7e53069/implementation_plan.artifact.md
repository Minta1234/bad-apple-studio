# Implementation Plan - Fix `VerifyException` in `MsDosDateTimeUtils`

The build error `com.google.common.base.VerifyException` at `MsDosDateTimeUtils.packDate` is a known issue caused by the system locale using a non-Gregorian calendar (specifically the Thai Buddhist calendar). The MS-DOS date format has a year limit of 2107. When the Thai calendar is used, the year 2026 is interpreted as 2569, which exceeds this limit.

## Proposed Changes

### Build Configuration

#### [MODIFY] [gradle.properties](file:///C:/Users/SystemAdmin/Desktop/Coding/Project/bad-apple-studio/App/android/gradle.properties)
- Add `-Duser.language=en -Duser.country=US` to `org.gradle.jvmargs` to force the Gradle JVM to use a Gregorian-compatible locale.

## Verification Plan

### Automated Tests
1. Stop the current Gradle daemon using `./gradlew --stop`.
2. Run a clean build: `./gradlew clean :app:assembleDebug`.

### Manual Verification
1. Verify that the `:app:mergeDebugJavaResource` task completes successfully.
