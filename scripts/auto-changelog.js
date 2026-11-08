const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const pkgPath = path.join(rootDir, 'package.json');
const pkgLockPath = path.join(rootDir, 'package-lock.json');
const gradlePath = path.join(rootDir, 'App', 'android', 'app', 'build.gradle.kts');
const changelogPath = path.join(rootDir, 'CHANGELOG.md');

function run(cmd) {
  try {
    return execSync(cmd, { cwd: rootDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return '';
  }
}

// 1. Find last release tag
let lastTag = run('git describe --tags --abbrev=0');
let commitRange = '';

if (lastTag) {
  commitRange = `${lastTag}..HEAD`;
} else {
  commitRange = 'HEAD~5..HEAD';
}

console.log(`Analyzing commits in range: ${commitRange}`);
const rawCommits = run(`git log ${commitRange} --pretty=format:"%h|%s"`);

if (!rawCommits) {
  console.log('No new commits found since last tag.');
  process.exit(0);
}

const lines = rawCommits.split('\n').map(l => l.trim()).filter(Boolean);
if (lines.length === 0) {
  console.log('No commit messages to process.');
  process.exit(0);
}

// Categorize commits & determine bump
const categories = {
  feat: { title: '🚀 New Features', items: [] },
  fix: { title: '🐛 Bug Fixes & Stability', items: [] },
  perf: { title: '⚡ Performance Improvements', items: [] },
  refactor: { title: '♻️ Refactoring', items: [] },
  other: { title: '🔧 Maintenance & Enhancements', items: [] },
};

let bumpType = 'patch'; // default to patch for any new changes
let hasBreaking = false;
let hasFeat = false;
let hasFix = false;

lines.forEach(line => {
  const [hash, ...rest] = line.split('|');
  const subject = rest.join('|').trim();

  // Ignore auto release commits to prevent loops
  if (/^chore\(release\):/i.test(subject) || /^Release\s*v/i.test(subject)) {
    return;
  }

  if (/BREAKING[- ]CHANGE/i.test(subject) || /^[a-z]+!:/i.test(subject)) {
    hasBreaking = true;
    categories.feat.items.push(`- **${subject}** (${hash})`);
    return;
  }

  const match = subject.match(/^([a-z]+)(?:\([^)]+\))?:\s*(.+)$/i);
  if (match) {
    const type = match[1].toLowerCase();
    const desc = match[2];

    if (type === 'feat') {
      hasFeat = true;
      categories.feat.items.push(`- ${desc} (${hash})`);
    } else if (type === 'fix') {
      hasFix = true;
      categories.fix.items.push(`- ${desc} (${hash})`);
    } else if (type === 'perf') {
      categories.perf.items.push(`- ${desc} (${hash})`);
    } else if (type === 'refactor') {
      categories.refactor.items.push(`- ${desc} (${hash})`);
    } else if (type === 'chore' || type === 'ci' || type === 'build') {
      categories.other.items.push(`- ${desc} (${hash})`);
    }
  } else {
    categories.other.items.push(`- ${subject} (${hash})`);
  }
});

if (hasBreaking) bumpType = 'major';
else if (hasFeat) bumpType = 'minor';
else if (hasFix) bumpType = 'patch';

// 2. Read current version & calculate new version
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const currentVersion = pkg.version || '1.0.0';
const parts = currentVersion.split('.').map(n => parseInt(n, 10));
while (parts.length < 3) parts.push(0);

let newVersion = '';
if (bumpType === 'major') newVersion = `${parts[0] + 1}.0.0`;
else if (bumpType === 'minor') newVersion = `${parts[0]}.${parts[1] + 1}.0`;
else newVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;

console.log(`Auto-detected bump: ${bumpType} (${currentVersion} -> ${newVersion})`);

// 3. Format changelog entry
let changelogEntry = `## v${newVersion}\n\n`;
let hasAnyItem = false;

for (const key of Object.keys(categories)) {
  const cat = categories[key];
  if (cat.items.length > 0) {
    changelogEntry += `### ${cat.title}\n${cat.items.join('\n')}\n\n`;
    hasAnyItem = true;
  }
}

if (!hasAnyItem) {
  changelogEntry += `### 🔧 Maintenance & Enhancements\n- Minor bug fixes and routine updates.\n\n`;
}

changelogEntry += `---\n`;

// 4. Update CHANGELOG.md
if (fs.existsSync(changelogPath)) {
  let changelog = fs.readFileSync(changelogPath, 'utf8');
  const targetHeader = `## v${newVersion}`;
  if (!changelog.includes(targetHeader)) {
    const topMatch = changelog.match(/^#\s*[^\n]+\n+/);
    if (topMatch) {
      changelog = changelog.slice(0, topMatch[0].length) + '\n' + changelogEntry + '\n' + changelog.slice(topMatch[0].length);
    } else {
      changelog = changelogEntry + '\n' + changelog;
    }
    fs.writeFileSync(changelogPath, changelog, 'utf8');
    console.log(`✔ Added v${newVersion} changelog to CHANGELOG.md`);
  }
}

// 5. Update package.json & package-lock.json
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('✔ Updated package.json');

if (fs.existsSync(pkgLockPath)) {
  try {
    const pkgLock = JSON.parse(fs.readFileSync(pkgLockPath, 'utf8'));
    pkgLock.version = newVersion;
    if (pkgLock.packages && pkgLock.packages['']) {
      pkgLock.packages[''].version = newVersion;
    }
    fs.writeFileSync(pkgLockPath, JSON.stringify(pkgLock, null, 2) + '\n', 'utf8');
    console.log('✔ Updated package-lock.json');
  } catch (_) {}
}

// 6. Update App/android/app/build.gradle.kts
if (fs.existsSync(gradlePath)) {
  let gradleContent = fs.readFileSync(gradlePath, 'utf8');
  let updatedGradle = gradleContent;

  const codeMatch = gradleContent.match(/versionCode\s*=\s*(\d+)/);
  let nextCode = 1;
  if (codeMatch) {
    nextCode = parseInt(codeMatch[1], 10) + 1;
    updatedGradle = updatedGradle.replace(/versionCode\s*=\s*(\d+)/, `versionCode = ${nextCode}`);
  }
  updatedGradle = updatedGradle.replace(/versionName\s*=\s*"[^"]*"/, `versionName = "${newVersion}"`);

  if (updatedGradle !== gradleContent) {
    fs.writeFileSync(gradlePath, updatedGradle, 'utf8');
    console.log(`✔ Updated App/android/app/build.gradle.kts (versionCode = ${nextCode}, versionName = "${newVersion}")`);
  }
}

// Export for GitHub Actions
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${newVersion}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=ReleaseV${newVersion}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `bump_type=${bumpType}\n`);
}

console.log(`\nSuccess! Updated to v${newVersion} (Tag: ReleaseV${newVersion})`);
