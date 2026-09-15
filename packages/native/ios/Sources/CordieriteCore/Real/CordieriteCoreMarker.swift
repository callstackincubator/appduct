#if CORDIERITE_ENABLED

import Foundation

/// Exists for exactly one reason: to give `cordierite doctor`
/// (`packages/cordierite/src/artifact-inspect.ts`) a detection anchor on iOS that is real Objective-C
/// runtime metadata (a class name, not compiled-out inert code) and, unlike `RCTNativeCordierite`,
/// is compiled only into the real implementation -- never into `Stub/` and never into the SwiftPM
/// `#else` branch that `CORDIERITE_ENABLED` gates out.
///
/// Consumer apps never instantiate or reference this class. It has no members and does nothing;
/// its only job is to exist, under this exact `@objc` name, so its symbol survives into the linked
/// binary the same way `RCTNativeCordierite`'s `RCT_EXPORT_MODULE` name does. `doctor` treats it as
/// a real-code-only signal (`ios-core-marker-symbol`) that, unlike the app-authored Info.plist keys,
/// cannot be present without the real implementation also being present.
///
/// Do not rename, delete, or move this class without updating the matching constant in
/// `artifact-inspect.ts` -- the two must always agree on the same `@objc` name.
@objc(CordieriteCoreMarker)
public final class CordieriteCoreMarker: NSObject {}

#endif
