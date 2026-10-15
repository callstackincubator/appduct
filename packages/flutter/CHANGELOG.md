# Changelog

This package is versioned together with the `appduct` CLI. The
[Appduct changelog](https://github.com/callstackincubator/appduct/blob/main/CHANGELOG.md) lists what
changed in each version.

## 0.15.1

No changes to the Flutter package. The fixes in this release are in the Appduct changelog.

## 0.15.0

Adds `Appduct.instance.sessionChanges`, `errors` and `sessionId`, and fixes how a second link and
a failed first connection are handled. The rest of this release is in the Appduct changelog.

## 0.14.0

First release of the Flutter package. Appduct is in debug and profile builds; a release build leaves
it out unless you build with `--dart-define=APPDUCT_ENABLED=true`.
