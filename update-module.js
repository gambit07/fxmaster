const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const ROOT = path.resolve(__dirname);
const tagName = `v${version}`;

const updater = require(path.join(ROOT, "manifest-version-updater.js"));

// ─── 1) Read & validate args ─────────────────────────────────────────────
const version = process.argv[2];
if (!version) {
  console.error("⛔  No version specified");
  process.exit(1);
}

// ─── 2) Update module.json via manifest-version-updater ────────────────
const MODULE_JSON = path.join(ROOT, "module.json");
const pkgContents = fs.readFileSync(MODULE_JSON, "utf8");
const updatedPkgJson = updater.writeVersion(pkgContents, version);
fs.writeFileSync(MODULE_JSON, updatedPkgJson, "utf8");
console.log(`✅ module.json updated to v${version}`);

// ─── 3) Prepend CHANGELOG.md from release_notes.txt ─────────────────
const NOTES_FILE = path.join(ROOT, "release_notes.txt");
const CHANGELOG_FILE = path.join(ROOT, "CHANGELOG.md");
if (fs.existsSync(NOTES_FILE)) {
  const notesRaw = fs.readFileSync(NOTES_FILE, "utf8").trim();
  const dtLocal = new Date().toLocaleString("en-US", { timeZone: "America/Detroit" });
  const dt = new Date(dtLocal);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  const dateStr = `${yyyy}-${mm}-${dd}`;

  const newEntry = `## [v${version}] - ${dateStr}\n${notesRaw}`;
  let existing = "# Changelog\n\n";
  if (fs.existsSync(CHANGELOG_FILE)) existing = fs.readFileSync(CHANGELOG_FILE, "utf8");
  const [header, ...restLines] = existing.split(/\r?\n/);
  const rest = restLines.join("\n").replace(/^\s*\n+/, "");
  const updated = [header, newEntry, rest].join("\n\n");
  fs.writeFileSync(CHANGELOG_FILE, updated, "utf8");
  console.log(`📝  Prepended CHANGELOG.md entry for v${version}`);
} else {
  console.warn(`⚠️  release_notes.txt not found—skipping CHANGELOG update`);
}

// ─── 4) Commit module.json & CHANGELOG.md ─────────────────────────────
try {
  execSync('git config user.name "github-actions[bot]"');
  execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  execSync(`git add ${MODULE_JSON} ${CHANGELOG_FILE}`, { stdio: "inherit" });
  execSync(`git commit -m "chore(release): v${version}"`, { stdio: "inherit" });
  console.log("💾  Committed module.json and CHANGELOG.md");
} catch {
  console.log("ℹ️  Nothing to commit");
}

// ─── 5) Build & minify via Rollup ───────────────────────────────────────
console.log("🚀  Building (production) & minifying…");
execSync("npm run build", {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
});

// ─── 6) Package dist/ into module.zip via archiver ──────────────────────
console.log("📦  Creating module.zip from dist (using archiver)");
const archiver = require("archiver");
const DIST_DIR = path.join(ROOT, "dist");
const zipPath = path.join(ROOT, "module.zip");

const output = fs.createWriteStream(zipPath);
const archive = archiver("zip", { zlib: { level: 9 } });

output.on("close", () => {
  console.log(`✅ module.zip created (${archive.pointer()} bytes)`);

  // ─── 7) Create GitHub Release & upload assets ────────────────────────────
  try {
    console.log(`🏷  Creating GitHub release v${version}`);
    const ghCmd = [
      "gh release create",
      tagName,
      `--title "Release ${version}"`,
      `--notes-file ${NOTES_FILE}`,
      "module.zip",
      "module.json",
    ].join(" ");
    execSync(ghCmd, { cwd: ROOT, stdio: "inherit" });
    console.log(`✅  GitHub release ${version} created with module.zip & module.json`);
  } catch (err) {
    console.error("❌  gh release create failed", err);
    process.exit(1);
  }

  console.log("🎉  Release script complete!");
});

archive.on("error", (err) => {
  throw err;
});
archive.pipe(output);
archive.directory(DIST_DIR, false);
archive.finalize();
