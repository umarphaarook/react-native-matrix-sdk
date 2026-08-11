#!/usr/bin/env bash
#
# Install this working copy into a consuming app's node_modules as if it had come
# from the registry.
#
#   ./scripts/sync-into-app.sh ~/Documents/zerodaone/zaure
#
# Why not a symlink. CocoaPods resolves a podspec's `source_files` and
# `vendored_frameworks` through Sandbox::PathList, which caches one recursive
# directory walk and does not descend into symlinked directories. A glob that
# crosses a symlinked node_modules entry therefore matches zero files, silently -
# no warning, no error, just a pod with nothing in it. Verified against
# CocoaPods 1.16.2:
#
#   node_modules/@unomed/react-native-matrix-sdk/swift/*.swift    PathList=0  Dir.glob=8
#   node_modules/.../build/RnMatrixRustSdk.xcframework            PathList=0  Dir.glob=1
#
# Autolinked pods escape this because autolinking hands CocoaPods the resolved
# real path, making the checkout itself the pod root. It bites any podspec owned
# by the *app* that reaches into node_modules - in Zaure's case MatrixSDKFFI,
# the pod the Notification Service Extension links against.
#
# A real directory has none of that ambiguity, and on APFS it is close to free:
# `cp -c` clones blocks copy-on-write, so the ~1 GB xcframework costs no disk and
# no meaningful time. It also keeps this checkout's own node_modules out of the
# app, which is what stops a second react-native from reaching the bundle.
#
# Re-run after rebuilding anything the app consumes - `yarn prepare` for lib/,
# `yarn generate:*` for the bindings, a Rust build for build/ or the jniLibs.

set -euo pipefail

PACKAGE_NAME='@unomed/react-native-matrix-sdk'
SDK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APP_ROOT="${1:-}"
if [ -z "$APP_ROOT" ]; then
  echo "usage: $(basename "$0") <path-to-app>" >&2
  exit 2
fi
if [ ! -d "$APP_ROOT/node_modules" ]; then
  echo "Error: $APP_ROOT/node_modules does not exist - install the app's dependencies first" >&2
  exit 1
fi

DEST="$APP_ROOT/node_modules/$PACKAGE_NAME"

# `files` from package.json, plus the two things a registry install gets by other
# means: package.json/README/LICENSE (npm always includes them) and build/, which
# the published tarball omits and scripts/download-binaries.js fetches from the
# GitHub release on postinstall. A local checkout has already built it.
CONTENTS=(
  package.json
  README.md
  LICENSE
  react-native.config.js
  src
  lib
  cpp
  swift
  scripts
  ios
  android
  build
)

# The `*.podspec` entry of `files`, expanded. Autolinking identifies a native
# module by finding a podspec at the package root, so omitting this does not fail
# loudly - the pod simply never appears in the Podfile.lock and the TurboModule is
# missing at runtime.
while IFS= read -r podspec; do
  CONTENTS+=("$(basename "$podspec")")
done < <(find "$SDK_ROOT" -maxdepth 1 -name '*.podspec')

# The `!`-prefixed entries of `files`, which are build inputs or outputs that no
# consumer needs. android/build alone is around 4 GB.
PRUNE=(
  ios/build
  android/build
  android/gradle
  android/gradlew
  android/gradlew.bat
  android/local.properties
)

missing=()
for entry in "${CONTENTS[@]}"; do
  [ -e "$SDK_ROOT/$entry" ] || missing+=("$entry")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Error: not built - missing ${missing[*]}" >&2
  echo "  lib/    -> yarn prepare" >&2
  echo "  build/  -> yarn generate:ios      (or generate:release:ios)" >&2
  echo "  android -> yarn generate:android  (or generate:release:android)" >&2
  exit 1
fi

echo "Syncing $SDK_ROOT"
echo "     -> $DEST"

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mkdir -p "$DEST"

for entry in "${CONTENTS[@]}"; do
  # -c asks for an APFS clone and fails loudly rather than silently falling back
  # to a byte copy, so a cross-volume checkout is reported instead of taking
  # minutes and gigabytes by surprise.
  cp -Rc "$SDK_ROOT/$entry" "$DEST/$entry"
done

for entry in "${PRUNE[@]}"; do
  rm -rf "$DEST/$entry"
done

# Dotfiles are excluded by `!**/.*`, and a stray .gitignore inside the mirror can
# make tooling treat vendored output as ignorable.
find "$DEST" -mindepth 1 -maxdepth 2 -name '.*' -exec rm -rf {} + 2>/dev/null || true
find "$DEST" -type d \( -name __tests__ -o -name __fixtures__ -o -name __mocks__ \) -exec rm -rf {} + 2>/dev/null || true

echo "Done. $(du -sh "$DEST" | cut -f1) apparent size ($(node -p "require('$DEST/package.json').version"))."
echo
echo "Next: (cd $APP_ROOT/ios && pod install)"
