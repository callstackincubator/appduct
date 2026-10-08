#!/usr/bin/env bash
# Builds a Flutter host app in release mode with and without the Appduct Dart core and checks the
# result with `appduct doctor`.
#
# Usage: scripts/check-flutter-release.sh <android|ios> <host-app-dir>
#
# The host app is a `flutter create` project that already depends on the appduct plugin. The CLI
# must be built (`pnpm build`) first.
set -euo pipefail

platform=${1:?usage: check-flutter-release.sh <android|ios> <host-app-dir>}
host=${2:?usage: check-flutter-release.sh <android|ios> <host-app-dir>}
cli="$(cd "$(dirname "$0")/.." && pwd)/packages/appduct/bin.js"

cat > "$host/lib/main.dart" <<'DART'
import 'package:appduct/appduct.dart';
import 'package:flutter/widgets.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  Appduct.ensureInitialized();
  runApp(const SizedBox());
}
DART

cd "$host"

# check <expectation> <label> <flutter build args...>
check() {
  local expectation=$1 label=$2
  shift 2
  echo "::group::$label (expect $expectation)"
  case "$platform" in
    android)
      flutter build apk --release "$@"
      artifact=build/app/outputs/flutter-apk/app-release.apk ;;
    ios)
      flutter build ios --release --no-codesign "$@"
      artifact=build/ios/iphoneos/Runner.app ;;
    *) echo "unknown platform $platform" >&2; exit 2 ;;
  esac
  node "$cli" doctor "$artifact" "--assert-$expectation"
  echo "::endgroup::"
}

check absent "release, default"
check present "release, APPDUCT_ENABLED=true" --dart-define=APPDUCT_ENABLED=true
check absent "release, obfuscated" --obfuscate --split-debug-info="$host/symbols"
check present "release, APPDUCT_ENABLED=true, obfuscated" \
  --dart-define=APPDUCT_ENABLED=true --obfuscate --split-debug-info="$host/symbols"
