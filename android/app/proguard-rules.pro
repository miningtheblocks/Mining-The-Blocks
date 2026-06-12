# ProGuard / R8 rules for Mining The Blocks release builds.
# Conservative — prefer keeping things over breaking JS bridge / reflection.

# === React Native core ===
-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.jni.** { *; }
-keepclassmembers class * extends com.facebook.react.bridge.JavaScriptModule { *; }
-keepclassmembers class * extends com.facebook.react.bridge.NativeModule { *; }
-keepclassmembers,includedescriptorclasses class * { native <methods>; }
-keepclassmembers class *  { @com.facebook.react.uimanager.annotations.ReactProp <methods>; }
-keepclassmembers class *  { @com.facebook.react.uimanager.annotations.ReactPropGroup <methods>; }
-dontwarn com.facebook.react.**

# === Reanimated + turbomodules ===
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }
-keep class com.swmansion.worklets.** { *; }
-keep class com.swmansion.gesturehandler.** { *; }

# === Expo modules (loaded via reflection) ===
-keep class expo.modules.** { *; }
-keep class expo.core.** { *; }
-keepclasseswithmembers class * { @expo.modules.kotlin.functions.** <methods>; }
-dontwarn expo.modules.**

# === Firebase (uses reflection for serialization) ===
-keep class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }
-keepclassmembers class * { @com.google.firebase.firestore.PropertyName <fields>; }
-keepclassmembers class * { @com.google.firebase.firestore.PropertyName <methods>; }
-dontwarn com.google.firebase.**

# === AdMob ===
-keep class com.google.ads.** { *; }
-keep class com.google.android.gms.ads.** { *; }
-dontwarn com.google.ads.**

# === Notifications ===
-keep class expo.modules.notifications.** { *; }
-keep class com.google.firebase.messaging.** { *; }

# === OkHttp / Okio (transitive of firebase, fetch polyfill) ===
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**

# === Three.js JNI bridges (expo-gl, expo-three) ===
-keep class versioned.host.exp.exponent.modules.api.components.gl.** { *; }
-keep class expo.modules.gl.** { *; }
-keep class abi*.host.exp.exponent.modules.api.components.gl.** { *; }

# === Keep custom MainApplication / MainActivity ===
-keep class com.bissi.miningtheblocks.** { *; }

# === Serialization-friendly: keep enum values / native callbacks ===
-keepclassmembers enum * { public static **[] values(); public static ** valueOf(java.lang.String); }
-keepclasseswithmembernames class * { native <methods>; }

# === Stack traces ===
# SEC-A9: en release ofuscamos source/line. Si necesitás debuggear un crash de
# release, generá el mapping.txt (proguardOutputDir) y des-ofuscá con
# `retrace.sh mapping.txt stacktrace.txt`.
-keepattributes LineNumberTable
-renamesourcefileattribute MTB

# === Suppress warnings on common reflection patterns ===
-dontwarn javax.annotation.**
-dontwarn org.codehaus.mojo.animal_sniffer.**
