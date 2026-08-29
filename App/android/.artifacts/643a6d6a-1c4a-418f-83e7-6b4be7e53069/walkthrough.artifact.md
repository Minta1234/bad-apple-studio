# Walkthrough - Fix `VerifyException` (Thai Calendar Issue)

I have fixed the `com.google.common.base.VerifyException` that was failing the `:app:mergeDebugJavaResource` task.

## Changes Made

### Build Configuration

#### [gradle.properties](file:///C:/Users/SystemAdmin/Desktop/Coding/Project/bad-apple-studio/App/android/gradle.properties)
I updated the `org.gradle.jvmargs` to include flags that force the Gradle JVM to use the English (US) locale. This ensures a Gregorian calendar is used during the build process, avoiding the MS-DOS date format overflow caused by the Thai Buddhist calendar.

```diff
-org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
+org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8 -Duser.language=en -Duser.country=US
```

## Verification Results

### Automated Tests
- Executed `./gradlew --stop` to clear existing daemons.
- Executed `./gradlew clean :app:assembleDebug`.
- **Result**: Build finished successfully.

> [!TIP]
> This fix is environment-specific and persistent within the project. It ensures that any developer building this project, regardless of their system locale, will use a compatible calendar for Gradle tasks.
