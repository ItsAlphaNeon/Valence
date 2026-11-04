// Pure-JVM port of the desktop's sync formats: HLC, device logs, keys, playlists, smart rules, play counting.
plugins {
    alias(libs.plugins.kotlin.jvm)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    // Android ships org.json; the JVM tests need a copy. Use only the API Android has (no opt*Object, no similar()).
    compileOnly(libs.orgjson)
    testImplementation(libs.orgjson)
    testImplementation(libs.junit)
}
