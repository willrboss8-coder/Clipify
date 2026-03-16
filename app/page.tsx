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
type Goal = "viral" | "monetize";
type Plan = "free" | "pro";

const PLATFORM_LABELS: Record<Platform, string> = {
  tiktok: "TikTok",
  reels: "Instagram Reels",
  shorts: "YouTube Shorts",
};

const GOAL_LABELS: Record<Goal, string> = {
  viral: "Go Viral",
  monetize: "Monetize",
};

const FREE_FIND_ANOTHER_LIMIT = 3;

const STATUS_STEPS = [
  "Uploading video",
  "Extracting audio",
  "Transcribing video",
  "Selecting clips",
  "Processing video",
  "Finalizing results",
  "Done",
];

const STEP_DELAYS = [3000, 4000, 6000, 5000, 8000, 6000];

function getRecommendation(
  _platform: Platform,
  goal: Goal
): { minLen: number; maxLen: number; count: number } {
  if (goal === "viral") return { minLen: 20, maxLen: 30, count: 5 };
  return { minLen: 60, maxLen: 90, count: 3 };
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
  const [openEditClipIndex, setOpenEditClipIndex] = useState<number | null>(null);
  const [clipEditLoadingIndex, setClipEditLoadingIndex] = useState<number | null>(null);
  const [clipFindAnotherLoadingIndex, setClipFindAnotherLoadingIndex] = useState<number | null>(null);
  const [clipSuccess, setClipSuccess] = useState<{ index: number; message: string } | null>(null);
  const [clipError, setClipError] = useState<{ index: number; message: string } | null>(null);
  const [originalClips, setOriginalClips] = useState<Record<number, ClipResult>>({});
  const [previousClipState, setPreviousClipState] = useState<Record<number, ClipResult>>({});
  const [findAnotherUsed, setFindAnotherUsed] = useState(0);
  const [previousFindAnotherClip, setPreviousFindAnotherClip] = useState<Record<number, ClipResult>>({});
  const [seenClipHistory, setSeenClipHistory] = useState<Record<number, { startSec: number; endSec: number }[]>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showClipSuccess = useCallback((index: number, message: string) => {
    if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
    setClipSuccess({ index, message });
    successTimeoutRef.current = setTimeout(() => {
      setClipSuccess(null);
      successTimeoutRef.current = null;
    }, 2500);
  }, []);

  const isEditLoading = (index: number) => clipEditLoadingIndex === index;
  const isFindAnotherLoading = (index: number) => clipFindAnotherLoadingIndex === index;

  type EditKind =
    | "start-earlier"
    | "start-later"
    | "end-earlier"
    | "end-later"
    | "shorter"
    | "longer";

  const EDIT_LABELS: Record<EditKind, string> = {
    "start-earlier": "Start Earlier",
    "start-later": "Start Later",
    "end-earlier": "End Earlier",
    "end-later": "End Later",
    "shorter": "Make It Shorter",
    "longer": "Make It Longer",
  };

  const handleEditAction = useCallback(
    async (index: number, kind: EditKind) => {
      if (!result || isEditLoading(index)) return;
      const clip = result.clips[index];
      if (!clip || !result.jobId) return;

      // Save current state for undo before any mutation
      setPreviousClipState((prev) => ({ ...prev, [index]: { ...clip } }));

      let newStart = clip.startSec;
      let newEnd = clip.endSec;

      switch (kind) {
        case "start-earlier":
          newStart = Math.max(0, newStart - 2);
          break;
        case "start-later":
          newStart = Math.min(newEnd - 1, newStart + 2);
          break;
        case "end-earlier":
          newEnd = Math.max(newStart + 1, newEnd - 2);
          break;
        case "end-later":
          newEnd = newEnd + 2;
          break;
        case "shorter":
          newStart = Math.min(newEnd - 2, newStart + 1);
          newEnd = Math.max(newStart + 1, newEnd - 1);
          break;
        case "longer":
          newStart = Math.max(0, newStart - 1);
          newEnd = newEnd + 1;
          break;
      }

      if (newEnd <= newStart) newEnd = newStart + 1;

      setClipError(null);
      setClipEditLoadingIndex(index);
      console.log(`[Clip Debug] Requesting regenerate for clipIndex=${index}, start=${newStart}, end=${newEnd}`);

      setResult((prev) =>
        prev
          ? {
              ...prev,
              clips: prev.clips.map((c, i) =>
                i === index ? { ...c, startSec: newStart, endSec: newEnd } : c
              ),
            }
          : prev
      );

      try {
        const res = await fetch("/api/clip/regenerate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobId: result.jobId,
            clipIndex: index,
            startSec: newStart,
            endSec: newEnd,
          }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "Failed to apply edit");

        const returnedIndex = typeof data.clipIndex === "number" ? data.clipIndex : index;
        if (returnedIndex !== index) {
          console.error(`[Clip Debug] INDEX MISMATCH! Requested clipIndex=${index} but got clipIndex=${returnedIndex}`);
        }
        console.log(`[Clip Debug] Applying response to clipIndex=${index}, returned clipUrl=${data.clipUrl}`);

        setResult((prev) => {
          if (!prev) return prev;
          const updated = prev.clips.map((c, i) =>
            i === index
              ? {
                  ...c,
                  clipUrl: data.clipUrl ?? c.clipUrl,
                  srtUrl: data.srtUrl ?? c.srtUrl,
                  startSec: typeof data.startSec === "number" ? data.startSec : newStart,
                  endSec: typeof data.endSec === "number" ? data.endSec : newEnd,
                }
              : c
          );
          return { ...prev, clips: updated };
        });
        showClipSuccess(index, "Clip updated");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Edit failed";
        setClipError({ index, message: msg });
        console.error(`[Clip Action] Error for clip ${index}:`, err);
      } finally {
        setClipEditLoadingIndex(null);
      }
    },
    [result, isEditLoading, showClipSuccess]
  );

  const handleUndo = useCallback(
    async (index: number) => {
      if (!result || isEditLoading(index)) return;
      const prev = previousClipState[index];
      if (!prev || !result.jobId) return;

      setClipError(null);
      setClipEditLoadingIndex(index);
      console.log(`[Clip Debug] Requesting undo for clipIndex=${index}, start=${prev.startSec}, end=${prev.endSec}`);

      setResult((r) =>
        r ? { ...r, clips: r.clips.map((c, i) => (i === index ? { ...prev } : c)) } : r
      );

      try {
        const res = await fetch("/api/clip/regenerate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobId: result.jobId,
            clipIndex: index,
            startSec: prev.startSec,
            endSec: prev.endSec,
          }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "Failed to undo");

        const returnedIndex = typeof data.clipIndex === "number" ? data.clipIndex : index;
        if (returnedIndex !== index) {
          console.error(`[Clip Debug] INDEX MISMATCH on undo! Requested clipIndex=${index} but got clipIndex=${returnedIndex}`);
        }
        console.log(`[Clip Debug] Applying undo response to clipIndex=${index}, returned clipUrl=${data.clipUrl}`);

        setResult((r) => {
          if (!r) return r;
          const updated = r.clips.map((c, i) =>
            i === index
              ? {
                  ...prev,
                  clipUrl: data.clipUrl ?? c.clipUrl,
                  srtUrl: data.srtUrl ?? c.srtUrl,
                }
              : c
          );
          return { ...r, clips: updated };
        });
        setPreviousClipState((p) => {
          const copy = { ...p };
          delete copy[index];
          return copy;
        });
        showClipSuccess(index, "Change undone");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Undo failed";
        setClipError({ index, message: msg });
      } finally {
        setClipEditLoadingIndex(null);
      }
    },
    [result, isEditLoading, previousClipState, showClipSuccess]
  );

  const handleResetToOriginal = useCallback(
    async (index: number) => {
      if (!result || isEditLoading(index)) return;
      const orig = originalClips[index];
      if (!orig || !result.jobId) return;

      setClipError(null);
      setClipEditLoadingIndex(index);
      console.log(`[Clip Debug] Requesting reset-to-original for clipIndex=${index}, start=${orig.startSec}, end=${orig.endSec}`);

      const currentClip = result.clips[index];
      if (currentClip) {
        setPreviousClipState((p) => ({ ...p, [index]: { ...currentClip } }));
      }

      setResult((r) =>
        r ? { ...r, clips: r.clips.map((c, i) => (i === index ? { ...orig } : c)) } : r
      );

      try {
        const res = await fetch("/api/clip/regenerate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobId: result.jobId,
            clipIndex: index,
            startSec: orig.startSec,
            endSec: orig.endSec,
          }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "Failed to reset");

        const returnedIndex = typeof data.clipIndex === "number" ? data.clipIndex : index;
        if (returnedIndex !== index) {
          console.error(`[Clip Debug] INDEX MISMATCH on reset! Requested clipIndex=${index} but got clipIndex=${returnedIndex}`);
        }
        console.log(`[Clip Debug] Applying reset response to clipIndex=${index}, returned clipUrl=${data.clipUrl}`);

        setResult((r) => {
          if (!r) return r;
          const updated = r.clips.map((c, i) =>
            i === index
              ? {
                  ...orig,
                  clipUrl: data.clipUrl ?? c.clipUrl,
                  srtUrl: data.srtUrl ?? c.srtUrl,
                }
              : c
          );
          return { ...r, clips: updated };
        });
        showClipSuccess(index, "Restored to original");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Reset failed";
        setClipError({ index, message: msg });
      } finally {
        setClipEditLoadingIndex(null);
      }
    },
    [result, isEditLoading, originalClips, showClipSuccess]
  );

  const findAnotherRemaining = FREE_FIND_ANOTHER_LIMIT - findAnotherUsed;
  const isFindAnotherLimitReached = plan === "free" && findAnotherRemaining <= 0;

  const handleFindAnother = useCallback(async (index: number) => {
    if (!result || isFindAnotherLoading(index)) return;
    if (plan === "free" && findAnotherUsed >= FREE_FIND_ANOTHER_LIMIT) return;
    const clip = result.clips[index];
    if (!clip || !result.jobId) return;

    setPreviousClipState((prev) => ({ ...prev, [index]: { ...clip } }));
    setPreviousFindAnotherClip((prev) => ({ ...prev, [index]: { ...clip } }));

    setClipError(null);
    setClipFindAnotherLoadingIndex(index);

    const allClipRanges = result.clips.map((c) => ({
      startSec: c.startSec,
      endSec: c.endSec,
    }));
    const seenForSlot = seenClipHistory[index] ?? [];
    console.log(`[Clip Debug] Seen history for clipIndex=${index}:`, seenForSlot);
    console.log(`[Clip Debug] Sending seen history exclusions for clipIndex=${index}: ${seenForSlot.length} seen + ${allClipRanges.length} active`);

    try {
      const res = await fetch("/api/clip/alternative", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: result.jobId,
          clipIndex: index,
          platform,
          goal,
          currentStartSec: clip.startSec,
          currentEndSec: clip.endSec,
          allClipRanges,
          seenRanges: seenForSlot,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to find another clip");
      }

      const returnedIndex = typeof data.clipIndex === "number" ? data.clipIndex : index;
      if (returnedIndex !== index) {
        console.error(`[Clip Debug] INDEX MISMATCH on alternative! Requested clipIndex=${index} but got clipIndex=${returnedIndex}`);
      }
      console.log(`[Clip Debug] Applying alternative response to clipIndex=${index}, returned clipUrl=${data.clipUrl}`);

      setResult((prev) => {
        if (!prev) return prev;
        const updated = prev.clips.map((c, i) =>
          i === index
            ? {
                ...c,
                clipUrl: data.clipUrl ?? c.clipUrl,
                srtUrl: data.srtUrl ?? c.srtUrl,
                startSec:
                  typeof data.startSec === "number" ? data.startSec : c.startSec,
                endSec:
                  typeof data.endSec === "number" ? data.endSec : c.endSec,
                hook: typeof data.hook === "string" ? data.hook : c.hook,
                confidence:
                  typeof data.confidence === "number"
                    ? data.confidence
                    : c.confidence,
              }
            : c
        );
        return { ...prev, clips: updated };
      });
      const newStart = typeof data.startSec === "number" ? data.startSec : clip.startSec;
      const newEnd = typeof data.endSec === "number" ? data.endSec : clip.endSec;
      setSeenClipHistory((prev) => {
        const existing = prev[index] ?? [];
        const alreadyTracked = existing.some(
          (r) => r.startSec === newStart && r.endSec === newEnd
        );
        if (alreadyTracked) return prev;
        return { ...prev, [index]: [...existing, { startSec: newStart, endSec: newEnd }] };
      });
      if (plan === "free") {
        setFindAnotherUsed((prev) => prev + 1);
      }
      showClipSuccess(index, "New clip loaded");
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to find another clip";
      setClipError({ index, message: msg });
      console.error(`[Clip Debug] Alternative error for clipIndex=${index}:`, err);
    } finally {
      setClipFindAnotherLoadingIndex(null);
    }
  }, [result, isFindAnotherLoading, platform, goal, plan, findAnotherUsed, seenClipHistory, showClipSuccess]);

  const handleBackToPrevious = useCallback(
    async (index: number) => {
      if (!result || isEditLoading(index) || isFindAnotherLoading(index)) return;
      const prev = previousFindAnotherClip[index];
      if (!prev || !result.jobId) return;

      setClipError(null);
      setClipEditLoadingIndex(index);

      try {
        const res = await fetch("/api/clip/regenerate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobId: result.jobId,
            clipIndex: index,
            startSec: prev.startSec,
            endSec: prev.endSec,
          }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "Failed to restore");

        setResult((r) => {
          if (!r) return r;
          const updated = r.clips.map((c, i) =>
            i === index
              ? {
                  ...prev,
                  clipUrl: data.clipUrl ?? c.clipUrl,
                  srtUrl: data.srtUrl ?? c.srtUrl,
                }
              : c
          );
          return { ...r, clips: updated };
        });
        setPreviousFindAnotherClip((p) => {
          const copy = { ...p };
          delete copy[index];
          return copy;
        });
        showClipSuccess(index, "Previous clip restored");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Restore failed";
        setClipError({ index, message: msg });
      } finally {
        setClipEditLoadingIndex(null);
      }
    },
    [result, isEditLoading, isFindAnotherLoading, previousFindAnotherClip, showClipSuccess]
  );

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
    let cancelled = false;
    let idx = 0;
    setStatusIdx(0);
    setStatus(STATUS_STEPS[0]);

    const advance = () => {
      if (cancelled) return;
      const delay = STEP_DELAYS[idx] ?? 5000;
      setTimeout(() => {
        if (cancelled) return;
        idx++;
        if (idx < STATUS_STEPS.length - 1) {
          setStatusIdx(idx);
          setStatus(STATUS_STEPS[idx]);
          advance();
        }
      }, delay);
    };
    advance();

    return () => { cancelled = true; };
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
      const origMap: Record<number, ClipResult> = {};
      const initialHistory: Record<number, { startSec: number; endSec: number }[]> = {};
      data.clips.forEach((c: ClipResult, idx: number) => {
        origMap[idx] = { ...c };
        initialHistory[idx] = [{ startSec: c.startSec, endSec: c.endSec }];
      });
      setOriginalClips(origMap);
      setPreviousClipState({});
      setFindAnotherUsed(0);
      setPreviousFindAnotherClip({});
      setSeenClipHistory(initialHistory);
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
          Clipify
        </h1>
        <p className="text-gray-400 text-lg">
          Turn long videos into shareable clips
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
              <p className="text-xs text-gray-500 mt-4">
                This may take a moment, especially for longer videos.
              </p>
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
                setOpenEditClipIndex(null);
                setClipEditLoadingIndex(null);
                setClipFindAnotherLoadingIndex(null);
                setClipSuccess(null);
                setClipError(null);
                setOriginalClips({});
                setPreviousClipState({});
                if (successTimeoutRef.current) {
                  clearTimeout(successTimeoutRef.current);
                  successTimeoutRef.current = null;
                }
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
                  key={clip.clipUrl}
                  controls
                  preload="metadata"
                  className="w-full max-h-[480px] rounded-lg bg-black"
                  onLoadedData={() => {
                    console.log(
                      `[Clip Action] Video refreshed for clip ${i}`
                    );
                  }}
                >
                  <source src={clip.clipUrl} type="video/mp4" />
                </video>

                {/* Success feedback */}
                {clipSuccess?.index === i && (
                  <div className="mt-3 text-sm text-green-400 font-medium animate-pulse">
                    {clipSuccess.message}
                  </div>
                )}
                {clipError?.index === i && (
                  <div className="mt-3 text-sm text-red-400 font-medium">
                    {clipError.message}
                  </div>
                )}

                {/* Action buttons */}
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <a
                    href={clip.clipUrl}
                    download={`clipify_${i + 1}.mp4`}
                    className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    Download Clip
                  </a>
                  <a
                    href={clip.srtUrl}
                    download={`clipify_${i + 1}.srt`}
                    className="inline-flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    Download Captions (.srt)
                  </a>
                  <button
                    type="button"
                    onClick={() => setOpenEditClipIndex(openEditClipIndex === i ? null : i)}
                    className="inline-flex items-center gap-1.5 text-gray-200 bg-gray-800 hover:bg-gray-700 hover:text-white border border-gray-600 hover:border-gray-500 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
                  >
                    Edit Clip
                  </button>
                  <button
                    type="button"
                    disabled={isFindAnotherLoading(i) || isFindAnotherLimitReached}
                    onClick={() => handleFindAnother(i)}
                    className="inline-flex items-center gap-1.5 text-gray-200 bg-gray-800 hover:bg-gray-700 hover:text-white border border-gray-600 hover:border-gray-500 px-3 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-gray-800 disabled:hover:text-gray-200"
                  >
                    {isFindAnotherLoading(i) ? (
                      <>
                        <span className="inline-block w-3.5 h-3.5 border-2 border-gray-500 border-t-gray-300 rounded-full animate-spin" />
                        Finding another clip...
                      </>
                    ) : plan === "free" ? (
                      `Find Another Clip (${findAnotherRemaining} left)`
                    ) : (
                      "Find Another Clip"
                    )}
                  </button>
                  {previousFindAnotherClip[i] && (
                    <button
                      type="button"
                      disabled={isEditLoading(i) || isFindAnotherLoading(i)}
                      onClick={() => handleBackToPrevious(i)}
                      className="inline-flex items-center gap-1.5 text-gray-300 hover:text-white border border-gray-600 hover:border-gray-500 px-3 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isEditLoading(i) ? (
                        <>
                          <span className="inline-block w-3.5 h-3.5 border-2 border-gray-500 border-t-gray-300 rounded-full animate-spin" />
                          Restoring...
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v2M3 10l4-4m-4 4l4 4" />
                          </svg>
                          Back to Previous Clip
                        </>
                      )}
                    </button>
                  )}
                </div>

                {/* Find Another Clip limit message */}
                {isFindAnotherLimitReached && (
                  <div className="mt-2 text-xs text-gray-500">
                    You&apos;ve used all {FREE_FIND_ANOTHER_LIMIT} free re-picks for this video.{" "}
                    <button
                      type="button"
                      onClick={() => setPlan("pro")}
                      className="text-purple-400 hover:text-purple-300 underline underline-offset-2"
                    >
                      Upgrade to Pro
                    </button>{" "}
                    for unlimited alternatives.
                  </div>
                )}

                {/* Edit Clip expandable panel */}
                {openEditClipIndex === i && (
                  <div className="mt-3 p-4 bg-gray-950 border border-gray-800 rounded-lg space-y-3">
                    {isEditLoading(i) && (
                      <div className="flex items-center gap-2 text-xs text-gray-400">
                        <span className="inline-block w-3.5 h-3.5 border-2 border-gray-600 border-t-gray-300 rounded-full animate-spin" />
                        Applying edit...
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {(
                        [
                          "start-earlier",
                          "start-later",
                          "end-earlier",
                          "end-later",
                          "shorter",
                          "longer",
                        ] as EditKind[]
                      ).map((kind) => (
                        <button
                          key={kind}
                          type="button"
                          disabled={isEditLoading(i)}
                          onClick={() => handleEditAction(i, kind)}
                          className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded text-xs font-medium transition-colors"
                        >
                          {EDIT_LABELS[kind]}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-2 pt-1 border-t border-gray-800">
                      <button
                        type="button"
                        disabled={isEditLoading(i) || !previousClipState[i]}
                        onClick={() => handleUndo(i)}
                        className="text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed border border-gray-700 hover:border-gray-500 px-3 py-1.5 rounded text-xs font-medium transition-colors"
                      >
                        Undo Last Change
                      </button>
                      <button
                        type="button"
                        disabled={isEditLoading(i) || !originalClips[i]}
                        onClick={() => handleResetToOriginal(i)}
                        className="text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed border border-gray-700 hover:border-gray-500 px-3 py-1.5 rounded text-xs font-medium transition-colors"
                      >
                        Reset to Original
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
