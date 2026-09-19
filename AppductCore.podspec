require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'packages', 'react-native', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'AppductCore'
  # Version is single-sourced from @appduct/react-native's package.json (see
  # docs/tasks/14-native-core-extraction.md): the RN, Swift, and Kotlin packages have always
  # versioned in lockstep in this repo (see CHANGELOG.md's header), and a native-core-specific
  # version number would just be another place that number could drift.
  s.version        = package['version']
  s.summary        = 'Framework-free Swift core for Appduct: TLS-pinned session transport and resume leases.'
  s.description    = 'The native connection layer behind @appduct/react-native, usable directly ' \
                      'from plain iOS/tvOS/macOS apps. See packages/native/README.md.'
  s.license        = { :type => package['license'], :file => 'LICENSE' }
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  # Language mode, not a toolchain version: `-swift-version` accepts only 4, 4.2, 5, and 6, so
  # '6.1' is not a legal value here despite Package.swift's `swift-tools-version: 6.1`. Set to 6 to
  # match the mode SwiftPM actually compiles these same sources in (verified: an iOS build of the
  # root Package.swift passes `-swift-version 6`); the previous '5.9' was normalised to mode 5 by
  # Xcode, quietly building the pod under laxer rules than the SwiftPM package.
  s.swift_version  = '6.0'
  s.source         = { git: 'https://github.com/callstackincubator/appduct.git', tag: "v#{s.version}" }
  s.static_framework = true

  s.source_files = 'packages/native/ios/Sources/AppductCore/Real/**/*.swift'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # Unconditional, unlike the SwiftPM target's configuration-gated define: a CocoaPods consumer
    # (this repo's own @appduct/react-native, or any other pod depending on this one) gates
    # *inclusion* with `:configurations => ['Debug']` on the dependency itself, exactly as the RN
    # pod does today -- by the time this podspec's sources are compiled at all, the decision to
    # include them has already been made, so the code inside should always be the real
    # implementation, never the stub. All connection state lives behind a single actor (see
    # AppductConnectionManager); `-strict-concurrency=complete` keeps it that way by failing the
    # build on any new concurrency violation. Redundant while `s.swift_version` is 6.0 -- language
    # mode 6 implies complete checking -- but kept explicit so lowering that value back to 5 cannot
    # silently drop the strictness along with it.
    'OTHER_SWIFT_FLAGS' => '-DAPPDUCT_ENABLED -strict-concurrency=complete',
  }

  # No test_spec. The unit tests in packages/native/ios/Tests/AppductCoreTests run in CI through
  # `swift test` against the repo-root Package.swift, the same choice Appduct.podspec made. Here it
  # is also load-bearing: `pod spec lint` and `pod trunk push` run a pod's test spec on an iOS *and*
  # a tvOS simulator, and several of these tests wait for actor work with fixed `Task.yield()`
  # loops that are racy in a simulator (they pass on macOS). Declaring them made every trunk push a
  # coin toss while adding no coverage CI lacks. Trunk validation still builds the pod for both
  # platforms, which is what publishing needs.
end
