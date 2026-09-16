package com.callstack.appduct

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Whether Appduct is present in a build at all is now decided entirely by autolinking, at the
 * app level (see `docs/tasks/00-overview.md`'s "Inclusion" contract) -- not by any runtime check
 * here. This package registers the module unconditionally whenever it is linked, and always
 * compiles (docs/tasks/14-native-core-extraction.md): whether `NativeAppductModule`'s connection
 * manager is the real implementation or a no-op is decided by which of `android/core`/`core-noop`
 * (vendored from `packages/native/android`, see `build.gradle`'s `APPDUCT_ENABLED`-gated
 * source-set swap) the build resolved, not by which source set this file itself lives in.
 */
class AppductPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    if (name != NativeAppductSpec.NAME) {
      return null
    }

    return NativeAppductModule(reactContext)
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      mapOf(
        NativeAppductSpec.NAME to ReactModuleInfo(
          NativeAppductSpec.NAME,
          NativeAppductModule::class.java.name,
          false,
          false,
          false,
          true,
        ),
      )
    }
  }
}
