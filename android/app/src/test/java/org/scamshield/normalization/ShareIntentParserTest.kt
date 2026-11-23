package org.scamshield.normalization

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ShareIntentParserTest {

    @Test
    fun testExtractUrls_standaloneUrl() {
        val text = "https://secure-bank-login.xyz/update"
        val urls = ShareIntentParser.extractUrls(text)
        assertEquals(1, urls.size)
        assertEquals("https://secure-bank-login.xyz/update", urls[0])
    }

    @Test
    fun testExtractUrls_embeddedUrls() {
        val text = "Dear customer, verify KYC at https://bank-verify.in or visit http://portal.com/help today."
        val urls = ShareIntentParser.extractUrls(text)
        assertEquals(2, urls.size)
        assertTrue(urls.contains("https://bank-verify.in"))
        assertTrue(urls.contains("http://portal.com/help"))
    }

    @Test
    fun testExtractUrls_plainTextNoUrls() {
        val text = "Urgent: Your payment of 5000 INR is pending. Call immediately."
        val urls = ShareIntentParser.extractUrls(text)
        assertTrue(urls.isEmpty())
    }

    @Test
    fun testPayloadDataClass() {
        val payload = ParsedSharePayload(
            type = "text",
            content = "Test content",
            extractedUrls = listOf("https://example.com"),
            isStandaloneUrl = false,
            source = "android_share"
        )
        assertEquals("text", payload.type)
        assertEquals("Test content", payload.content)
        assertEquals(1, payload.extractedUrls.size)
        assertFalse(payload.isStandaloneUrl)
        assertEquals("android_share", payload.source)
    }

    @Test
    fun testMaxTextLengthConstant() {
        assertEquals(50_000, ShareIntentParser.MAX_TEXT_LENGTH)
        assertEquals(2_500_000, ShareIntentParser.MAX_IMAGE_BYTES)
    }
}
