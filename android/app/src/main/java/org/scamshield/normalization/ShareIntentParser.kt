package org.scamshield.normalization

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.regex.Pattern

/**
 * Defensive parser for incoming Android Share Intents (ACTION_SEND).
 *
 * Enforces:
 *   1. Strict text size limits (max 50,000 characters).
 *   2. Rejection of local file:// and dangerous URI schemes.
 *   3. Safe content:// stream resolution with a 2.5MB ceiling for images.
 *   4. URL detection and isolation without altering message context.
 */
object ShareIntentParser {

    const val MAX_TEXT_LENGTH = 50_000
    const val MAX_IMAGE_BYTES = 2_500_000 // 2.5MB

    private val URL_PATTERN = Pattern.compile(
        "https?://(?:www\\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\\.[a-zA-Z0-9()]{1,24}\\b(?:[-a-zA-Z0-9()@:%_+.~#?&//=]*)",
        Pattern.CASE_INSENSITIVE
    )

    private val DANGEROUS_SCHEMES = listOf("file", "javascript", "data", "vbscript", "blob")

    /**
     * Extracts all HTTP/HTTPS URLs from text.
     */
    fun extractUrls(text: String): List<String> {
        val matcher = URL_PATTERN.matcher(text)
        val urls = mutableListOf<String>()
        while (matcher.find()) {
            val url = matcher.group()
            urls.add(url)
        }
        return urls.distinct()
    }

    /**
     * Safely parses an incoming ACTION_SEND intent into a canonical ParsedSharePayload.
     */
    fun parseIntent(intent: Intent, contentResolver: ContentResolver? = null): ParsedSharePayload? {
        if (intent.action != Intent.ACTION_SEND) {
            return null
        }

        val mimeType = intent.type ?: "text/plain"

        // --- 1. Handle Images (ACTION_SEND with image/*) ---
        if (mimeType.startsWith("image/")) {
            val streamUri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                ?: intent.clipData?.let { if (it.itemCount > 0) it.getItemAt(0).uri else null }

            if (streamUri != null && contentResolver != null) {
                // Reject dangerous schemes like file://
                val scheme = streamUri.scheme?.lowercase() ?: ""
                if (DANGEROUS_SCHEMES.contains(scheme) || scheme == "file") {
                    throw SecurityException("Direct file:// URI access is prohibited.")
                }

                val imageBytes = readUriWithLimit(contentResolver, streamUri, MAX_IMAGE_BYTES)
                if (imageBytes != null && imageBytes.isNotEmpty()) {
                    val base64 = Base64.encodeToString(imageBytes, Base64.NO_WRAP)
                    val resolvedMime = contentResolver.getType(streamUri) ?: mimeType
                    return ParsedSharePayload(
                        type = "image",
                        content = intent.getStringExtra(Intent.EXTRA_TEXT) ?: "",
                        imageBase64 = base64,
                        mimeType = resolvedMime,
                        source = "android_share"
                    )
                }
            }
        }

        // --- 2. Handle Text / URLs (ACTION_SEND with text/plain) ---
        var rawText: String? = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()

        // Some apps (e.g. Chrome, WhatsApp) provide formatted text, subject, process text, or ClipData
        if (rawText.isNullOrBlank()) {
            val subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()
            val clipData = intent.clipData
            val clipText = if (clipData != null && clipData.itemCount > 0) {
                clipData.getItemAt(0).text?.toString()
            } else null
            val processText = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()

            rawText = when {
                !clipText.isNullOrBlank() -> clipText
                !processText.isNullOrBlank() -> processText
                !subject.isNullOrBlank() -> subject
                else -> null
            }
        }

        if (rawText.isNullOrBlank()) {
            return null
        }

        val trimmed = rawText.trim()
        if (trimmed.isEmpty()) {
            return null
        }

        // Check for oversized payload
        if (trimmed.length > MAX_TEXT_LENGTH) {
            throw IllegalArgumentException("Shared text exceeds limit of $MAX_TEXT_LENGTH characters.")
        }

        // Check for dangerous schemes
        val lower = trimmed.lowercase()
        for (badScheme in DANGEROUS_SCHEMES) {
            if (lower.startsWith("$badScheme:")) {
                throw SecurityException("Cannot share dangerous URI scheme: $badScheme")
            }
        }

        val urls = extractUrls(trimmed)
        val isStandalone = urls.size == 1 && urls[0].equals(trimmed, ignoreCase = true)
        val type = if (isStandalone) "url" else "text"

        return ParsedSharePayload(
            type = type,
            content = trimmed,
            extractedUrls = urls,
            isStandaloneUrl = isStandalone,
            source = "android_share"
        )
    }

    /**
     * Safely reads an input stream with a hard byte cap to prevent OutOfMemoryError.
     */
    private fun readUriWithLimit(resolver: ContentResolver, uri: Uri, maxBytes: Int): ByteArray? {
        var inputStream: InputStream? = null
        try {
            inputStream = resolver.openInputStream(uri) ?: return null
            val buffer = ByteArray(8192)
            val output = ByteArrayOutputStream()
            var totalRead = 0
            var bytesRead: Int

            while (inputStream.read(buffer).also { bytesRead = it } != -1) {
                totalRead += bytesRead
                if (totalRead > maxBytes) {
                    throw IllegalArgumentException("Image exceeds maximum allowed size of 2.5MB.")
                }
                output.write(buffer, 0, bytesRead)
            }
            return output.toByteArray()
        } finally {
            try {
                inputStream?.close()
            } catch (_: Exception) {}
        }
    }
}
