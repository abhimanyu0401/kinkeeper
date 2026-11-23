"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAuth } from "@/app/providers/AuthProvider";
import { AuthModal } from "@/app/components/AuthModal";

interface CheckResult {
  analysisId?: string;
  text: string;
  riskScore: number;
  flags: string[];
  explanation: string;
  embedding?: number[] | null;
  complaintDraft?: string;
  financialLossLikely?: boolean;
  isFallback?: boolean;
  isDegraded?: boolean;
  analysisMode?: string;
  analyzedAt?: string;
}

function ShareContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user } = useAuth();

  const [inputContent, setInputContent] = useState<string>("");
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [lastPayload, setLastPayload] = useState<{ text?: string; imageBase64?: string; mimeType?: string } | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedAlert, setCopiedAlert] = useState<boolean>(false);
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false);

  useEffect(() => {
    // 1. Try reading from native Android bridge first (vital for images / screenshots)
    let nativePayload: { type?: string; content?: string; imageBase64?: string; mimeType?: string } | null = null;
    if (typeof window !== "undefined" && (window as any).ScamShieldNative?.getSharedPayload) {
      try {
        const raw = (window as any).ScamShieldNative.getSharedPayload();
        if (raw) {
          nativePayload = JSON.parse(raw);
        }
      } catch (err) {
        console.error("Failed to parse native payload", err);
      }
    }

    if (nativePayload && nativePayload.type === "image" && nativePayload.imageBase64 && nativePayload.mimeType) {
      const dataUri = `data:${nativePayload.mimeType};base64,${nativePayload.imageBase64}`;
      setImagePreviewUrl(dataUri);
      setInputContent(nativePayload.content || "Shared Screenshot / Image");
      const payloadObj = {
        text: nativePayload.content || undefined,
        imageBase64: nativePayload.imageBase64,
        mimeType: nativePayload.mimeType,
      };
      setLastPayload(payloadObj);
      analyzeSharedContent(payloadObj);
      return;
    }

    // 2. Extract shared content from query parameters (Android Intent or PWA Share Target)
    const textParam = searchParams.get("text") || "";
    const urlParam = searchParams.get("url") || "";
    const contentParam = searchParams.get("content") || "";
    const titleParam = searchParams.get("title") || "";

    let resolvedText = "";
    if (nativePayload?.content?.trim()) {
      resolvedText = nativePayload.content.trim();
    } else if (contentParam.trim()) {
      resolvedText = contentParam.trim();
    } else if (textParam.trim()) {
      resolvedText = textParam.trim();
    }

    // If URL is separate, combine cleanly with text
    if (urlParam.trim() && !resolvedText.includes(urlParam.trim())) {
      resolvedText = resolvedText ? `${resolvedText}\n${urlParam.trim()}` : urlParam.trim();
    }

    if (!resolvedText && titleParam.trim()) {
      resolvedText = titleParam.trim();
    }

    if (!resolvedText) {
      setLoading(false);
      setError("We couldn't find any content to analyze.");
      return;
    }

    setInputContent(resolvedText);
    const payloadObj = { text: resolvedText };
    setLastPayload(payloadObj);
    analyzeSharedContent(payloadObj);
  }, [searchParams]);

  async function analyzeSharedContent(payload: { text?: string; imageBase64?: string; mimeType?: string }) {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const bodyPayload: Record<string, unknown> = {
        source: "android_share",
        language: "en",
      };

      if (payload.imageBase64 && payload.mimeType) {
        bodyPayload.imageBase64 = payload.imageBase64;
        bodyPayload.mimeType = payload.mimeType;
        if (payload.text) bodyPayload.text = payload.text;
      } else if (payload.text) {
        bodyPayload.content = payload.text;
      }

      const response = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      });

      if (!response.ok) {
        let errMsg = "Failed to analyze message.";
        try {
          const errData = await response.json();
          if (errData?.error) {
            errMsg = errData.error;
          }
        } catch {
          if (response.status === 413) {
            errMsg = "Shared content is too large. Please keep it under 2.5MB.";
          } else if (response.status >= 500) {
            errMsg = "We couldn't connect to Scam Shield. Check your internet connection and try again.";
          }
        }
        throw new Error(errMsg);
      }

      const data: CheckResult = await response.json();
      setResult(data);
    } catch (err: unknown) {
      if (err instanceof TypeError && err.message.includes("fetch")) {
        setError("We couldn't connect to Scam Shield. Check your internet connection and try again.");
      } else {
        setError(err instanceof Error ? err.message : "An unknown error occurred.");
      }
    } finally {
      setLoading(false);
    }
  }

  const riskScore = result?.riskScore ?? 0;
  const isHighRisk = riskScore > 70;
  const isMediumRisk = riskScore >= 40 && riskScore <= 70;
  const isLowRisk = riskScore < 40;

  const verdictLabel = isHighRisk ? "HIGH RISK SCAM" : isMediumRisk ? "SUSPICIOUS MESSAGE" : "SAFE / LOW RISK";
  const verdictSubtitle = isHighRisk
    ? "This message shows strong indicators of fraud or a deceptive scam."
    : isMediumRisk
    ? "Exercise caution. This message contains suspicious or urgent patterns."
    : "No obvious scam signals were identified in this message.";

  const recommendedActions = isHighRisk
    ? [
        "Do NOT click any links in the message",
        "Do NOT share OTP, banking PINs, or card numbers",
        "Block and report the sender on WhatsApp/SMS",
        "Never transfer money or send advance fees",
      ]
    : isMediumRisk
    ? [
        "Verify the sender's identity through official channels",
        "Do not click shortened or unfamiliar links",
        "Never disclose sensitive financial credentials",
      ]
    : [
        "Message appears benign based on known threat patterns",
        "Continue exercising standard cyber hygiene",
      ];

  async function handleCopyAlert() {
    if (!result) return;
    const flagLines = result.flags && result.flags.length > 0
      ? result.flags.map((f) => `• ${f}`).join("\n")
      : "• None detected";

    const preview = result.text.length > 200 ? `${result.text.slice(0, 200)}…` : result.text;
    const shareMessage = [
      `🚨 SCAM SHIELD ALERT`,
      ``,
      `Risk Level: ${verdictLabel} (${result.riskScore}/100)`,
      ``,
      `Detected Indicators:`,
      flagLines,
      ``,
      `Explanation:`,
      result.explanation,
      ``,
      `Message:`,
      `"${preview}"`,
      ``,
      `— Verified with Scam Shield`,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(shareMessage);
      setCopiedAlert(true);
      setTimeout(() => setCopiedAlert(false), 2000);
    } catch {
      // Fallback if clipboard permission is restricted
    }
  }

  return (
    <div className="min-h-screen bg-[#07090E] text-slate-100 flex flex-col items-center justify-start p-4 sm:p-6 antialiased">
      {/* Top App Header */}
      <header className="w-full max-w-lg flex items-center justify-between py-3 mb-4 border-b border-slate-800/80">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-extrabold tracking-tight text-white flex items-center gap-1.5">
              Scam Shield
              <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30">
                Share Target
              </span>
            </h1>
            <p className="text-xs text-slate-400">Android Instant Analysis</p>
          </div>
        </div>

        <button
          onClick={() => router.push("/")}
          className="text-xs font-semibold text-slate-400 hover:text-white px-2.5 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/60 transition-colors"
        >
          Open App
        </button>
      </header>

      {/* Main Analysis Container */}
      <main className="w-full max-w-lg space-y-4">
        {/* Loading State */}
        {loading && (
          <div className="rounded-3xl bg-[#0F1420] border border-slate-800 p-8 text-center space-y-5 shadow-2xl">
            <div className="relative w-20 h-20 mx-auto flex items-center justify-center">
              <div className="absolute inset-0 rounded-full border-4 border-blue-500/20 animate-ping" />
              <div className="absolute inset-0 rounded-full border-4 border-t-blue-500 border-r-indigo-500 border-b-transparent border-l-transparent animate-spin" />
              <div className="w-12 h-12 rounded-2xl bg-blue-500/20 border border-blue-500/40 flex items-center justify-center">
                <svg className="w-6 h-6 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
            </div>

            <div>
              <h2 className="text-xl font-extrabold text-white">Analyzing Shared Content</h2>
              <p className="text-xs text-slate-400 mt-1 max-w-xs mx-auto">
                Running deterministic threat patterns, Safe Browsing lookup, and AI scam detection...
              </p>
            </div>

            {imagePreviewUrl ? (
              <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80 text-center space-y-2">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Shared Screenshot / Image</p>
                <img
                  src={imagePreviewUrl}
                  alt="Shared Screenshot"
                  className="max-h-52 mx-auto rounded-lg object-contain border border-slate-800"
                />
              </div>
            ) : inputContent ? (
              <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80 text-left">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Incoming Content</p>
                <p className="text-xs text-slate-300 font-mono line-clamp-3 break-all">
                  {inputContent}
                </p>
              </div>
            ) : null}
          </div>
        )}

        {/* Error State */}
        {!loading && error && (
          <div className="rounded-3xl bg-[#0F1420] border border-red-500/30 p-6 sm:p-8 text-center space-y-4 shadow-xl shadow-red-500/5">
            <div className="w-14 h-14 rounded-2xl bg-red-500/20 border border-red-500/40 flex items-center justify-center mx-auto text-red-400">
              <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>

            <div>
              <h2 className="text-lg font-bold text-white">Analysis Notice</h2>
              <p className="text-sm text-slate-300 mt-1.5">{error}</p>
            </div>

            <div className="flex flex-col gap-2 pt-2">
              {lastPayload && (
                <button
                  onClick={() => analyzeSharedContent(lastPayload)}
                  className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-colors cursor-pointer"
                >
                  Try Again
                </button>
              )}
              <button
                onClick={() => router.push("/")}
                className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition-colors cursor-pointer"
              >
                Go to Scam Shield Home
              </button>
            </div>
          </div>
        )}

        {/* Result State */}
        {!loading && result && (
          <div className="space-y-4">
            {/* 1. Main Risk Verdict Card */}
            <div
              className={`rounded-3xl p-6 sm:p-8 text-center border transition-all ${
                isHighRisk
                  ? "bg-gradient-to-b from-red-500/20 via-rose-950/25 to-[#0F1420] border-red-500/50 text-white shadow-2xl shadow-red-500/15"
                  : isMediumRisk
                  ? "bg-gradient-to-b from-amber-500/20 via-yellow-950/25 to-[#0F1420] border-amber-500/50 text-white shadow-2xl shadow-amber-500/15"
                  : "bg-gradient-to-b from-emerald-500/20 via-teal-950/25 to-[#0F1420] border-emerald-500/50 text-white shadow-2xl shadow-emerald-500/15"
              }`}
            >
              {/* Severity Icon */}
              <div className="flex justify-center mb-4">
                <div
                  className={`w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg ${
                    isHighRisk
                      ? "bg-red-600 text-white shadow-red-600/40"
                      : isMediumRisk
                      ? "bg-amber-500 text-slate-950 shadow-amber-500/40"
                      : "bg-emerald-500 text-white shadow-emerald-500/40"
                  }`}
                >
                  {isHighRisk ? (
                    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                  ) : isMediumRisk ? (
                    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  ) : (
                    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      <polyline points="9 12 11 14 15 10" />
                    </svg>
                  )}
                </div>
              </div>

              {/* Score & Verdict */}
              <div className="inline-block px-3 py-1 rounded-full text-xs font-black tracking-wider uppercase mb-2 border border-current/30">
                Risk Score: {result.riskScore}/100
              </div>

              <h2 className="text-2xl sm:text-3xl font-black tracking-tight uppercase">
                {verdictLabel}
              </h2>

              <p className="text-xs sm:text-sm text-slate-300 mt-2 max-w-md mx-auto">
                {verdictSubtitle}
              </p>
            </div>

            {/* 2. Detected Red Flags */}
            <div className="rounded-2xl bg-[#0F1420] border border-slate-800 p-5 space-y-3">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                <svg className="w-4 h-4 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <polygon points="12 2 2 7 12 12 22 7 12 2" />
                  <polyline points="2 17 12 22 22 17" />
                  <polyline points="2 12 12 17 22 12" />
                </svg>
                Detected Indicators
              </h3>

              {result.flags && result.flags.length > 0 ? (
                <ul className="space-y-2">
                  {result.flags.map((flag, idx) => (
                    <li key={idx} className="flex items-start gap-2.5 text-xs sm:text-sm text-slate-200">
                      <span className="text-red-400 font-bold mt-0.5">•</span>
                      <span>{flag}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-slate-400">No suspicious scam indicators found.</p>
              )}
            </div>

            {/* 3. Explanation Card */}
            <div className="rounded-2xl bg-[#0F1420] border border-slate-800 p-5 space-y-2.5">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                <svg className="w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                Why this score was assigned
              </h3>
              <p className="text-xs sm:text-sm text-slate-300 leading-relaxed whitespace-pre-line">
                {result.explanation}
              </p>
            </div>

            {/* 4. Recommended Actions */}
            <div className="rounded-2xl bg-[#0F1420] border border-slate-800 p-5 space-y-3">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                <svg className="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                Recommended Actions
              </h3>
              <ul className="space-y-2">
                {recommendedActions.map((action, idx) => (
                  <li key={idx} className="flex items-start gap-2.5 text-xs sm:text-sm text-slate-200">
                    <span className="text-emerald-400 font-bold mt-0.5">✓</span>
                    <span>{action}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* 5. Shared Message / Screenshot Preview */}
            <div className="rounded-2xl bg-[#0F1420]/60 border border-slate-800/60 p-4 space-y-2">
              <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                {imagePreviewUrl ? "Analyzed Screenshot & Extracted Text" : "Analyzed Message"}
              </p>
              {imagePreviewUrl && (
                <img
                  src={imagePreviewUrl}
                  alt="Analyzed Screenshot"
                  className="max-h-48 rounded-lg object-contain border border-slate-800"
                />
              )}
              {result.text && (
                <p className="text-xs text-slate-400 font-mono break-all line-clamp-4">
                  {result.text}
                </p>
              )}
            </div>

            {/* 6. Action Buttons */}
            <div className="space-y-2.5 pt-2">
              <button
                onClick={handleCopyAlert}
                className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all cursor-pointer shadow-lg shadow-blue-600/20"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>{copiedAlert ? "✓ Alert Copied!" : "Copy Alert to Share"}</span>
              </button>

              <button
                onClick={() => router.push("/")}
                className="w-full py-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 font-semibold text-xs transition-colors cursor-pointer text-center"
              >
                Open in Full Scam Shield App
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Auth Modal for Circle integration if requested */}
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} theme="dark" />}
    </div>
  );
}

export default function SharePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#07090E] flex items-center justify-center text-slate-400 text-xs">
          Loading Scam Shield...
        </div>
      }
    >
      <ShareContent />
    </Suspense>
  );
}
