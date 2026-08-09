#!/usr/bin/env node
//
// Assert that every native library in an APK can be loaded on a 16 KB page size
// device.
//
// Android 15 introduced 16 KB pages, and from targetSdk 36 an app that cannot
// run on them is not shippable. Two independent things have to be true, and a
// library that gets either wrong fails at `dlopen` on a 16 KB device while
// working perfectly on the 4 KB emulator most people test on:
//
//   1. Every PT_LOAD segment must be aligned to at least 16384. This is a
//      property of how the .so was linked. NDK r27 does it by default; r26 and
//      earlier emit 4096 unless asked.
//
//   2. The .so must be STORED in the APK, not deflated. The loader maps
//      libraries straight out of the APK, and it can only do that if they are
//      uncompressed. This is what `android.useLegacyPackaging=false` buys.
//
// This package links a large Rust cdylib, which makes it more exposed to (1)
// than most - and the failure is silent in exactly the setup people develop
// against. Hence a check rather than a convention.
//
// ELF parsing is done here rather than shelling out to llvm-readelf so this
// works on a machine with no NDK installed, which includes most CI runners.
//
// Usage:
//   node scripts/check-apk-alignment.js <path-to-apk-or-aab>

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REQUIRED_ALIGNMENT = 16 * 1024;

const PT_LOAD = 1;
const ELFCLASS32 = 1;
const ELFCLASS64 = 2;

/**
 * Read the p_align of every PT_LOAD segment in an ELF file.
 *
 * @param {Buffer} buffer Contents of the ELF file
 * @returns {number[]} Alignment of each PT_LOAD segment
 */
function loadSegmentAlignments(buffer) {
  if (
    buffer.length < 64 ||
    buffer[0] !== 0x7f ||
    buffer[1] !== 0x45 || // E
    buffer[2] !== 0x4c || // L
    buffer[3] !== 0x46 // F
  ) {
    throw new Error('not an ELF file');
  }

  const elfClass = buffer[4];
  const littleEndian = buffer[5] === 1;

  if (elfClass !== ELFCLASS32 && elfClass !== ELFCLASS64) {
    throw new Error(`unknown ELF class ${elfClass}`);
  }
  if (!littleEndian) {
    // Every Android ABI is little-endian; big-endian support would be dead code.
    throw new Error('big-endian ELF is not supported');
  }

  const is64 = elfClass === ELFCLASS64;
  const readU16 = (offset) => buffer.readUInt16LE(offset);
  // Offsets and alignments are 64-bit on ELF64. They are far below 2^53 in any
  // real library, so reading them as doubles loses nothing and avoids BigInt.
  const readAddr = (offset) =>
    is64 ? Number(buffer.readBigUInt64LE(offset)) : buffer.readUInt32LE(offset);

  const phoff = readAddr(is64 ? 0x20 : 0x1c);
  const phentsize = readU16(is64 ? 0x36 : 0x2a);
  const phnum = readU16(is64 ? 0x38 : 0x2c);

  const alignments = [];

  for (let i = 0; i < phnum; i++) {
    const entry = phoff + i * phentsize;
    if (entry + phentsize > buffer.length) {
      throw new Error('program header table runs past end of file');
    }

    if (buffer.readUInt32LE(entry) !== PT_LOAD) {
      continue;
    }

    // p_align is the last field of the program header in both classes.
    alignments.push(readAddr(entry + (is64 ? 0x30 : 0x1c)));
  }

  if (alignments.length === 0) {
    throw new Error('no PT_LOAD segments');
  }

  return alignments;
}

/**
 * List native libraries in the archive, and whether each is stored uncompressed.
 *
 * @param {string} archive Path to the .apk / .aab
 * @returns {Map<string, boolean>} Entry name to "is stored uncompressed"
 */
function listNativeLibraries(archive) {
  // `unzip -v` is the portable way to see the compression method; it ships on
  // macOS and on the GitHub ubuntu runners.
  const listing = execFileSync('unzip', ['-v', archive], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const entries = new Map();

  for (const line of listing.split('\n')) {
    // Length Method Size Cmpr Date Time CRC-32 Name
    const match = line.match(
      /^\s*\d+\s+(\S+)\s+\d+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S.*)$/
    );
    if (!match) {
      continue;
    }

    const [, method, name] = match;
    if (name.endsWith('.so')) {
      entries.set(name, method === 'Stored');
    }
  }

  return entries;
}

function main() {
  const archive = process.argv[2];

  if (!archive) {
    console.error('usage: node scripts/check-apk-alignment.js <apk-or-aab>');
    process.exit(2);
  }

  if (!fs.existsSync(archive)) {
    console.error(`check-apk-alignment: no such file: ${archive}`);
    process.exit(2);
  }

  const libraries = listNativeLibraries(archive);

  if (libraries.size === 0) {
    console.error(
      `check-apk-alignment: ${archive} contains no .so entries, which is not ` +
        'something this package can produce - refusing to report success.'
    );
    process.exit(2);
  }

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-alignment-'));
  const failures = [];
  const rows = [];

  try {
    execFileSync('unzip', ['-q', '-o', archive, '*.so', '-d', extractDir], {
      maxBuffer: 64 * 1024 * 1024,
    });

    for (const [name, stored] of [...libraries].sort()) {
      const extracted = path.join(extractDir, name);
      let alignment;
      let detail;

      try {
        alignment = Math.min(
          ...loadSegmentAlignments(fs.readFileSync(extracted))
        );
        detail = `0x${alignment.toString(16)}`;
      } catch (error) {
        failures.push(`${name}: could not read ELF headers: ${error.message}`);
        rows.push([name, 'unreadable', stored ? 'stored' : 'DEFLATED']);
        continue;
      }

      if (alignment < REQUIRED_ALIGNMENT) {
        failures.push(
          `${name}: PT_LOAD aligned to ${detail}, need at least 0x4000`
        );
      }
      if (!stored) {
        failures.push(`${name}: deflated in the archive, must be stored`);
      }

      rows.push([name, detail, stored ? 'stored' : 'DEFLATED']);
    }
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  const width = Math.max(...rows.map(([name]) => name.length));
  for (const [name, alignment, packaging] of rows) {
    console.log(`${name.padEnd(width)}  ${alignment.padStart(9)}  ${packaging}`);
  }

  console.log('');

  if (failures.length > 0) {
    console.error(
      `check-apk-alignment: ${failures.length} problem(s) in ${archive}:`
    );
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    console.error(
      '\nThese libraries cannot be loaded on a 16 KB page size device.'
    );
    process.exit(1);
  }

  console.log(
    `check-apk-alignment: ${rows.length} librar${rows.length === 1 ? 'y' : 'ies'} in ${path.basename(archive)}, all 16 KB ready.`
  );
}

main();
