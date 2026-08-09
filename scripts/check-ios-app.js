#!/usr/bin/env node
//
// Assert that a built .app is actually shippable.
//
// The iOS counterpart to scripts/check-apk-alignment.js. Both exist for the same
// reason: this package's failure modes are things that build green and break at
// runtime, on a configuration nobody routinely builds.
//
// What it checks, and why each one can fail silently:
//
//   1. Architectures. A device build must be arm64 and nothing else. A simulator
//      slice leaking into a device build, or vice versa, produces an app that
//      installs and then refuses to launch.
//
//   2. The embedded JS bundle, for Release builds. Debug fetches JS from Metro,
//      so a missing bundle is invisible until the app runs somewhere Metro is
//      not - which is to say, on a real user's device.
//
//   3. The matrix-sdk-ffi and TurboModule symbols. The Rust library reaches the
//      app as a static archive inside an xcframework, and static archive members
//      that nothing references are dropped at link time. If the FFI ever stops
//      being referenced the way the linker expects, it disappears from the
//      binary and every SDK call fails at runtime.
//
// If the binary has been stripped of its symbol table, this fails rather than
// skipping (3). A check that quietly stops checking is worse than no check.
//
// Usage:
//   node scripts/check-ios-app.js <path-to-.app>

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// The bundle is a few MB of Hermes bytecode. Anything tiny means the bundling
// phase produced a stub or an error page rather than the app's JS.
const MIN_BUNDLE_BYTES = 128 * 1024;

const SYMBOL_EXPECTATIONS = [
  {
    label: 'matrix-sdk-ffi (uniffi)',
    pattern: /uniffi_matrix_sdk_ffi/,
    hint: 'the Rust static library was dropped at link time',
  },
  {
    label: 'ReactNativeMatrixSdk TurboModule',
    pattern: /ReactNativeMatrixSdk/,
    hint: 'this package’s native module did not make it into the binary',
  },
];

/**
 * Work out what kind of build produced this .app from its containing directory,
 * which Xcode names `<Configuration>-<sdk>`.
 *
 * @param {string} appPath Path to the .app bundle
 * @returns {{ configuration: string, platform: 'device'|'simulator' }}
 */
function describeBuild(appPath) {
  const parent = path.basename(path.dirname(path.resolve(appPath)));
  const match = parent.match(/^(.+)-(iphoneos|iphonesimulator)$/);

  if (!match) {
    throw new Error(
      `cannot tell what kind of build this is: expected the .app to sit in a ` +
        `"<Configuration>-iphoneos" or "<Configuration>-iphonesimulator" ` +
        `directory, got "${parent}"`
    );
  }

  return {
    configuration: match[1],
    platform: match[2] === 'iphoneos' ? 'device' : 'simulator',
  };
}

function main() {
  const appPath = process.argv[2];

  if (!appPath) {
    console.error('usage: node scripts/check-ios-app.js <path-to-.app>');
    process.exit(2);
  }

  if (!fs.existsSync(appPath)) {
    console.error(`check-ios-app: no such bundle: ${appPath}`);
    process.exit(2);
  }

  const { configuration, platform } = describeBuild(appPath);
  const name = path.basename(appPath, '.app');
  const binary = path.join(appPath, name);

  if (!fs.existsSync(binary)) {
    console.error(`check-ios-app: no executable at ${binary}`);
    process.exit(2);
  }

  const failures = [];

  console.log(`bundle        ${path.basename(appPath)}`);
  console.log(`configuration ${configuration}`);
  console.log(`platform      ${platform}`);

  // 1. Architectures.
  const archs = execFileSync('lipo', ['-archs', binary], { encoding: 'utf8' })
    .trim()
    .split(/\s+/)
    .sort();

  console.log(`archs         ${archs.join(', ')}`);

  if (platform === 'device') {
    if (archs.join(',') !== 'arm64') {
      failures.push(
        `device build must contain exactly arm64, found: ${archs.join(', ')}`
      );
    }
  } else if (!archs.includes('arm64')) {
    failures.push(
      `simulator build has no arm64 slice, so it cannot run on Apple silicon ` +
        `(found: ${archs.join(', ')})`
    );
  }

  // 2. Embedded JS bundle, for Release only.
  const bundlePath = path.join(appPath, 'main.jsbundle');
  const isRelease = configuration.toLowerCase() !== 'debug';

  if (isRelease) {
    if (!fs.existsSync(bundlePath)) {
      failures.push(
        'no main.jsbundle: a Release build must embed its JS, or it will only ' +
          'run where Metro happens to be reachable'
      );
      console.log('jsbundle      MISSING');
    } else {
      const bytes = fs.statSync(bundlePath).size;
      console.log(`jsbundle      ${(bytes / 1024 / 1024).toFixed(1)} MiB`);

      if (bytes < MIN_BUNDLE_BYTES) {
        failures.push(
          `main.jsbundle is only ${bytes} bytes, which is too small to be this ` +
            'app’s JS'
        );
      }
    }
  }

  // 3. Symbols.
  const symbols = execFileSync('nm', [binary], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  const lines = symbols.split('\n');
  console.log(`symbols       ${lines.length.toLocaleString('en-US')}`);

  if (lines.length < 100) {
    failures.push(
      'the binary has essentially no symbol table, so the checks below cannot ' +
        'be made - refusing to report success on an unverifiable binary'
    );
  } else {
    for (const { label, pattern, hint } of SYMBOL_EXPECTATIONS) {
      const count = lines.filter((line) => pattern.test(line)).length;
      console.log(`  ${label.padEnd(34)} ${count.toLocaleString('en-US')}`);

      if (count === 0) {
        failures.push(`no ${label} symbols: ${hint}`);
      }
    }
  }

  console.log('');

  if (failures.length > 0) {
    console.error(`check-ios-app: ${failures.length} problem(s):`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log(`check-ios-app: ${name}.app (${configuration}, ${platform}) is shippable.`);
}

main();
