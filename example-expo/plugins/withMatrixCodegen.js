const { withSettingsGradle, withPodfile } = require('@expo/config-plugins');

/**
 * Generate this package's TurboModule spec before either native build reads it.
 *
 * `codegenConfig.includesGeneratedCode` in the package's package.json tells React
 * Native's own codegen to leave this library alone, on the grounds that a
 * published tarball ships the generated sources already. In this workspace it
 * does not: `android/generated` and `ios/generated` are gitignored, so something
 * has to run `bob build --target codegen` or the Kotlin compile fails on a
 * missing spec and the pod has no sources at all.
 *
 * Both files this injects into are `expo prebuild` output, which is why it has to
 * be a plugin rather than an edit: android/ and ios/ are regenerated wholesale.
 *
 * Android runs it at settings evaluation, not as a task. The generated sources
 * belong to the *library* module, and a task in the app module does not order
 * against the library's `compileDebugKotlin` under `org.gradle.parallel=true` -
 * since codegen deletes the output directory before rewriting it, Kotlin ends up
 * snapshotting a file list whose entries vanish underneath it and dies with an
 * internal compiler error wrapping FileNotFoundException. Settings evaluation
 * happens before any project is configured, so the ordering question disappears.
 *
 * It is invoked through `node` rather than the `bob` bin stub on purpose: Yarn's
 * node-modules linker preserves published file modes, so bin scripts are not
 * reliably executable. See scripts/fix-bin-permissions.js.
 */

// Bare text, so each file can wrap it in its own comment syntax - Gradle is
// Groovy and takes `//`, the Podfile is Ruby and takes `#`.
const MARKER = 'Added by example-expo/plugins/withMatrixCodegen.js';

const GRADLE_BLOCK = `
// ${MARKER}
providers.exec {
  workingDir = rootDir.parentFile.parentFile
  commandLine "node", "node_modules/react-native-builder-bob/bin/bob", "build", "--target", "codegen"
}.standardOutput.asText.get()
`;

const PODFILE_BLOCK = `
  # ${MARKER}
  pre_install do |installer|
    system("cd ../../ && node node_modules/react-native-builder-bob/bin/bob build --target codegen")
  end
`;

function withCodegenSettingsGradle(config) {
  return withSettingsGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes(MARKER)) {
      return cfg;
    }

    // `rootProject.name` is always present and always at the top level, which
    // makes it a safer anchor than the plugins block whose shape moves around
    // between Expo releases.
    const anchor = /^rootProject\.name\s*=/m;
    if (!anchor.test(cfg.modResults.contents)) {
      throw new Error(
        'withMatrixCodegen: no `rootProject.name` assignment in settings.gradle to anchor to'
      );
    }

    cfg.modResults.contents = cfg.modResults.contents.replace(
      anchor,
      (match) => `${GRADLE_BLOCK}\n${match}`
    );
    return cfg;
  });
}

function withCodegenPodfile(config) {
  return withPodfile(config, (cfg) => {
    if (cfg.modResults.contents.includes(MARKER)) {
      return cfg;
    }

    const anchor = /^target\s+'[^']+'\s+do$/m;
    if (!anchor.test(cfg.modResults.contents)) {
      throw new Error(
        'withMatrixCodegen: no `target \'...\' do` line in the Podfile to anchor to'
      );
    }

    cfg.modResults.contents = cfg.modResults.contents.replace(
      anchor,
      (match) => `${match}\n${PODFILE_BLOCK}`
    );
    return cfg;
  });
}

module.exports = function withMatrixCodegen(config) {
  return withCodegenPodfile(withCodegenSettingsGradle(config));
};
