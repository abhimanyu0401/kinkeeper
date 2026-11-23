/**
 * scripts/test-android-share.ts
 *
 * Automated Integration Test Suite for Android Share Target & Normalization Layer.
 *
 * Tests the end-to-end integration:
 *   Android Share Intent Payload → Share Normalizer → POST /api/check → Detection Engine → Real Verdict
 */

import { POST, _safeBrowsingTestSeam, _embedTestSeam } from "../app/api/check/route";
import { NextRequest } from "next/server";
import {
  normalizeSharedInput,
  extractAndSanitizeUrls,
  MAX_SHARED_TEXT_LENGTH,
} from "../lib/ai/share-normalizer";
import { InvalidInputError, PayloadTooLargeError } from "../lib/ai/normalizer";

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ PASS: ${testName}`);
  } else {
    failedTests++;
    console.error(`  ✗ FAIL: ${testName}${detail ? ` - ${detail}` : ""}`);
  }
}

async function runTests() {
  console.log("\n=======================================================");
  console.log("  Android Share Target - Integration Test Suite");
  console.log("=======================================================\n");

  // Mock Safe Browsing and Embedding seams for deterministic offline test execution
  _safeBrowsingTestSeam.fn = async (urls: string[]) => {
    // Flag any URL containing "phish" or "malicious" as true, otherwise false
    return urls.some((u) => u.includes("phish") || u.includes("malicious"));
  };
  _embedTestSeam.fn = async () => null;

  // -------------------------------------------------------------
  // Section 1: Share Normalizer Unit Tests
  // -------------------------------------------------------------
  console.log("--- Section 1: Share Normalizer Unit Tests ---");

  // Test 1.1: Plain text extraction
  {
    const raw = {
      content: "Urgent: Your account is suspended. Send money immediately to avoid legal penalty.",
      source: "android_share",
    };
    const norm = normalizeSharedInput(raw);
    assert(norm.text === raw.content, "Extracts plain text content correctly");
    assert(norm.extractedUrls.length === 0, "Correctly identifies zero URLs in plain text");
    assert(norm.source === "android_share", "Preserves source metadata");
  }

  // Test 1.2: Standalone URL
  {
    const raw = {
      content: "https://secure-bank-login.xyz/update",
      source: "android_share",
    };
    const norm = normalizeSharedInput(raw);
    assert(norm.extractedUrls.length === 1, "Detects standalone URL");
    assert(norm.isStandaloneUrl === true, "Marks isStandaloneUrl flag as true");
    assert(norm.extractedUrls[0] === "https://secure-bank-login.xyz/update", "Preserves exact URL");
  }

  // Test 1.3: Text containing multiple URLs
  {
    const raw = {
      content: "Check KYC at https://portal.xyz/verify and also visit http://backup-portal.net/login now.",
      source: "android_share",
    };
    const norm = normalizeSharedInput(raw);
    assert(norm.extractedUrls.length === 2, "Extracts all embedded URLs from text");
    assert(norm.isStandaloneUrl === false, "Recognizes text with URLs is not standalone");
    assert(norm.text.includes("https://portal.xyz/verify"), "Preserves original message context");
  }

  // Test 1.4: URL provided separately in payload.url (Chrome / Browser share pattern)
  {
    const raw = {
      title: "Bank Login Suspicious Page",
      url: "https://secure-auth.example.com",
      source: "android_share",
    };
    const norm = normalizeSharedInput(raw);
    assert(norm.extractedUrls.includes("https://secure-auth.example.com"), "Handles separate url field");
  }

  // Test 1.5: Rejects dangerous URI schemes
  {
    let caughtDangerous = false;
    try {
      normalizeSharedInput({
        content: "javascript:alert(1)",
        source: "android_share",
      });
    } catch (e) {
      caughtDangerous = e instanceof InvalidInputError;
    }
    assert(caughtDangerous, "Rejects javascript: scheme");

    let caughtFile = false;
    try {
      normalizeSharedInput({
        content: "file:///etc/passwd",
        source: "android_share",
      });
    } catch (e) {
      caughtFile = e instanceof InvalidInputError;
    }
    assert(caughtFile, "Rejects file:/// scheme");
  }

  // Test 1.6: Rejects empty or whitespace content
  {
    let caughtEmpty = false;
    try {
      normalizeSharedInput({ content: "   ", source: "android_share" });
    } catch (e) {
      caughtEmpty = e instanceof InvalidInputError && e.message === "We couldn't find any content to analyze.";
    }
    assert(caughtEmpty, "Rejects empty content with exact required message");
  }

  // Test 1.7: Rejects oversized text (>50,000 chars)
  {
    let caughtOversized = false;
    try {
      const hugeText = "A".repeat(MAX_SHARED_TEXT_LENGTH + 100);
      normalizeSharedInput({ content: hugeText, source: "android_share" });
    } catch (e) {
      caughtOversized = e instanceof PayloadTooLargeError;
    }
    assert(caughtOversized, "Rejects oversized shared text (>50KB)");
  }

  // Test 1.8: Unicode and Hindi content
  {
    const hindiText = "आपका बैंक खाता ब्लॉक कर दिया गया है। तुरंत केवाईसी अपडेट करें http://bank-update.in";
    const norm = normalizeSharedInput({ content: hindiText, language: "hi", source: "android_share" });
    assert(norm.text === hindiText, "Handles Hindi Unicode text correctly");
    assert(norm.extractedUrls.length === 1, "Extracts URL from Hindi text");
    assert(norm.language === "hi", "Preserves Hindi language selection");
  }

  // -------------------------------------------------------------
  // Section 2: End-to-End POST /api/check Route Integration Tests
  // -------------------------------------------------------------
  console.log("\n--- Section 2: POST /api/check Route Integration Tests ---");

  // Test 2.1: Sharing suspicious plain text via { content, source: "android_share" }
  {
    const req = new NextRequest("http://localhost:3000/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "URGENT: Your SBI account is blocked. Send ₹5,000 immediately or legal warrant issued.",
        source: "android_share",
        language: "en",
      }),
    });

    const res = await POST(req);
    assert(res.status === 200, "Route returns HTTP 200 for shared text");
    const json = await res.json();
    assert(typeof json.riskScore === "number", "Returns real numerical riskScore");
    assert(json.riskScore >= 40, `Detects high risk score (${json.riskScore}/100)`);
    assert(Array.isArray(json.flags) && json.flags.length > 0, "Returns detected scam red flags");
    assert(typeof json.explanation === "string" && json.explanation.length > 0, "Returns explanation");
  }

  // Test 2.2: Sharing malicious URL via Android share
  {
    const req = new NextRequest("http://localhost:3000/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "https://phishing-bank-portal.xyz/login",
        source: "android_share",
      }),
    });

    const res = await POST(req);
    assert(res.status === 200, "Route returns HTTP 200 for shared URL");
    const json = await res.json();
    assert(json.riskScore >= 70, `Assigns high risk to malicious Safe Browsing URL match (${json.riskScore}/100)`);
  }

  // Test 2.3: Sharing text + URL combo
  {
    const req = new NextRequest("http://localhost:3000/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sharedInput: {
          type: "text",
          content: "Electricity bill overdue. Power cutoff at 9:30 PM. Pay now at https://bill-pay.click",
          source: "android_share",
        },
      }),
    });

    const res = await POST(req);
    assert(res.status === 200, "Route accepts sharedInput format with HTTP 200");
    const json = await res.json();
    assert(typeof json.riskScore === "number" && json.riskScore >= 0, `Returns valid risk score (${json.riskScore}/100)`);
    assert(json.analysisId !== undefined, "Emits analysisId for community reporting");
  }

  // Test 2.4: Empty payload returns HTTP 400
  {
    const req = new NextRequest("http://localhost:3000/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "   ",
        source: "android_share",
      }),
    });

    const res = await POST(req);
    assert(res.status === 400, "Route returns HTTP 400 for empty content");
    const json = await res.json();
    assert(json.error === "We couldn't find any content to analyze.", "Returns friendly empty error message");
  }

  // Test 2.5: Oversized text returns HTTP 413
  {
    const hugeText = "X".repeat(MAX_SHARED_TEXT_LENGTH + 500);
    const req = new NextRequest("http://localhost:3000/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: hugeText,
        source: "android_share",
      }),
    });

    const res = await POST(req);
    assert(res.status === 413, "Route returns HTTP 413 for oversized shared text");
  }

  // Test 2.6: Unchanged backward compatibility for legacy web callers
  {
    const req = new NextRequest("http://localhost:3000/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Hi Mom, I dropped my phone. Please text my new number.",
        language: "en",
      }),
    });

    const res = await POST(req);
    assert(res.status === 200, "Legacy { text, language } callers work without change");
    const json = await res.json();
    assert(typeof json.riskScore === "number" && json.riskScore >= 0, "Legacy caller receives analysis result");
  }

  // Cleanup test seams
  delete _safeBrowsingTestSeam.fn;
  delete _embedTestSeam.fn;

  console.log("\n=======================================================");
  console.log(`  Tests completed: ${totalTests}`);
  console.log(`  Passed: ${passedTests}`);
  console.log(`  Failed: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
