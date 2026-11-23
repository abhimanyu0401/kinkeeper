package org.scamshield

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

/**
 * Main Activity hosting the Scam Shield application experience in a native Android WebView.
 *
 * Responsibilities:
 *   1. Provides hardware-accelerated WebView rendering for the Next.js web client.
 *   2. Enables Cookie & LocalStorage persistence for Supabase authentication.
 *   3. Handles deep linking and incoming share navigation (/share).
 *   4. Displays friendly offline error states if the host server is unreachable.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private lateinit var errorLayout: View
    private lateinit var errorText: TextView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webview)
        progressBar = findViewById(R.id.progress_bar)
        errorLayout = findViewById(R.id.error_layout)
        errorText = findViewById(R.id.error_text)

        findViewById<View>(R.id.btn_retry)?.setOnClickListener {
            errorLayout.visibility = View.GONE
            webView.settings.cacheMode = WebSettings.LOAD_NO_CACHE
            handleIntent(intent)
        }

        setupWebView()
        handleIntent(intent)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    finish()
                }
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.setSupportZoom(false)

        // Enable cookie persistence for Supabase authentication
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)

        // Expose native payload bridge for large/multimodal shares (e.g. screenshots)
        webView.addJavascriptInterface(object {
            @android.webkit.JavascriptInterface
            fun getSharedPayload(): String? {
                val payload = SharePayloadHolder.currentPayload ?: return null
                val json = org.json.JSONObject()
                json.put("type", payload.type)
                json.put("content", payload.content)
                json.put("imageBase64", payload.imageBase64 ?: "")
                json.put("mimeType", payload.mimeType ?: "")
                return json.toString()
            }
        }, "ScamShieldNative")

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress < 100) {
                    progressBar.visibility = View.VISIBLE
                    progressBar.progress = newProgress
                } else {
                    progressBar.visibility = View.GONE
                }
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                errorLayout.visibility = View.GONE
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    val host = request.url?.host ?: "backend"
                    val desc = error?.description?.toString() ?: "Connection error"
                    android.util.Log.e("ScamShield", "WebView connection error on $host: $desc")
                    errorLayout.visibility = View.VISIBLE
                    errorText.text = "Unable to connect to Scam Shield at $host.\n($desc)"
                }
            }

            override fun onReceivedHttpError(
                view: WebView?,
                request: WebResourceRequest?,
                errorResponse: android.webkit.WebResourceResponse?
            ) {
                if (request?.isForMainFrame == true) {
                    android.util.Log.e("ScamShield", "HTTP error: ${errorResponse?.statusCode}")
                }
            }
        }
    }

    private fun handleIntent(intent: Intent?) {
        val targetUrl = intent?.data?.toString() ?: BuildConfig.API_BASE_URL
        android.util.Log.i("ScamShield", "Navigating to: ${Uri.parse(targetUrl).scheme}://${Uri.parse(targetUrl).authority}${Uri.parse(targetUrl).path}")
        webView.loadUrl(targetUrl)
    }
}
