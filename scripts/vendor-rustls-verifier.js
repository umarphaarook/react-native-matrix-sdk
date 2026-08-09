#!/usr/bin/env node

// Vendors the JVM half of the `rustls-platform-verifier` Rust crate into
// `android/libs`.
//
// matrix-sdk-ffi uses that crate to validate TLS certificates on Android. Its
// Kotlin classes ship inside a sibling crate (`rustls-platform-verifier-android`)
// as a small maven repository. Upstream documents wiring that repository up with
// a `cargo metadata` call at Gradle configuration time, but that would force
// every app consuming this package - and every CI runner building one - to have
// a Rust toolchain and a populated Cargo registry.
//
// We extract the aar's `classes.jar` instead (~9 KB) for two reasons:
//
//   * a consuming app resolves this module's dependencies against *its own*
//     repositories, so a maven repository declared in `android/build.gradle`
//     is never consulted and the coordinate fails to resolve;
//   * a local `.aar` file dependency is not supported for a library module,
//     while a local jar is.
//
// The aar carries no resources (its `R.txt` is empty and its manifest only
// declares `uses-sdk`), so the jar alone is sufficient.
//
// Run this after changing the pinned matrix-rust-sdk revision:
//
//     yarn vendor:rustls-verifier
//
// It resolves the crate through the same Rust source that ubrn is configured to
// build, so it follows both `crate.rev` and local `crate.directory` setups.
//
// Requires `cargo` and `unzip` on PATH.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..');
const PACKAGE = 'rustls-platform-verifier-android';
const ARTIFACT = 'rustls-platform-verifier';
const DEST = path.join(ROOT, 'android', 'libs');

function resolveManifestPath() {
  // Prefer a local override, so the side-by-side workflow keeps working.
  const configName =
    process.env.UBRN_CONFIG ||
    (fs.existsSync(path.join(ROOT, 'ubrn.local.yaml')) ? 'ubrn.local.yaml' : 'ubrn.yaml');
  const config = YAML.parse(fs.readFileSync(path.join(ROOT, configName), 'utf8'));
  const crate = config.rust || config.crate;
  if (!crate) {
    throw new Error(`No 'crate'/'rust' section found in ${configName}`);
  }

  // `directory` points at a checkout that is already on disk; `repo`+`rev` are
  // cloned by `ubrn checkout` into rust_modules.
  const workspace = crate.directory
    ? path.resolve(ROOT, crate.directory)
    : path.join(ROOT, 'rust_modules', path.basename(crate.repo, '.git'));

  const manifest = path.join(workspace, crate.manifestPath || 'Cargo.toml');
  if (!fs.existsSync(manifest)) {
    throw new Error(
      `Rust manifest not found at ${manifest}.\n` +
        `Run \`yarn ubrn:checkout\` first (or fix 'crate.directory' in ${configName}).`
    );
  }
  return { manifest, configName };
}

function findAar(manifestPath) {
  const raw = execFileSync(
    'cargo',
    [
      'metadata',
      '--format-version', '1',
      // The Android classes only appear in the Android dependency graph.
      '--filter-platform', 'aarch64-linux-android',
      '--manifest-path', manifestPath,
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );

  const pkg = JSON.parse(raw).packages.find((p) => p.name === PACKAGE);
  if (!pkg) {
    throw new Error(
      `${PACKAGE} is not in the dependency graph.\n` +
        `That likely means matrix-sdk-ffi no longer uses rustls-platform-verifier; if so, ` +
        `delete android/libs/${ARTIFACT}-*.jar and drop the dependency from android/build.gradle.`
    );
  }

  const aar = path.join(
    path.dirname(pkg.manifest_path),
    'maven', 'rustls', ARTIFACT, pkg.version,
    `${ARTIFACT}-${pkg.version}.aar`
  );
  if (!fs.existsSync(aar)) {
    throw new Error(`Expected an aar at ${aar}`);
  }
  return { aar, version: pkg.version };
}

function main() {
  const { manifest, configName } = resolveManifestPath();
  console.log(`Resolving ${PACKAGE} via ${manifest} (${configName})`);

  const { aar, version } = findAar(manifest);
  const target = path.join(DEST, `${ARTIFACT}-${version}.jar`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rustls-verifier-'));
  try {
    execFileSync('unzip', ['-o', '-j', aar, 'classes.jar', '-d', scratch], { stdio: 'pipe' });

    // Drop older versions first, so a bump cannot leave a stale jar behind for
    // the `fileTree` in android/build.gradle to pick up alongside the new one.
    fs.mkdirSync(DEST, { recursive: true });
    for (const entry of fs.readdirSync(DEST)) {
      if (/^rustls-platform-verifier-.*\.jar$/.test(entry)) {
        fs.rmSync(path.join(DEST, entry));
      }
    }
    fs.copyFileSync(path.join(scratch, 'classes.jar'), target);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const size = fs.statSync(target).size;
  console.log(`Vendored ${path.relative(ROOT, target)} (${size} bytes, crate version ${version})`);
}

main();
