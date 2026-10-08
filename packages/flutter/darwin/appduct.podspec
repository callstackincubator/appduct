#
# To learn more about a Podspec see http://guides.cocoapods.org/syntax/podspec.html.
# Run `pod lib lint appduct.podspec` to validate before publishing.
#
Pod::Spec.new do |s|
  s.name             = 'appduct'
  s.version          = '0.0.1'
  s.summary          = 'Appduct for Flutter.'
  s.description      = <<-DESC
Appduct for Flutter.
                       DESC
  s.homepage         = 'https://github.com/callstackincubator/appduct'
  s.license          = { :file => '../LICENSE' }
  s.author           = 'Callstack'
  s.source           = { :path => '.' }
  s.source_files = 'appduct/Sources/appduct/**/*'
  s.ios.dependency 'Flutter'
  s.osx.dependency 'FlutterMacOS'
  s.ios.deployment_target = '15.0'
  s.osx.deployment_target = '10.15'

  # Flutter.framework does not contain a i386 slice.
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
  s.swift_version = '5.0'

  # If your plugin requires a privacy manifest, for example if it uses any
  # required reason APIs, update the PrivacyInfo.xcprivacy file to describe your
  # plugin's privacy impact, and then uncomment this line. For more information,
  # see https://developer.apple.com/documentation/bundleresources/privacy_manifest_files
  # s.resource_bundles = {'appduct_privacy' => ['appduct/Sources/appduct/PrivacyInfo.xcprivacy']}
end
