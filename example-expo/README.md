# Expo example

The same app as [`../example`](../example), built the way a real consuming app is
built. It exists so that "the example builds" is a claim about consuming apps and
not just about this repository.

It renders `../example/src/App.tsx` directly rather than keeping a copy. The two
examples are here to compare *native contracts*, so the JavaScript has to be
identical — otherwise a difference in behaviour tells you nothing about the thing
under test.

## What only this example covers

`android/` and `ios/` are not checked in. They are
[Continuous Native Generation](https://docs.expo.dev/workflow/continuous-native-generation/)
output, regenerated from `app.json` by `expo prebuild`, which is how consuming
apps produce theirs. Anything that must survive a prebuild has to be a config
plugin — see `plugins/withMatrixCodegen.js`.

That difference is not cosmetic. Four things reach the build here and nowhere
else:

| | `../example` | here |
| --- | --- | --- |
| iOS pod linkage | dynamic (default) | `use_frameworks! :linkage => :static` |
| autolinking | `@react-native-community/cli` | `expo-modules-autolinking` |
| React Native | consumed prebuilt | built from source |
| native config | hand-maintained | generated from `app.json` |

The static-framework linkage in particular has already broken this package once:
React Native 0.86 emits a `Package.swift` into the library's codegen output, which
the podspec's `ios/**/*.swift` glob swept into the pod, turning a pure
Objective-C pod into a mixed Swift/Objective-C one — where C++ headers stop
resolving. A bare example cannot see that.

## Running it

```sh
yarn example-expo prebuild   # generates android/ and ios/
yarn example-expo android    # or: yarn example-expo ios
```

`prebuild` is required before any native build, since the projects do not exist
at checkout.

## The checks CI runs here

This example owns the two builds that are expensive and that no ordinary
development ever performs:

```sh
yarn example-expo build:android:release && yarn example-expo check:alignment:release
yarn example-expo build:ios:device      && yarn example-expo check:ios:device
```

The Android one runs R8 over this package's `consumerProguardFiles`, which is
what caught R8 deleting the `rustls-platform-verifier` classes. The iOS one links
the xcframework's `ios-arm64` device slice — the one every real user runs, and the
one nothing in this repository had ever linked.
