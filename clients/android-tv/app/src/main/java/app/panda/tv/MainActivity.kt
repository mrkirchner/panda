package app.panda.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.view.KeyEvent
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray

/**
 * The Panda TV client (the same web app as LG/Samsung) in a full-screen WebView. The app is
 * bundled in assets/www and served from https://appassets.androidplatform.net so it behaves like
 * a normal web origin; it talks to the Panda server the person enters on first run.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true // the server address, device credential, session
            settings.mediaPlaybackRequiresUserGesture = false // autoplay when you press Play
            // The app origin is https; the Panda server on your network is usually http.
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assets.shouldInterceptRequest(request.url)
            }
            isFocusable = true
            isFocusableInTouchMode = true
            addJavascriptInterface(Discovery(), "PandaNative")
        }
        setContentView(web)
        web.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
        web.requestFocus()
    }

    /**
     * Panda servers on the home network, found by NSD (the server announces `_panda._tcp`):
     * `PandaNative.discover(id)` looks for a few seconds, resolves each one's address, then
     * calls `window.__pandaDiscovered(id, [urls])` in the app (devices/android in the client).
     */
    inner class Discovery {
        private val main = Handler(Looper.getMainLooper())

        @JavascriptInterface
        fun discover(id: String) {
            main.post { browse(id) }
        }

        private fun browse(id: String) {
            val nsd = getSystemService(Context.NSD_SERVICE) as NsdManager
            // Some TVs drop multicast unless an app holds this while it listens.
            val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val lock = wifi.createMulticastLock("panda-discovery").apply { setReferenceCounted(false); acquire() }
            val found = mutableListOf<NsdServiceInfo>()
            val urls = mutableSetOf<String>()
            val listener = object : NsdManager.DiscoveryListener {
                override fun onServiceFound(info: NsdServiceInfo) { found.add(info) }
                override fun onServiceLost(info: NsdServiceInfo) {}
                override fun onDiscoveryStarted(type: String) {}
                override fun onDiscoveryStopped(type: String) {}
                override fun onStartDiscoveryFailed(type: String, code: Int) {}
                override fun onStopDiscoveryFailed(type: String, code: Int) {}
            }
            nsd.discoverServices("_panda._tcp", NsdManager.PROTOCOL_DNS_SD, listener)
            main.postDelayed({
                runCatching { nsd.stopServiceDiscovery(listener) }
                // Older Android resolves one service at a time: one after another.
                fun next(i: Int) {
                    if (i >= found.size) {
                        lock.release()
                        val json = JSONArray(urls.toList()).toString()
                        web.evaluateJavascript("window.__pandaDiscovered && window.__pandaDiscovered('$id', $json)", null)
                        return
                    }
                    nsd.resolveService(found[i], object : NsdManager.ResolveListener {
                        override fun onServiceResolved(info: NsdServiceInfo) {
                            val host = info.host?.hostAddress
                            if (host != null && !host.contains(':')) urls.add("http://$host:${info.port}")
                            main.post { next(i + 1) }
                        }
                        override fun onResolveFailed(info: NsdServiceInfo, code: Int) { main.post { next(i + 1) } }
                    })
                }
                next(0)
            }, 3000)
        }
    }

    /** The remote's Back goes to the app as Escape (Back in the client's key map). */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                web.evaluateJavascript(
                    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',keyCode:27,bubbles:true}))",
                    null,
                )
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    // The app's own lifecycle (clients/tv/src/lifecycle.ts): playback pauses and saves, preview
    // clips stop, while it's out of sight. Told before the WebView pauses its JavaScript.
    private fun setHidden(hidden: Boolean) {
        web.evaluateJavascript("window.pandaSetHidden && window.pandaSetHidden($hidden)", null)
    }

    override fun onPause() {
        setHidden(true)
        web.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        setHidden(false)
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }
}
