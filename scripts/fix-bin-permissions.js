#!/usr/bin/env node
//
// Restore the executable bit on `node_modules/.bin` entries that lost it.
//
// Yarn's node-modules linker copies file modes straight out of the published
// tarball instead of forcing +x the way npm does when it links a package's
// `bin`. Several packages - `@react-native-community/cli` (`rnc-cli`) and
// `metro` among them - publish their bin scripts as 0644, so invoking them
// fails with `Permission denied` and exit code 126.
//
// That breaks the Android build in two places that are awkward to route around
// individually, because neither is ours to edit:
//
//   * `settings.gradle` autolinking, which runs `npx @react-native-community/cli config`
//   * `react-native-builder-bob`'s codegen target, which runs `npx @react-native-community/cli codegen`
//
// So fix the cause once, here, rather than each call site. Only files that are
// already shebang scripts are touched, and only when they are missing +x.

const fs = require('fs');
const path = require('path');

const BIN_DIRS = [
  path.join(__dirname, '..', 'node_modules', '.bin'),
  path.join(__dirname, '..', 'example', 'node_modules', '.bin'),
];

function hasShebang(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(2);
    fs.readSync(fd, buffer, 0, 2, 0);
    return buffer.toString('utf8') === '#!';
  } catch (error) {
    return false;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

let fixed = 0;

for (const binDir of BIN_DIRS) {
  let entries;
  try {
    entries = fs.readdirSync(binDir);
  } catch (error) {
    continue; // Workspace not installed yet.
  }

  for (const entry of entries) {
    let target;
    try {
      target = fs.realpathSync(path.join(binDir, entry));
    } catch (error) {
      continue; // Dangling symlink.
    }

    let stats;
    try {
      stats = fs.statSync(target);
    } catch (error) {
      continue;
    }

    if (!stats.isFile() || stats.mode & 0o111 || !hasShebang(target)) {
      continue;
    }

    fs.chmodSync(target, stats.mode | 0o755);
    console.log(`fix-bin-permissions: chmod +x ${path.relative(process.cwd(), target)}`);
    fixed += 1;
  }
}

if (fixed === 0) {
  console.log('fix-bin-permissions: nothing to fix');
}
