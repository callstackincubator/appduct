require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# Only evaluated when autolinking has already decided to link Cordierite, so the line appearing at
# all is the proof. Ungated: a release build carrying Cordierite by mistake is the failure worth
# catching, and this is grep-able in CI output. CocoaPods evaluates the podspec several times per
# install, hence the guard.
if defined?(Pod::UI) && !defined?($cordierite_banner_shown)
  $cordierite_banner_shown = true
  Pod::UI.puts "[cordierite] native module INCLUDED in this build (v#{package['version']})"
end

Pod::Spec.new do |s|
  s.name           = 'Cordierite'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/callstackincubator/cordierite' }
  s.static_framework = true

  # 'ios/Core/**/*.swift' is vendored from packages/native/ios/Sources/CordieriteCore/Real by
  # scripts/sync-native-core.mjs (wired into this package's build/prepack scripts) -- not checked
  # into git, but present by the time CocoaPods reads this podspec, and included in the npm
  # tarball (see .npmignore) so an installed consumer has it too. docs/tasks/14-native-core-extraction.md.
  s.source_files = 'ios/*.{m,mm,swift}', 'ios/Core/**/*.swift'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # Unconditional: autolinking (react-native.config.js's `:configurations` restriction) is what
    # decides whether this pod links into a given build variant at all, so by the time these
    # sources are compiled the decision to include Cordierite has already been made -- the vendored
    # ios/Core sources should always compile as the real implementation, never the
    # CordieriteCore SwiftPM package's Stub/ branch (which this pod never even sees -- only Real/ is
    # vendored). All connection state lives behind a single actor (see CordieriteConnectionManager);
    # `-strict-concurrency=complete` keeps it that way by failing the build on any new concurrency
    # violation.
    'OTHER_SWIFT_FLAGS' => '-DCORDIERITE_ENABLED -strict-concurrency=complete',
  }

  if defined?(install_modules_dependencies)
    install_modules_dependencies(s)
  else
    s.dependency 'React-Core'
  end

  # No test_spec: the Swift/Foundation-only unit tests that used to live in ios/CordieriteTests
  # moved with the sources to packages/native/ios/Tests/CordieriteCoreTests, and run via `swift
  # test` against the CordieriteCore SwiftPM package (repo-root Package.swift) instead of a
  # Pods-generated XCTest scheme -- see docs/tasks/14-native-core-extraction.md and .github/workflows/test.yaml.
end
