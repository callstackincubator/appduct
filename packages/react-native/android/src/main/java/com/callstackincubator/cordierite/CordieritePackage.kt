package com.callstackincubator.cordierite

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Whether Cordierite is present in a build at all is now decided entirely by autolinking, at the
 * app level (see `docs/tasks/00-overview.md`'s "Inclusion" contract) -- not by any runtime check
 * here. This package registers the module unconditionally whenever it is linked, and always
 * compiles (docs/tasks/14-native-core-extraction.md): whether `NativeCordieriteModule`'s connection
 * manager is the real implementation or a no-op is decided by which of `android/core`/`core-noop`
 * (vendored from `packages/native/android`, see `build.gradle`'s `CORDIERITE_ENABLED`-gated
 * source-set swap) the build resolved, not by which source set this file itself lives in.
 */
class CordieritePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    if (name != NativeCordieriteSpec.NAME) {
      return null
    }

    return NativeCordieriteModule(reactContext)
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      mapOf(
        NativeCordieriteSpec.NAME to ReactModuleInfo(
          NativeCordieriteSpec.NAME,
          NativeCordieriteModule::class.java.name,
          false,
          false,
          false,
          true,
        ),
      )
    }
  }
}
