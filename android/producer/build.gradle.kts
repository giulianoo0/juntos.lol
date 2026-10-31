plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

// The Rust producer (the desktop app's cache, regions and upload) built for each ABI with cargo-ndk.
val rustAbis = listOf("arm64-v8a", "x86_64")
val jniOut = layout.buildDirectory.dir("rust/jniLibs")
val cargoBuild by tasks.registering(Exec::class) {
    val home = System.getProperty("user.home")
    val ndk = providers.environmentVariable("ANDROID_NDK_HOME").orNull
        ?: File("$home/Library/Android/sdk/ndk").listFiles()?.maxOrNull()?.path
    workingDir = file("rust")
    environment("ANDROID_NDK_HOME", ndk ?: "")
    environment("CARGO_TARGET_DIR", layout.buildDirectory.dir("rust/target").get().asFile.path)
    // rustup's toolchain first: a Homebrew cargo has no Android targets.
    environment("PATH", "$home/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$home/.cargo/bin:" + System.getenv("PATH"))
    commandLine(listOf("cargo", "ndk") + rustAbis.flatMap { listOf("-t", it) } + listOf("-o", jniOut.get().asFile.path, "build", "--release"))
    inputs.dir("rust/src")
    inputs.files("rust/Cargo.toml", "rust/Cargo.lock")
    inputs.dir("../../desktop/src-tauri/src")
    inputs.dir("../../crates")
    outputs.dir(jniOut)
}

android {
    namespace = "lol.juntos.producer"
    compileSdk = 36
    defaultConfig {
        minSdk = 31
        ndk { abiFilters += rustAbis }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    sourceSets["main"].jniLibs.srcDir(jniOut)
    // Python and FFmpeg run as executables from nativeLibraryDir, so the .so files must be extracted.
    packaging { jniLibs.useLegacyPackaging = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

tasks.named("preBuild") { dependsOn(cargoBuild) }

dependencies {
    api(libs.youtubedl.android)
    api(libs.youtubedl.ffmpeg)
    implementation(libs.androidx.core.ktx)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
}
