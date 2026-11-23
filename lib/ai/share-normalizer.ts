/**
 * lib/ai/share-normalizer.ts
 *
 * Canonical Input Normalization Layer for Shared Content (Android & Web Share Targets).
 *
 * Responsibilities:
 *   1. Accepts untrusted shared content from Android Share Target (ACTION_SEND) and PWA Share Target.
 *   2. Validates payload boundaries (max 50,000 characters for text, max 3.8MB for base64).
 *   3. Rejects dangerous URI schemes (file://, javascript://, data://).
 *   4. Extracts embedded URLs while preserving full message context.
 *   5. Normalizes into the canonical format consumed by the existing /api/check pipeline.
 *
 * Invariants:
 *   - Never alters the existing detection pipeline or AI routing.
 *   - Strictly redacts/avoids logging of sensitive message content or URLs.
 *   - Fails fast on unsupported, empty, or oversized payloads with friendly error messages.
 */

import {
  InvalidInputError,
  PayloadTooLargeError,
  MAX_BASE64_PAYLOAD_LENGTH,
} from "./normalizer";

// Maximum length of text accepted from a shared payload (50,000 characters ≈ 50KB)
export const MAX_SHARED_TEXT_LENGTH = 50_000;

// Regular expression to identify HTTP/HTTPS URLs
export const URL_EXTRACTION_REGEX =
  /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,24}\b(?:[-a-zA-Z0-9()@:%_+.~#?&//=]*)/gi;

// Rejected / dangerous schemes
const DANGEROUS_SCHEMES_REGEX = /^(?:javascript|file|data|vbscript|blob):/i;

export interface SharedInputPayload {
  type?: "text" | "url" | "image" | "audio" | "file";
  content?: string;
  url?: string;
  title?: string;
  imageBase64?: string;
  mimeType?: string;
  source?: string;
  language?: "en" | "hi";
}

export interface NormalizedShareResult {
  text: string;
  language: "en" | "hi";
  imageBase64?: string;
  mimeType?: string;
  extractedUrls: string[];
  isStandaloneUrl: boolean;
  source: string;
}

/**
 * Extracts and sanitizes URLs from the provided text.
 * Rejects dangerous schemes.
 */
export function extractAndSanitizeUrls(text: string): string[] {
  const matches = text.match(URL_EXTRACTION_REGEX) || [];
  const validUrls: string[] = [];

  for (const raw of matches) {
    const clean = raw.trim();
    if (DANGEROUS_SCHEMES_REGEX.test(clean)) {
      continue;
    }
    try {
      const parsed = new URL(clean);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        validUrls.push(clean);
      }
    } catch {
      // Skip malformed URL
    }
  }

  return Array.from(new Set(validUrls));
}

/**
 * Normalizes any incoming shared content into a canonical representation
 * ready for the existing Scam Shield detection engine.
 */
export function normalizeSharedInput(
  payload: SharedInputPayload | null | undefined
): NormalizedShareResult {
  if (!payload || typeof payload !== "object") {
    throw new InvalidInputError("We couldn't find any content to analyze.");
  }

  const language: "en" | "hi" = payload.language === "hi" ? "hi" : "en";
  const source = payload.source || "android_share";

  // 1. Handle Image Modality (if provided)
  if (payload.imageBase64 && payload.mimeType) {
    if (typeof payload.imageBase64 !== "string" || typeof payload.mimeType !== "string") {
      throw new InvalidInputError("Invalid imageBase64 or mimeType format.");
    }

    if (payload.imageBase64.length > MAX_BASE64_PAYLOAD_LENGTH) {
      throw new PayloadTooLargeError("Image file too large. Please keep it under 2.5MB.");
    }

    const cleanMime = payload.mimeType.toLowerCase().trim();
    if (!cleanMime.startsWith("image/")) {
      throw new InvalidInputError("Scam Shield can't analyze this type of content yet.");
    }

    return {
      text: (payload.content || "").trim(),
      language,
      imageBase64: payload.imageBase64,
      mimeType: cleanMime,
      extractedUrls: [],
      isStandaloneUrl: false,
      source,
    };
  }

  // 2. Resolve Text / URL Content
  // Android shares may provide text in `content`, `url`, or both (e.g. Chrome shares title + url in text).
  let rawText = "";

  if (typeof payload.content === "string") {
    rawText = payload.content;
  }

  if (typeof payload.url === "string" && payload.url.trim()) {
    const cleanUrl = payload.url.trim();
    if (DANGEROUS_SCHEMES_REGEX.test(cleanUrl)) {
      throw new InvalidInputError("Scam Shield cannot analyze unsafe URI schemes.");
    }
    if (!rawText.includes(cleanUrl)) {
      rawText = rawText ? `${rawText}\n${cleanUrl}` : cleanUrl;
    }
  }

  const trimmedText = rawText.trim();

  // Validate presence of content
  if (!trimmedText) {
    throw new InvalidInputError("We couldn't find any content to analyze.");
  }

  // Validate payload size bounds
  if (trimmedText.length > MAX_SHARED_TEXT_LENGTH) {
    throw new PayloadTooLargeError(
      `Shared text too large (${trimmedText.length.toLocaleString()} characters). Please share messages under ${MAX_SHARED_TEXT_LENGTH.toLocaleString()} characters.`
    );
  }

  // Reject standalone dangerous schemes
  if (DANGEROUS_SCHEMES_REGEX.test(trimmedText)) {
    throw new InvalidInputError("Scam Shield cannot analyze unsafe URI schemes.");
  }

  // 3. Extract URLs
  const extractedUrls = extractAndSanitizeUrls(trimmedText);
  const isStandaloneUrl =
    extractedUrls.length === 1 &&
    extractedUrls[0].toLowerCase() === trimmedText.toLowerCase();

  return {
    text: trimmedText,
    language,
    extractedUrls,
    isStandaloneUrl,
    source,
  };
}
