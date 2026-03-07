"use client";

import { useState, useRef, useCallback, type DragEvent } from "react";

interface Preset {
  minLen: number;
  maxLen: number;
  count: number;
}

interface ClipResult {
  clipUrl: string;
  srtUrl: string;
  hook: string;
  confidence: number;
  startSec: number;
  endSec: number;
}

interface ProcessResponse {
  jobId: string;
  preset: Preset;
  clips: ClipResult[];
  message?: string;
  error?: string;
}

type Platform = "tiktok" | "reels" | "shorts";
type Goal = "viral" | "monetize" | "grow" | "promote";
type Plan = "free" | "pro";

const PLATFORM_LABELS: Record<Platform, string> = {
  tiktok: "TikTok",
  reels: "Instagram Reels",
  shorts: "YouTube Shorts",
};

const GOAL_LABELS: Record<Goal, string> = {
  viral: "Go Viral",
  monetize: "Monetize",
  grow: "Grow Followers",
  promote: "Promote Podcast",
};

const STATUS_STEPS = [
  "Uploading video",
  "Extracting audio",
  "Transcribing video",
  "Finding viral moments",
  "Generating clips",
  "Adding captions",
  "Done",
];

function getRecommendation(
  platform: Platform,
  goal: Goal
): { minLen: number; maxLen: number; count: number } {
  const isReels = platform === "reels";
  if (goal === "viral")
    return { minLen: isReels ? 15 : 15, maxLen: isReels ? 20 : 25, count: 8 };
  if (goal === "monetize")
    return { minLen: isReels ? 50 : 60, maxLen: isReels ? 75 : 90, count: 3 };
  return { minLen: isReels ? 25 : 30, maxLen: isReels ? 35 : 45, count: 5 };
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function HomePage() {
  const [file, setFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState<Platform>("tiktok");
  const [goal, setGoal] = useState<Goal>("viral");
  const [plan, setPlan] = useState<Plan>("free");
  const [status, setStatus] = useState<string | null>(null);
  const [statusIdx, setStatusIdx] = useState(-1);
  const [result, setResult] = useState<ProcessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const rec = getRecommendation(platform, goal);

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && /\.(mp4|mov|m4v)$/i.test(f.name)) setFile(f);
  }, []);

  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setFile(f);
  };

  const simulateProgress = () => {
    // Simulate status steps; the backend does everything in one call,
    // so we advance steps on a timer to give visual feedback
    let idx = 0;
    setStatusIdx(0);
    setStatus(STATUS_STEPS[0]);
    const interval = setInterval(() => {
      idx++;
      if (idx < STATUS_STEPS.length - 1) {
        setStatusIdx(idx);
        setStatus(STATUS_STEPS[idx]);
      } else {
        clearInterval(interval);
      }
    }, 4000);
    return () => clearInterval(interval);
  };

  const handleGenerate = async () => {
    if (!file) return;
    setError(null);
    setResult(null);
    const cancel = simulateProgress();

    try {
      const form = new FormData();
      form.append("file", file);
      form.append("platform", platform);
      form.append("goal", goal);
      form.append("plan", plan);

      const res = await fetch("/api/process", {
        method: "POST",
        body: form,
      });

      const data: ProcessResponse = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error || "Processing failed");
      }

      setResult(data);
      setStatusIdx(STATUS_STEPS.length - 1);
      setStatus("Done");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setError(msg);
      setStatus(null);
      setStatusIdx(-1);
    } finally {
      cancel();
    }
  };

  return (
    <main className="max-w-3xl mx-auto px-4 py-12">
      {/* Header */}
      <div className="text-center mb-12">
        <h1 className="text-5xl font-bold gradient-text mb-3">
          ViralClips MVP
        </h1>
        <p className="text-gray-400 text-lg">
          Upload a long video. Get short viral clips with captions and hooks.
        </p>
      </div>

      {/* Upload + Settings (only show when no results) */}
      {!result && (
        <div className="space-y-6">
          {/* Drop Zone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-colors ${
              dragging
                ? "border-purple-400 bg-purple-500/10"
                : file
                  ? "border-green-500/60 bg-green-500/5"
                  : "border-gray-700 hover:border-gray-500 bg-gray-900/50"
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".mp4,.mov,.m4v"
              onChange={onFileSelect}
              className="hidden"
            />
            {file ? (
              <div>
                <div className="text-green-400 text-xl mb-1">
                  {file.name}
                </div>
                <div className="text-gray-500 text-sm">
                  {(file.size / 1024 / 1024).toFixed(1)} MB — click to change
                </div>
              </div>
            ) : (
              <div>
                <div className="text-4xl mb-3">🎬</div>
                <div className="text-gray-400 text-lg mb-1">
                  Drag &amp; drop your video here
                </div>
                <div className="text-gray-600 text-sm">
                  or click to browse — MP4, MOV, M4V
                </div>
              </div>
            )}
          </div>

          {/* Settings Row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Platform */}
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">
                Platform
              </label>
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value as Platform)}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:border-purple-500"
              >
                {(Object.entries(PLATFORM_LABELS) as [Platform, string][]).map(
                  ([val, label]) => (
                    <option key={val} value={val}>
                      {label}
                    </option>
                  )
                )}
              </select>
            </div>

            {/* Goal */}
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">
                Goal
              </label>
              <select
                value={goal}
                onChange={(e) => setGoal(e.target.value as Goal)}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:border-purple-500"
              >
                {(Object.entries(GOAL_LABELS) as [Goal, string][]).map(
                  ([val, label]) => (
                    <option key={val} value={val}>
                      {label}
                    </option>
                  )
                )}
              </select>
            </div>

            {/* Plan Toggle */}
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">
                Plan
              </label>
              <div className="flex bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
                <button
                  onClick={() => setPlan("free")}
                  className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                    plan === "free"
                      ? "bg-purple-600 text-white"
                      : "text-gray-400 hover:text-white"
                  }`}
                >
                  Free
                </button>
                <button
                  onClick={() => setPlan("pro")}
                  className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                    plan === "pro"
                      ? "bg-purple-600 text-white"
                      : "text-gray-400 hover:text-white"
                  }`}
                >
                  Pro
                </button>
              </div>
            </div>
          </div>

          {/* Recommended Settings */}
          <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-4">
            <div className="text-sm text-gray-400 mb-2">
              Recommended settings for{" "}
              <span className="text-purple-400">
                {GOAL_LABELS[goal]}
              </span>{" "}
              on{" "}
              <span className="text-purple-400">
                {PLATFORM_LABELS[platform]}
              </span>
            </div>
            <div className="flex gap-6 text-sm">
              <div>
                <span className="text-gray-500">Clip length:</span>{" "}
                <span className="text-white font-medium">
                  {rec.minLen}–{rec.maxLen}s
                </span>
              </div>
              <div>
                <span className="text-gray-500">Clips to generate:</span>{" "}
                <span className="text-white font-medium">{rec.count}</span>
              </div>
              {plan === "free" && (
                <div>
                  <span className="text-yellow-500 text-xs">
                    ⚡ Watermark on Free plan
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Generate Button */}
          <button
            onClick={handleGenerate}
            disabled={!file || (statusIdx >= 0 && statusIdx < STATUS_STEPS.length - 1)}
            className="w-full py-4 rounded-xl font-semibold text-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white shadow-lg shadow-purple-500/20"
          >
            {statusIdx >= 0 && statusIdx < STATUS_STEPS.length - 1
              ? "Processing..."
              : "Generate Clips"}
          </button>

          {/* Status */}
          {status && !result && !error && (
            <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-5">
              <div className="space-y-2">
                {STATUS_STEPS.map((step, i) => (
                  <div
                    key={step}
                    className={`flex items-center gap-3 text-sm transition-opacity ${
                      i <= statusIdx ? "opacity-100" : "opacity-30"
                    }`}
                  >
                    <span>
                      {i < statusIdx ? (
                        <span className="text-green-400">✓</span>
                      ) : i === statusIdx ? (
                        <span className="animate-pulse text-purple-400">●</span>
                      ) : (
                        <span className="text-gray-600">○</span>
                      )}
                    </span>
                    <span
                      className={
                        i === statusIdx
                          ? "text-white font-medium"
                          : i < statusIdx
                            ? "text-green-400"
                            : "text-gray-600"
                      }
                    >
                      {step}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="bg-red-900/30 border border-red-800 rounded-xl p-4 text-red-300 text-sm">
              <span className="font-semibold">Error:</span> {error}
            </div>
          )}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-white">
              Your Clips ({result.clips.length})
            </h2>
            <button
              onClick={() => {
                setResult(null);
                setFile(null);
                setStatus(null);
                setStatusIdx(-1);
              }}
              className="text-sm text-purple-400 hover:text-purple-300 underline"
            >
              Start Over
            </button>
          </div>

          {result.message && (
            <div className="bg-yellow-900/30 border border-yellow-700 rounded-xl p-4 text-yellow-300 text-sm">
              {result.message}
            </div>
          )}

          {result.clips.map((clip, i) => (
            <div
              key={i}
              className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden"
            >
              <div className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-lg font-semibold text-white">
                      Clip {i + 1}
                    </h3>
                    <div className="text-sm text-gray-400 mt-0.5">
                      {fmtTime(clip.startSec)} → {fmtTime(clip.endSec)}
                      <span className="ml-3 text-gray-600">
                        ({Math.round(clip.endSec - clip.startSec)}s)
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div
                      className={`text-sm font-semibold ${
                        clip.confidence >= 70
                          ? "text-green-400"
                          : clip.confidence >= 40
                            ? "text-yellow-400"
                            : "text-gray-400"
                      }`}
                    >
                      {clip.confidence}% confidence
                    </div>
                  </div>
                </div>

                {/* Hook */}
                <div className="bg-gray-950 rounded-lg p-3 mb-4">
                  <div className="text-xs text-gray-500 mb-1 uppercase tracking-wider">
                    Suggested Hook
                  </div>
                  <div className="text-gray-200 text-sm italic">
                    &ldquo;{clip.hook}&rdquo;
                  </div>
                </div>

                {/* Video Preview */}
                <video
                  controls
                  preload="metadata"
                  className="w-full max-h-[480px] rounded-lg bg-black"
                >
                  <source src={clip.clipUrl} type="video/mp4" />
                </video>

                {/* Downloads */}
                <div className="mt-4 flex items-center gap-3">
                  <a
                    href={clip.clipUrl}
                    download={`viralclip_${i + 1}.mp4`}
                    className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                    Download Clip
                  </a>
                  <a
                    href={clip.srtUrl}
                    download={`viralclip_${i + 1}.srt`}
                    className="inline-flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                    Download Captions (.srt)
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
