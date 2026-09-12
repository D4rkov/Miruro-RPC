#!/usr/bin/env node
/**
 * One-command release:
 *   npm run ship
 *
 * - Syncs version across package.json / userscript / bridge
 * - Commits any pending work
 * - Bumps patch version (or: npm run ship -- minor|major)
 * - Pushes commit + tag → GitHub Actions builds & publishes the .exe
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const bump = (process.argv[2] || "patch").toLowerCase();

if (!["patch", "minor", "major"].includes(bump)) {
  console.error(`Unknown bump "${bump}". Use: patch | minor | major`);
  process.exit(1);
}

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  return execSync(cmd, {
    cwd: root,
    stdio: "inherit",
    ...opts
  });
}

function runOut(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function writeJson(file, data) {
  fs.writeFileSync(
    path.join(root, file),
    JSON.stringify(data, null, 2) + "\n"
  );
}

function bumpSemver(version, type) {
  const parts = version.split(".").map((n) => Number(n));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Bad version: ${version}`);
  }
  let [major, minor, patch] = parts;
  if (type === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (type === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function syncVersionFiles(version) {
  const pkg = readJson("package.json");
  pkg.version = version;
  writeJson("package.json", pkg);

  const bridgePath = path.join(root, "MiruroRPC.js");
  let bridge = fs.readFileSync(bridgePath, "utf8");
  bridge = bridge.replace(
    /const VERSION = "[^"]+";/,
    `const VERSION = "${version}";`
  );
  fs.writeFileSync(bridgePath, bridge);

  const userPath = path.join(root, "miruro.user.js");
  let userscript = fs.readFileSync(userPath, "utf8");
  userscript = userscript.replace(
    /^\/\/ @version\s+.+$/m,
    `// @version      ${version}`
  );
  fs.writeFileSync(userPath, userscript);
}

// Must be on main (or allow any branch but warn)
try {
  runOut("git rev-parse --is-inside-work-tree");
} catch {
  console.error("Not a git repo.");
  process.exit(1);
}

const branch = runOut("git branch --show-current");
if (branch !== "main" && branch !== "master") {
  console.warn(`Warning: you are on "${branch}", not main.`);
}

// Commit pending work so version bump can run cleanly
const dirty = runOut("git status --porcelain");
if (dirty) {
  console.log("\nCommitting current changes before release…");
  run("git add -A");
  try {
    run('git commit -m "chore: prepare release"');
  } catch {
    // nothing staged / hooks / etc.
  }
}

const current = readJson("package.json").version;
const next = bumpSemver(current, bump);

console.log(`\nReleasing ${current} → ${next} (${bump})\n`);
syncVersionFiles(next);

run("git add package.json package-lock.json MiruroRPC.js miruro.user.js");
// package-lock may also get version via npm — refresh lock version field
try {
  const lockPath = path.join(root, "package-lock.json");
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    lock.version = next;
    if (lock.packages && lock.packages[""])
      lock.packages[""].version = next;
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
    run("git add package-lock.json");
  }
} catch { /* ignore */ }

run(`git commit -m "release: v${next}"`);
run(`git tag v${next}`);

console.log("\nPushing commit + tag (GitHub Actions will build the .exe)…\n");
run("git push");
run("git push --tags");

console.log(`
Done.
- GitHub Actions → builds MiruroRPC-Setup-${next}.exe and publishes the Release
- Userscript @version is ${next} (Tampermonkey will pick it up from main)
- Installed tray apps will auto-update from the new Release
`);
