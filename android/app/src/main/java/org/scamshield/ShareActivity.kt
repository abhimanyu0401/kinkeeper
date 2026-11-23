package org.scamshield

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import org.scamshield.normalization.ShareIntentParser

/**
 * Android Share Target Activity for Scam Shield.
 *
 * Registered in AndroidManifest.xml for ACTION_SEND with:
 *   - text/plain
 *   - image formats (image/jpeg, image/png, etc.)
 *
 * Responsibilities:
 *   1. Intercepts incoming shares from WhatsApp, SMS, Telegram, Chrome, etc.
 *   2. Defensively validates and normalizes content via ShareIntentParser.
 *   3. Enforces payload boundaries and rejects unsafe URI schemes.
 *   4. Performs an ultra-fast, bridge-free handoff to /share in MainActivity.
 */
class ShareActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        try {
            val payload = ShareIntentParser.parseIntent(intent, contentResolver)

            if (payload == null) {
                Toast.makeText(this, getString(R.string.error_no_content), Toast.LENGTH_LONG).show()
                finish()
                return
            }

            // Cache payload in memory for bridge access (required for images/screenshots)
            SharePayloadHolder.currentPayload = payload

            val baseUrl = BuildConfig.API_BASE_URL.trimEnd('/')
            val shareUriBuilder = Uri.parse("$baseUrl/share").buildUpon()
                .appendQueryParameter("source", "android_share")
                .appendQueryParameter("type", payload.type)

            if (payload.content.isNotBlank()) {
                shareUriBuilder.appendQueryParameter("text", payload.content)
            }

            if (payload.extractedUrls.isNotEmpty() && !payload.isStandaloneUrl) {
                shareUriBuilder.appendQueryParameter("url", payload.extractedUrls[0])
            }

            val targetUri = shareUriBuilder.build()
            android.util.Log.i("ScamShield", "Share handoff: type=${payload.type}, urlCount=${payload.extractedUrls.size}")

            // Launch Scam Shield directly into the /share route
            val launchIntent = Intent(this, MainActivity::class.java).apply {
                data = targetUri
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }

            startActivity(launchIntent)
            finish()
        } catch (secEx: SecurityException) {
            Toast.makeText(this, secEx.message ?: "Security violation: Invalid share input", Toast.LENGTH_LONG).show()
            finish()
        } catch (argEx: IllegalArgumentException) {
            Toast.makeText(this, argEx.message ?: "Invalid share input", Toast.LENGTH_LONG).show()
            finish()
        } catch (ex: Exception) {
            Toast.makeText(this, getString(R.string.error_unsupported), Toast.LENGTH_LONG).show()
            finish()
        }
    }
}
