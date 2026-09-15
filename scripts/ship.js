#!/usr/bin/env node
/**
 * One-command release:
 *   npm run ship
 *
 * - Commits any pending work (do NOT bump versions by hand)
 * - Bumps from the latest git tag (patch by default; or: npm run ship -- minor|major)
 * - Syncs package.json / userscript / bridge to that version
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

function parseSemver(version) {
  const parts = String(version).replace(/^v/, "").split(".").map((n) => Number(n));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n)))
    return null;
  return parts;
}

function bumpSemver(version, type) {
  const parts = parseSemver(version);
  if (!parts)
    throw new Error(`Bad version: ${version}`);

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

function cmpSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb)
    return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i])
      return pa[i] - pb[i];
  }
  return 0;
}

/** Latest vX.Y.Z tag on this repo (local), or null. */
function latestVersionTag() {
  let tags = "";
  try {
    tags = runOut("git tag -l \"v*\" --sort=-v:refname");
  } catch {
    return null;
  }

  for (const line of tags.split(/\r?\n/)) {
    const tag = line.trim();
    if (parseSemver(tag))
      return tag.replace(/^v/, "");
  }
  return null;
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

function syncLockfile(version) {
  const lockPath = path.join(root, "package-lock.json");
  if (!fs.existsSync(lockPath))
    return;

  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.version = version;
  if (lock.packages && lock.packages[""])
    lock.packages[""].version = version;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
}

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

// Commit pending work so the release commit only contains the version bump.
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

const pkgVersion = readJson("package.json").version;
const tagged = latestVersionTag();
const base = tagged || pkgVersion;

if (tagged && cmpSemver(pkgVersion, tagged) !== 0) {
  console.warn(
    `\nNote: package.json is ${pkgVersion} but latest tag is v${tagged}.` +
      `\nShip always bumps from the latest tag — do not edit versions by hand.\n`
  );
}

const next = bumpSemver(base, bump);

if (tagged && cmpSemver(next, tagged) <= 0) {
  console.error(`Refusing to release v${next}: latest tag is already v${tagged}.`);
  process.exit(1);
}

// Tag must not already exist (e.g. failed mid-ship).
try {
  runOut(`git rev-parse -q --verify "refs/tags/v${next}"`);
  console.error(`Tag v${next} already exists. Fix tags before shipping again.`);
  process.exit(1);
} catch {
  // missing tag — good
}

console.log(`\nReleasing v${base} → v${next} (${bump}, from latest tag)\n`);
syncVersionFiles(next);
syncLockfile(next);

run("git add package.json package-lock.json MiruroRPC.js miruro.user.js");
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
