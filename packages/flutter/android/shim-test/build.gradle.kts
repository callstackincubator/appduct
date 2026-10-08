// Runs the shim's plain-Kotlin unit tests on the JVM. The plugin's own build needs the Flutter
// embedding from a host app, so it cannot run them: `gradle -p android/shim-test test`.
plugins {
    kotlin("jvm") version "2.0.21"
}

repositories {
    mavenCentral()
}

sourceSets {
    main { kotlin.srcDir("../src/main/kotlin"); kotlin.include("dev/appduct/ShimState.kt") }
    test { kotlin.srcDir("../src/test/kotlin") }
}

dependencies {
    testImplementation(kotlin("test"))
}

