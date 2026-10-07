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

  # If your plugin requires a privacy manifest, for example if it collects user
  # data, update the PrivacyInfo.xcprivacy file to describe your plugin's
  # privacy impact, and then uncomment this line. For more information,
  # see https://developer.apple.com/documentation/bundleresources/privacy_manifest_files
  # s.resource_bundles = {'appduct_privacy' => ['appduct/Sources/appduct/PrivacyInfo.xcprivacy']}

  s.dependency 'FlutterMacOS'

  s.platform = :osx, '10.15'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.swift_version = '5.0'
end
