package com.bissi.miningtheblocks

import android.app.Application
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.util.Log
import java.security.MessageDigest

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.defaults.DefaultReactNativeHost

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost = ReactNativeHostWrapper(
      this,
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Packages that cannot be autolinked yet can be added manually here, for example:
              // add(MyReactNativePackage())
            }

          override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

          override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
      }
  )

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    // SEC: anti-tamper en runtime. Si el APK fue modificado y re-firmado por
    // alguien que no tiene la release keystore, la firma SHA-256 va a cambiar.
    // Esto eleva la barrera (un atacante motivado puede parchear el bytecode
    // Kotlin para bypasear el check, pero suma capa de defensa).
    if (!BuildConfig.DEBUG) {
      verifyAppSignature()
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  private fun verifyAppSignature() {
    try {
      val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
      } else {
        @Suppress("DEPRECATION")
        packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNATURES)
      }
      val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        packageInfo.signingInfo?.apkContentsSigners
      } else {
        @Suppress("DEPRECATION")
        packageInfo.signatures
      } ?: return

      val md = MessageDigest.getInstance("SHA-256")
      for (sig in signatures) {
        val hash = md.digest(sig.toByteArray()).joinToString("") { "%02X".format(it) }
        // SHA-256 esperado de la release keystore de MTB.
        // Actualizar si rotás la keystore (raro).
        val EXPECTED = "84EB85B5F62585C3792716539CD3ED317BF4125CBCFAC78984F074C42C6CD8DF"
        if (hash.equals(EXPECTED, ignoreCase = true)) {
          return // OK, firma legítima
        }
      }
      // Si llegamos acá, ninguna firma matchea la esperada.
      // Política estricta: APK re-firmado por terceros → cerrar la app.
      Log.w("MTB-SEC", "APK signature mismatch — terminating")
      android.os.Process.killProcess(android.os.Process.myPid())
      kotlin.system.exitProcess(0)
    } catch (e: Exception) {
      // Si el check mismo falla, NO bloqueamos (puede ser un OEM raro).
      Log.w("MTB-SEC", "signature check failed: ${e.message}")
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
