package org.scamshield.normalization

/**
 * Canonical normalized representation of content shared to Scam Shield.
 */
data class ParsedSharePayload(
    val type: String, // "text", "url", "image"
    val content: String,
    val extractedUrls: List<String> = emptyList(),
    val isStandaloneUrl: Boolean = false,
    val imageBase64: String? = null,
    val mimeType: String? = null,
    val source: String = "android_share"
)
