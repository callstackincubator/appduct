require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', '..', 'react-native', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'AppductCore'
  # Version is single-sourced from @appduct/react-native's package.json (see
  # docs/tasks/14-native-core-extraction.md): the RN, Swift, and Kotlin packages have always
  # versioned in lockstep in this repo (docs/CI.md's release policy), and a native-core-specific
  # version number would just be another place that number could drift.
  s.version        = package['version']
  s.summary        = 'Framework-free Swift core for Appduct: TLS-pinned session transport and resume leases.'
  s.description    = 'The native connection layer behind @appduct/react-native, usable directly ' \
                      'from plain iOS/tvOS/macOS apps. See packages/native/README.md.'
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/callstackincubator/appduct' }
  s.static_framework = true

  s.source_files = 'ios/Sources/AppductCore/Real/**/*.swift'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # Unconditional, unlike the SwiftPM target's configuration-gated define: a CocoaPods consumer
    # (this repo's own @appduct/react-native, or any other pod depending on this one) gates
    # *inclusion* with `:configurations => ['Debug']` on the dependency itself, exactly as the RN
    # pod does today -- by the time this podspec's sources are compiled at all, the decision to
    # include them has already been made, so the code inside should always be the real
    # implementation, never the stub. All connection state lives behind a single actor (see
    # AppductConnectionManager); `-strict-concurrency=complete` keeps it that way by failing the
    # build on any new concurrency violation -- kept here rather than relying on the SwiftPM
    # target's Swift 6 language mode, since a CocoaPods consumer's `swift_version` does not imply it.
    'OTHER_SWIFT_FLAGS' => '-DAPPDUCT_ENABLED -strict-concurrency=complete',
  }

  s.test_spec 'Tests' do |test_spec|
    # Pure-logic tests (actor state transitions, SPKI pin parity with
    # packages/appduct/src/spki-pin.ts) that need only Foundation/Security.
    test_spec.source_files = 'ios/Tests/AppductCoreTests/**/*.swift'
    test_spec.requires_app_host = true
  end
end
