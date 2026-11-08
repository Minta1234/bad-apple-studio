const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const pkgPath = path.join(rootDir, 'package.json');
const pkgLockPath = path.join(rootDir, 'package-lock.json');
const gradlePath = path.join(rootDir, 'App', 'android', 'app', 'build.gradle.kts');
const changelogPath = path.join(rootDir, 'CHANGELOG.md');

// 1. Read package.json
if (!fs.existsSync(pkgPath)) {
  console.error('Error: package.json not found at', pkgPath);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const currentVersion = pkg.version || '1.0.0';
const arg = (process.argv[2] || 'patch').trim().toLowerCase();

let newVersion = '';

// Check if arg is explicit semver e.g. "4.0.2"
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  newVersion = arg;
} else {
  const parts = currentVersion.split('.').map(n => parseInt(n, 10));
  while (parts.length < 3) parts.push(0);

  if (arg === 'major') {
    newVersion = `${parts[0] + 1}.0.0`;
  } else if (arg === 'minor') {
    newVersion = `${parts[0]}.${parts[1] + 1}.0`;
  } else if (arg === 'patch') {
    newVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  } else {
    console.error(`Invalid version bump argument: "${arg}". Use "patch", "minor", "major", or explicit version like "4.0.2".`);
    process.exit(1);
  }
}

console.log(`Bumping version: ${currentVersion} -> ${newVersion}`);

// 2. Update package.json
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('✔ Updated package.json');

// 3. Update package-lock.json if present
if (fs.existsSync(pkgLockPath)) {
  try {
    const pkgLock = JSON.parse(fs.readFileSync(pkgLockPath, 'utf8'));
    pkgLock.version = newVersion;
    if (pkgLock.packages && pkgLock.packages['']) {
      pkgLock.packages[''].version = newVersion;
    }
    fs.writeFileSync(pkgLockPath, JSON.stringify(pkgLock, null, 2) + '\n', 'utf8');
    console.log('✔ Updated package-lock.json');
  } catch (err) {
    console.warn('Warning: Could not update package-lock.json:', err.message);
  }
}

// 4. Update App/android/app/build.gradle.kts
if (fs.existsSync(gradlePath)) {
  let gradleContent = fs.readFileSync(gradlePath, 'utf8');
  let updatedGradle = gradleContent;

  // Bump versionCode
  const codeMatch = gradleContent.match(/versionCode\s*=\s*(\d+)/);
  let nextCode = 1;
  if (codeMatch) {
    nextCode = parseInt(codeMatch[1], 10) + 1;
    updatedGradle = updatedGradle.replace(/versionCode\s*=\s*(\d+)/, `versionCode = ${nextCode}`);
  }

  // Update versionName
  updatedGradle = updatedGradle.replace(/versionName\s*=\s*"[^"]*"/, `versionName = "${newVersion}"`);

  if (updatedGradle !== gradleContent) {
    fs.writeFileSync(gradlePath, updatedGradle, 'utf8');
    console.log(`✔ Updated App/android/app/build.gradle.kts (versionCode = ${nextCode}, versionName = "${newVersion}")`);
  }
}

// 5. Update CHANGELOG.md if present
if (fs.existsSync(changelogPath)) {
  let changelog = fs.readFileSync(changelogPath, 'utf8');
  const targetHeader = `## v${newVersion}`;
  if (!changelog.includes(targetHeader)) {
    const template = `\n## v${newVersion}\n\n### 🖥️ Desktop App (Electron)\n- Updates and improvements.\n\n### 📱 Android APK\n- Updates and improvements.\n\n---\n`;
    
    // Insert right after top heading if present
    const topMatch = changelog.match(/^#\s*[^\n]+\n+/);
    if (topMatch) {
      changelog = changelog.slice(0, topMatch[0].length) + template + changelog.slice(topMatch[0].length);
    } else {
      changelog = template + changelog;
    }
    fs.writeFileSync(changelogPath, changelog, 'utf8');
    console.log(`✔ Added v${newVersion} section template to CHANGELOG.md`);
  }
}

console.log(`\nNew Version: ${newVersion}`);
console.log(`Git Tag: ReleaseV${newVersion}`);

// Write outputs to GitHub Actions output environment if available
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${newVersion}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=ReleaseV${newVersion}\n`);
}

