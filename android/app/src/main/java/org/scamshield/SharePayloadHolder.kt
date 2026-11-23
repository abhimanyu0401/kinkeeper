package org.scamshield

import org.scamshield.normalization.ParsedSharePayload

/**
 * Thread-safe, in-memory holder for shared payloads (especially images)
 * passed from ShareActivity to MainActivity within the same app process.
 * Avoids IPC / Binder transaction buffer limits (1MB) on Android.
 */
object SharePayloadHolder {
    @Volatile
    var currentPayload: ParsedSharePayload? = null
}
