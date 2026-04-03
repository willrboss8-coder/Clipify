"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type DragEvent,
  type MutableRefObject,
} from "react";
import { useUser, UserButton, useAuth, useClerk } from "@clerk/nextjs";
import {
  PLAN_LIMITS,
  PRO_POSITIONING,
  POWER_POSITIONING,
} from "@/lib/plans";
import type { ViralCaptionAccess } from "@/lib/viral-captions";
import type { ClipResult, ProcessResponse } from "@/lib/types/clip-job";
import {
  MAX_PROCESSING_WINDOW_SEC,
  type LongVideoSegment,
} from "@/lib/scan-window";
import {
  trimLocalVideoToSegment,
  shouldAttemptClientTrim,
} from "@/lib/client-trim-segment";

type Platform = "tiktok" | "reels" | "shorts";
type Goal = "growth" | "monetize";
type Plan = "free" | "pro" | "power";

const PLATFORM_LABELS: Record<Platform, string> = {
  tiktok: "TikTok",
  reels: "Instagram Reels",
  shorts: "YouTube Shorts",
};

const GOAL_LABELS: Record<Goal, string> = {
  growth: "Growth",
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

/**
 * Approximate remaining seconds when a pipeline step becomes active (midpoints of the
 * former static ranges). Resets when `statusIdx` advances.
 */
const STEP_ESTIMATE_REMAINING_SEC: Record<number, number> = {
  0: 55,
  1: 55,
  2: 67,
  3: 37,
  4: 32,
  5: 17,
};

function getPipelineStepEstimateSeconds(statusIdx: number): number {
  return STEP_ESTIMATE_REMAINING_SEC[statusIdx] ?? 60;
}

/** Lightweight approximate countdown for the processing card (bottom-right). */
function ProcessingEtaCountdown({ statusIdx }: { statusIdx: number }) {
  const [display, setDisplay] = useState<
    { kind: "sec"; n: number } | { kind: "overrun" }
  >(() => ({
    kind: "sec",
    n: getPipelineStepEstimateSeconds(
      statusIdx >= 0 ? statusIdx : 1
    ),
  }));

  useEffect(() => {
    if (statusIdx < 0) return;
    if (statusIdx >= STATUS_STEPS.length - 1) return;

    const est = getPipelineStepEstimateSeconds(statusIdx);
    const endAt = Date.now() + est * 1000;

    const tick = () => {
      const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      if (left <= 0) {
        setDisplay({ kind: "overrun" });
      } else {
        setDisplay({ kind: "sec", n: left });
      }
    };

    tick();
    const id = window.setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [statusIdx]);

  if (statusIdx < 0) {
    return <>Usually about 1–2 min</>;
  }
  if (statusIdx >= STATUS_STEPS.length - 1) {
    return <>Almost done</>;
  }
  if (display.kind === "overrun") {
    return <>Almost there...</>;
  }
  return <>~{display.n} sec left</>;
}

function getRecommendation(
  _platform: Platform,
  goal: Goal
): { minLen: number; maxLen: number; count: number } {
  if (goal === "growth") return { minLen: 30, maxLen: 45, count: 5 };
  return { minLen: 60, maxLen: 90, count: 3 };
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Remaining plan minutes as shown in “first N minutes” copy */
function formatPlanMinutesForCopy(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0";
  if (minutes >= 10) return String(Math.round(minutes));
  if (minutes >= 1) return String(Math.round(minutes * 10) / 10);
  return minutes.toFixed(1);
}

const SESSION_EXPIRED_COPY =
  "Your session expired. Please sign in again.";

/** Client-side E2E timing (Generate Clip); anchor `t0` is first log in the flow. */
function logUiE2e(
  phase: string,
  t0: number,
  jobId?: string
): void {
  const elapsedMs = Date.now() - t0;
  if (jobId) {
    console.log(
      `[UI E2E] jobId=${jobId} phase=${phase} elapsedMs=${elapsedMs}`
    );
  } else {
    console.log(`[UI E2E] phase=${phase} elapsedMs=${elapsedMs}`);
  }
}

interface UploadProgressState {
  loaded: number;
  total: number;
  percent: number;
  etaSec: number | null;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fileKeyFromFile(f: File): string {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

/**
 * Multipart POST with upload progress (fetch has no upload progress on request body).
 */
function postMultipartWithUploadProgress(
  url: string,
  formData: FormData,
  opts: {
    onProgress: (p: UploadProgressState) => void;
    uploadStartMsRef: MutableRefObject<number>;
  }
): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        if (opts.uploadStartMsRef.current === 0) {
          opts.uploadStartMsRef.current = Date.now();
        }
        const loaded = e.loaded;
        const total = e.total;
        const percent = Math.min(100, Math.round((loaded / total) * 100));
        const elapsedSec = (Date.now() - opts.uploadStartMsRef.current) / 1000;
        const rate = elapsedSec > 0 && loaded > 0 ? loaded / elapsedSec : 0;
        const etaSec =
          rate > 0 && total > loaded
            ? Math.max(0, Math.round((total - loaded) / rate))
            : null;
        opts.onProgress({ loaded, total, percent, etaSec });
      } else {
        opts.onProgress({
          loaded: e.loaded,
          total: 0,
          percent: 0,
          etaSec: null,
        });
      }
    };
    xhr.onload = () => {
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        body: xhr.responseText,
      });
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    xhr.send(formData);
  });
}

/**
 * PUT file to a presigned R2 URL (cross-origin; do not send cookies).
 * Progress events mirror multipart upload.
 */
function putFileToPresignedUrlWithProgress(
  uploadUrl: string,
  file: File,
  contentType: string,
  opts: {
    onProgress: (p: UploadProgressState) => void;
    uploadStartMsRef: MutableRefObject<number>;
    /** When set, caller can abort() to cancel (e.g. preflight invalidation). */
    xhrRefForAbort?: MutableRefObject<XMLHttpRequest | null>;
  }
): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (opts.xhrRefForAbort) opts.xhrRefForAbort.current = xhr;
    xhr.open("PUT", uploadUrl);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        if (opts.uploadStartMsRef.current === 0) {
          opts.uploadStartMsRef.current = Date.now();
        }
        const loaded = e.loaded;
        const total = e.total;
        const percent = Math.min(100, Math.round((loaded / total) * 100));
        const elapsedSec = (Date.now() - opts.uploadStartMsRef.current) / 1000;
        const rate = elapsedSec > 0 && loaded > 0 ? loaded / elapsedSec : 0;
        const etaSec =
          rate > 0 && total > loaded
            ? Math.max(0, Math.round((total - loaded) / rate))
            : null;
        opts.onProgress({ loaded, total, percent, etaSec });
      } else {
        opts.onProgress({
          loaded: e.loaded,
          total: file.size,
          percent: 0,
          etaSec: null,
        });
      }
    };
    xhr.onload = () => {
      if (opts.xhrRefForAbort) opts.xhrRefForAbort.current = null;
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        body: xhr.responseText,
      });
    };
    xhr.onerror = () => {
      if (opts.xhrRefForAbort) opts.xhrRefForAbort.current = null;
      reject(new Error("Network error"));
    };
    xhr.onabort = () => {
      if (opts.xhrRefForAbort) opts.xhrRefForAbort.current = null;
      reject(new Error("Upload aborted"));
    };
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.send(file);
  });
}

/** Poll background job until completed or failed (long videos; HTTP request no longer blocks). */
const JOB_POLL_INTERVAL_MS = 2500;
const JOB_POLL_MAX_MS = 2 * 60 * 60 * 1000;

async function pollJobUntilComplete(
  jobId: string,
  uiE2eT0: number
): Promise<ProcessResponse> {
  logUiE2e("polling_started", uiE2eT0, jobId);
  const deadline = Date.now() + JOB_POLL_MAX_MS;
  while (Date.now() < deadline) {
    const r = await fetch(`/api/jobs/${jobId}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (r.status === 401) {
      throw new Error(SESSION_EXPIRED_COPY);
    }
    if (!r.ok) {
      const t = await r.text();
      throw new Error(
        t.trim().slice(0, 300) || "Failed to load job status"
      );
    }
    const data = (await r.json()) as {
      status: string;
      result?: ProcessResponse;
      error?: string;
    };
    if (data.status === "completed" && data.result) {
      logUiE2e("first_completed_status_seen", uiE2eT0, jobId);
      return data.result;
    }
    if (data.status === "failed") {
      throw new Error(data.error || "Processing failed");
    }
    if (data.status === "awaiting_upload") {
      await new Promise((res) => setTimeout(res, JOB_POLL_INTERVAL_MS));
      continue;
    }
    await new Promise((res) => setTimeout(res, JOB_POLL_INTERVAL_MS));
  }
  throw new Error(
    "Processing is taking longer than expected. Try a shorter video or try again later."
  );
}

/**
 * Clerk can refresh an expired JWT on GET, not on POST (`session-token-expired-refresh-non-eligible-non-get`).
 * Force a fresh token, then hit a lightweight GET so cookies/session are valid before POST /api/process/init and upload steps.
 */
function messageForFailedProcessResponse(
  res: Response,
  raw: string,
  parseErr?: boolean
): string {
  if (res.status === 504 || res.status === 408) {
    return "Processing timed out (the server stopped waiting). Try a shorter video, or try again — the service may be busy.";
  }
  if (res.status === 502 || res.status === 503) {
    return "Service temporarily unavailable. Try again in a moment.";
  }
  if (res.status === 413) {
    return "Upload too large for the server. Try a smaller file or a lower resolution export.";
  }
  if (parseErr || !raw.trim()) {
    return raw.trim().startsWith("<")
      ? "Server returned an error page instead of results. Try again, or contact support if this keeps happening."
      : "Could not read the server response. Try again.";
  }
  return "Processing failed. Try again.";
}

async function refreshClerkSessionForUpload(
  getToken: (opts?: { skipCache?: boolean }) => Promise<string | null>
): Promise<boolean> {
  try {
    await getToken({ skipCache: true });
  } catch {
    /* GET ping may still recover */
  }
  try {
    const ping = await fetch("/api/usage", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
    });
    return ping.ok;
  } catch {
    return false;
  }
}

export default function HomePage() {
  const { user, isLoaded } = useUser();
  const { isLoaded: authLoaded, isSignedIn, getToken } = useAuth();
  const { redirectToSignIn } = useClerk();
  const rawPlan = user?.publicMetadata?.plan as string | undefined;
  const plan: Plan = rawPlan === "power" ? "power" : rawPlan === "pro" ? "pro" : "free";

  const [file, setFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState<Platform>("tiktok");
  const [goal, setGoal] = useState<Goal>("growth");
  const [status, setStatus] = useState<string | null>(null);
  const [statusIdx, setStatusIdx] = useState(-1);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState | null>(
    null
  );
  const [isCreatingJob, setIsCreatingJob] = useState(false);
  const uploadStartMsRef = useRef(0);
  /** Background preflight work (init + presign + optional R2 PUT); disables Generate while true. */
  const [preflightUploadActive, setPreflightUploadActive] = useState(false);
  /** After preflight finishes (R2 bytes in bucket or multipart job ready); cleared on Generate/invalidate. */
  const [preflightReadyHint, setPreflightReadyHint] = useState(false);
  /** Preflight ended without success (so we can enable a muted retry without blocking on hint). */
  const [preflightTerminalFailed, setPreflightTerminalFailed] = useState(false);
  const preflightRunIdRef = useRef(0);
  const preflightPutXhrRef = useRef<XMLHttpRequest | null>(null);
  const preflightPutPromiseRef = useRef<Promise<void> | null>(null);
  type PreflightSnapshot =
    | { kind: "none" }
    | {
        kind: "running";
        jobId: string;
        platform: Platform;
        goal: Goal;
        fileKey: string;
        contentType: string;
      }
    | {
        kind: "r2_put_done";
        jobId: string;
        platform: Platform;
        goal: Goal;
        fileKey: string;
        contentType: string;
      }
    | {
        kind: "multipart_only";
        jobId: string;
        platform: Platform;
        goal: Goal;
        fileKey: string;
      }
    | { kind: "error" };
  const preflightSnapshotRef = useRef<PreflightSnapshot>({ kind: "none" });
  /** Prevents duplicate handleGenerate calls (e.g. auto-start + Strict Mode / double effect). */
  const generationInFlightRef = useRef(false);
  const handleGenerateRef = useRef<() => Promise<void>>(async () => {});
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
  const [usage, setUsage] = useState<{
    minutesUsed: number;
    minutesLimit: number;
    minutesRemaining: number;
    plan: string;
  } | null>(null);
  const [viralAccess, setViralAccess] = useState<ViralCaptionAccess | null>(null);
  const [viralLoadingIndex, setViralLoadingIndex] = useState<number | null>(null);
  /** Client-side duration from file metadata (for pre-check vs plan minutes) */
  const [videoDurationSec, setVideoDurationSec] = useState<number | null>(null);
  /** Required when source is longer than {@link MAX_PROCESSING_WINDOW_SEC} (server scans one window). */
  const [longVideoSegment, setLongVideoSegment] = useState<LongVideoSegment | null>(
    null
  );
  /** Set after client-side ffmpeg trim for long videos (smaller upload). */
  const [clientTrimmedFile, setClientTrimmedFile] = useState<File | null>(null);
  const [clientTrimBusy, setClientTrimBusy] = useState(false);
  /** FFmpeg-reported 0–1 while trimming; null before first progress tick. */
  const [clientTrimProgress, setClientTrimProgress] = useState<number | null>(
    null
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Incremented when the user taps "Upload Video" so preflight only runs after an explicit action. */
  const [uploadTrigger, setUploadTrigger] = useState(0);

  useEffect(() => {
    fetch("/api/usage", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (!data.error) setUsage(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!file) {
      setVideoDurationSec(null);
      setLongVideoSegment(null);
      return;
    }
    setLongVideoSegment(null);
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    let cancelled = false;
    const onMeta = () => {
      if (cancelled) return;
      const d = video.duration;
      setVideoDurationSec(Number.isFinite(d) && d > 0 ? d : null);
    };
    video.onloadedmetadata = onMeta;
    video.onerror = () => {
      if (!cancelled) setVideoDurationSec(null);
    };
    video.src = url;
    return () => {
      cancelled = true;
      video.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [file]);

  useEffect(() => {
    setUploadTrigger(0);
  }, [file]);

  useEffect(() => {
    setClientTrimmedFile(null);
    setClientTrimProgress(null);
  }, [file, longVideoSegment]);

  const fileForUpload =
    file != null ? (clientTrimmedFile ?? file) : null;

  /** Background init + R2 PUT only (no upload-complete) so upload overlaps user choices. */
  useEffect(() => {
    const durationReady =
      videoDurationSec != null && videoDurationSec > 0;
    const isLong =
      durationReady && videoDurationSec > MAX_PROCESSING_WINDOW_SEC;
    const segmentOk = !isLong || longVideoSegment != null;
    const uploadPrereqsMet = durationReady && segmentOk;

    if (
      !file ||
      !fileForUpload ||
      !isSignedIn ||
      !authLoaded ||
      uploadTrigger === 0 ||
      !uploadPrereqsMet
    ) {
      preflightRunIdRef.current += 1;
      preflightPutXhrRef.current?.abort();
      preflightPutXhrRef.current = null;
      preflightPutPromiseRef.current = null;
      preflightSnapshotRef.current = { kind: "none" };
      setPreflightUploadActive(false);
      setPreflightReadyHint(false);
      setPreflightTerminalFailed(false);
      setUploadProgress(null);
      return;
    }

    const myId = ++preflightRunIdRef.current;

    void (async () => {
      const sessionOk = await refreshClerkSessionForUpload(getToken);
      if (!sessionOk || preflightRunIdRef.current !== myId) return;

      setPreflightReadyHint(false);
      setPreflightTerminalFailed(false);
      setPreflightUploadActive(true);

      const postInit = () =>
        fetch("/api/process/init", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform, goal }),
        });

      let initRes = await postInit();
      if (initRes.status === 401) {
        const ok = await refreshClerkSessionForUpload(getToken);
        if (ok) initRes = await postInit();
      }
      if (preflightRunIdRef.current !== myId) {
        setPreflightUploadActive(false);
        return;
      }
      if (initRes.status === 401) {
        preflightSnapshotRef.current = { kind: "error" };
        setPreflightTerminalFailed(true);
        setPreflightUploadActive(false);
        return;
      }

      const initRaw = await initRes.text();
      let initParsed: Record<string, unknown>;
      try {
        initParsed = JSON.parse(initRaw) as Record<string, unknown>;
      } catch {
        preflightSnapshotRef.current = { kind: "error" };
        setPreflightTerminalFailed(true);
        setPreflightUploadActive(false);
        return;
      }
      if (!initRes.ok || initRes.status !== 202) {
        preflightSnapshotRef.current = { kind: "error" };
        setPreflightTerminalFailed(true);
        setPreflightUploadActive(false);
        return;
      }
      const jobId =
        typeof initParsed.jobId === "string" ? initParsed.jobId : "";
      if (!jobId) {
        preflightSnapshotRef.current = { kind: "error" };
        setPreflightTerminalFailed(true);
        setPreflightUploadActive(false);
        return;
      }

      const postUploadUrl = () =>
        fetch("/api/process/upload-url", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId }),
        });

      let urlRes: Response;
      try {
        urlRes = await postUploadUrl();
      } catch {
        urlRes = new Response(
          JSON.stringify({ error: "network" }),
          { status: 503 }
        );
      }
      if (urlRes.status === 401) {
        const ok = await refreshClerkSessionForUpload(getToken);
        if (ok) {
          try {
            urlRes = await postUploadUrl();
          } catch {
            urlRes = new Response(
              JSON.stringify({ error: "network" }),
              { status: 503 }
            );
          }
        }
      }
      if (preflightRunIdRef.current !== myId) {
        setPreflightUploadActive(false);
        return;
      }
      if (urlRes.status === 401) {
        preflightSnapshotRef.current = { kind: "error" };
        setPreflightTerminalFailed(true);
        setPreflightUploadActive(false);
        return;
      }

      const urlText = await urlRes.text();
      let r2UploadUrl: string | null = null;
      let r2ContentType = "video/mp4";
      if (urlRes.ok && urlRes.status === 200) {
        try {
          const urlParsed = JSON.parse(urlText) as Record<string, unknown>;
          if (
            typeof urlParsed.uploadUrl === "string" &&
            urlParsed.uploadUrl.length > 0
          ) {
            r2UploadUrl = urlParsed.uploadUrl;
            if (typeof urlParsed.contentType === "string") {
              r2ContentType = urlParsed.contentType;
            }
          }
        } catch {
          /* no presigned URL */
        }
      }

      if (r2UploadUrl == null) {
        if (
          urlRes.status === 400 ||
          urlRes.status === 404 ||
          urlRes.status === 409
        ) {
          preflightSnapshotRef.current = { kind: "error" };
          setPreflightTerminalFailed(true);
          setPreflightUploadActive(false);
          return;
        }
        preflightSnapshotRef.current = {
          kind: "multipart_only",
          jobId,
          platform,
          goal,
          fileKey: fileKeyFromFile(fileForUpload),
        };
        preflightPutPromiseRef.current = null;
        setPreflightUploadActive(false);
        setPreflightReadyHint(true);
        return;
      }

      const fk = fileKeyFromFile(fileForUpload);
      preflightSnapshotRef.current = {
        kind: "running",
        jobId,
        platform,
        goal,
        fileKey: fk,
        contentType: r2ContentType,
      };

      let putResolve: (() => void) | undefined;
      const putDone = new Promise<void>((r) => {
        putResolve = r;
      });
      preflightPutPromiseRef.current = putDone;

      uploadStartMsRef.current = 0;
      setUploadProgress({
        loaded: 0,
        total: fileForUpload.size,
        percent: 0,
        etaSec: null,
      });

      try {
        const putRes = await putFileToPresignedUrlWithProgress(
          r2UploadUrl,
          fileForUpload,
          r2ContentType,
          {
            onProgress: (p) => setUploadProgress(p),
            uploadStartMsRef,
            xhrRefForAbort: preflightPutXhrRef,
          }
        );
        if (preflightRunIdRef.current !== myId) return;
        if (!putRes.ok) {
          preflightSnapshotRef.current = { kind: "error" };
          setPreflightTerminalFailed(true);
          return;
        }
        preflightSnapshotRef.current = {
          kind: "r2_put_done",
          jobId,
          platform,
          goal,
          fileKey: fk,
          contentType: r2ContentType,
        };
        setPreflightReadyHint(true);
      } catch (e: unknown) {
        if (preflightRunIdRef.current !== myId) return;
        const msg = e instanceof Error ? e.message : "";
        if (msg === "Upload aborted") {
          preflightSnapshotRef.current = { kind: "none" };
          setPreflightTerminalFailed(false);
        } else {
          preflightSnapshotRef.current = { kind: "error" };
          setPreflightTerminalFailed(true);
        }
      } finally {
        putResolve?.();
        setPreflightUploadActive(false);
        if (preflightRunIdRef.current === myId) {
          setUploadProgress(null);
        }
      }
    })();

    return () => {
      preflightRunIdRef.current += 1;
      preflightPutXhrRef.current?.abort();
      preflightPutXhrRef.current = null;
      preflightPutPromiseRef.current = null;
      preflightSnapshotRef.current = { kind: "none" };
      setPreflightUploadActive(false);
      setPreflightReadyHint(false);
      setPreflightTerminalFailed(false);
      setUploadProgress(null);
    };
  }, [
    file,
    fileForUpload,
    platform,
    goal,
    isSignedIn,
    authLoaded,
    getToken,
    uploadTrigger,
    videoDurationSec,
    longVideoSegment,
    clientTrimmedFile,
  ]);

  /** After Stripe redirects back, Clerk session may still have old `publicMetadata` until reload */
  useEffect(() => {
    if (!isLoaded || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("upgraded") !== "true") return;
    if (!user) return;

    let cancelled = false;
    void (async () => {
      try {
        await user.reload();
        if (cancelled) return;
        const r = await fetch("/api/usage", { credentials: "include" });
        const data = await r.json();
        if (!data.error) setUsage(data);
        window.history.replaceState({}, "", window.location.pathname);
      } catch {
        /* ignore */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, user]);

  useEffect(() => {
    if (!result) {
      setViralAccess(null);
      return;
    }
    fetch("/api/viral-captions", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data.access) setViralAccess(data.access);
      })
      .catch(() => {});
  }, [result]);

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
          credentials: "include",
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
          credentials: "include",
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
          credentials: "include",
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
        credentials: "include",
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
          credentials: "include",
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

  const handleViralCaptions = useCallback(
    async (index: number) => {
      if (!result) return;
      const clip = result.clips[index];
      if (!clip) return;
      setClipError(null);
      setViralLoadingIndex(index);
      try {
        const clipUrlBase = clip.clipUrl.split("?")[0];
        const res = await fetch("/api/viral-captions", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clipUrl: clipUrlBase }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Viral captions failed");
        setResult((prev) => {
          if (!prev) return prev;
          const clips = prev.clips.map((c, i) =>
            i === index ? { ...c, clipUrl: data.clipUrl as string } : c
          );
          return { ...prev, clips };
        });
        if (data.accessAfter === "exhausted") setViralAccess("exhausted");
        showClipSuccess(index, "Viral captions applied — use Download Clip for the new MP4");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed";
        setClipError({ index, message: msg });
      } finally {
        setViralLoadingIndex(null);
      }
    },
    [result, showClipSuccess]
  );

  const rec = getRecommendation(platform, goal);

  const videoDurationMin =
    videoDurationSec != null && videoDurationSec > 0
      ? videoDurationSec / 60
      : null;
  const durationReady =
    videoDurationSec != null && videoDurationSec > 0;
  const isLongVideo =
    durationReady && videoDurationSec > MAX_PROCESSING_WINDOW_SEC;
  const longVideoSegmentOk = !isLongVideo || longVideoSegment != null;
  const uploadPrereqsMet = durationReady && longVideoSegmentOk;
  const showPartialScanWarning =
    usage != null &&
    usage.minutesRemaining > 0 &&
    videoDurationMin != null &&
    videoDurationMin > usage.minutesRemaining;
  const minutesExhausted = usage != null && usage.minutesRemaining <= 0;

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

  /** Abort in-flight preflight (same invalidation pattern as changing file); clears selection so the user can pick another video. */
  const cancelPreflightUpload = useCallback(() => {
    preflightRunIdRef.current += 1;
    preflightPutXhrRef.current?.abort();
    preflightPutXhrRef.current = null;
    preflightPutPromiseRef.current = null;
    preflightSnapshotRef.current = { kind: "none" };
    setPreflightUploadActive(false);
    setPreflightReadyHint(false);
    setPreflightTerminalFailed(false);
    setUploadProgress(null);
    setUploadTrigger(0);
    setFile(null);
    setClientTrimmedFile(null);
    setClientTrimProgress(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const handleUploadVideoClick = useCallback(async () => {
    if (!file || !authLoaded || !isSignedIn) return;
    const durationReady =
      videoDurationSec != null && videoDurationSec > 0;
    const isLong =
      durationReady && videoDurationSec > MAX_PROCESSING_WINDOW_SEC;
    if (!durationReady) return;
    if (isLong && !longVideoSegment) return;
    if (usage != null && usage.minutesRemaining <= 0) return;
    if (preflightTerminalFailed) {
      preflightRunIdRef.current += 1;
      preflightPutXhrRef.current?.abort();
      preflightPutXhrRef.current = null;
      preflightPutPromiseRef.current = null;
      preflightSnapshotRef.current = { kind: "none" };
      setPreflightUploadActive(false);
      setPreflightReadyHint(false);
      setPreflightTerminalFailed(false);
      setUploadProgress(null);
    }
    if (!isLong) {
      setClientTrimmedFile(null);
    } else if (
      longVideoSegment &&
      videoDurationSec != null &&
      shouldAttemptClientTrim(file, isLong)
    ) {
      setClientTrimProgress(null);
      setClientTrimBusy(true);
      try {
        const blob = await trimLocalVideoToSegment({
          file,
          segment: longVideoSegment,
          originalDurationSec: videoDurationSec,
          onProgress: (ratio) => {
            setClientTrimProgress(
              Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0))
            );
          },
        });
        setClientTrimmedFile(
          new File([blob], file.name, { type: "video/mp4" })
        );
      } catch (e) {
        console.warn("Client trim failed; uploading full file instead", e);
        setClientTrimmedFile(null);
      } finally {
        setClientTrimBusy(false);
        setClientTrimProgress(null);
      }
    } else {
      setClientTrimmedFile(null);
    }
    setUploadTrigger((n) => n + 1);
  }, [
    file,
    authLoaded,
    isSignedIn,
    usage,
    preflightTerminalFailed,
    videoDurationSec,
    longVideoSegment,
  ]);

  /** Simulated backend steps. Use `startStepIndex = 1` after file upload so we don&apos;t show &quot;Uploading video&quot; again. */
  const simulateProgress = (startStepIndex = 0) => {
    let cancelled = false;
    let idx = startStepIndex;
    setStatusIdx(startStepIndex);
    setStatus(STATUS_STEPS[startStepIndex]);

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

    return () => {
      cancelled = true;
    };
  };

  const handleUpgrade = async (tier: "pro" | "power" = "pro") => {
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        console.error("Checkout error:", data.error);
      }
    } catch (err) {
      console.error("Upgrade error:", err);
    }
  };

  const handleGenerate = async () => {
    if (!file) return;
    if (!authLoaded) {
      setError("Loading your account — try again in a moment.");
      return;
    }
    if (!isSignedIn) {
      setError("Please sign in to generate clips.");
      redirectToSignIn({ redirectUrl: window.location.href });
      return;
    }
    if (usage != null && usage.minutesRemaining <= 0) {
      setError(
        "You've used all your minutes this month. Upgrade for more capacity, or wait until your usage resets next month."
      );
      return;
    }
    if (!durationReady) {
      setError(
        "Still reading video length — wait a moment, or try another file."
      );
      return;
    }
    if (isLongVideo && !longVideoSegment) {
      setError(
        "Choose Beginning, Middle, or End to process a 60-minute section of your video."
      );
      return;
    }
    if (generationInFlightRef.current) return;

    setError(null);
    setResult(null);
    setStatus(null);
    setStatusIdx(-1);

    const uiE2eT0 = Date.now();
    logUiE2e("generate_click", uiE2eT0);

    generationInFlightRef.current = true;
    try {
      let sessionOk = await refreshClerkSessionForUpload(getToken);
      if (!sessionOk) {
        setError(SESSION_EXPIRED_COPY);
        redirectToSignIn({ redirectUrl: window.location.href });
        return;
      }

      let cancelSimulate: (() => void) | null = null;
      try {
        setIsCreatingJob(true);
        setStatus(null);
        setStatusIdx(-1);
        setUploadProgress(null);

        const uploadForJob = (clientTrimmedFile ?? file) as File;
        const fileKey = fileKeyFromFile(uploadForJob);
        const snap0 = preflightSnapshotRef.current;
        const fastR2 =
          (snap0.kind === "r2_put_done" || snap0.kind === "running") &&
          snap0.fileKey === fileKey &&
          snap0.platform === platform &&
          snap0.goal === goal;

        const fastMultipart =
          snap0.kind === "multipart_only" &&
          snap0.fileKey === fileKey &&
          snap0.platform === platform &&
          snap0.goal === goal;

        if (!fastR2 && !fastMultipart) {
          preflightRunIdRef.current += 1;
          preflightPutXhrRef.current?.abort();
          preflightPutXhrRef.current = null;
          preflightPutPromiseRef.current = null;
          preflightSnapshotRef.current = { kind: "none" };
          setPreflightUploadActive(false);
          setPreflightReadyHint(false);
          setPreflightTerminalFailed(false);
        }

        const uploadCompletePayload = (jid: string) => {
          const base: Record<string, unknown> =
            isLongVideo && longVideoSegment
              ? { jobId: jid, longVideoSegment }
              : { jobId: jid };
          if (clientTrimmedFile) {
            base.clientPretrimmedSegment = true;
            base.originalDurationSec = videoDurationSec;
          }
          return base;
        };

        const finalizeUploadResponse = async (
          raw: string,
          status: number,
          expectedJobId: string
        ): Promise<boolean> => {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            const fauxRes = new Response(raw, { status });
            setUploadProgress(null);
            throw new Error(
              messageForFailedProcessResponse(fauxRes, raw, true)
            );
          }

          const errText =
            typeof parsed.error === "string" ? parsed.error : "";

          /** Duplicate upload-complete / multipart after job already left awaiting_upload */
          if (status === 409) {
            if (
              /not waiting for upload|wrong status|upload already completed/i.test(
                errText
              )
            ) {
              const r = await fetch(`/api/jobs/${expectedJobId}`, {
                credentials: "include",
                cache: "no-store",
              });
              if (r.status === 401) {
                setUploadProgress(null);
                setError(SESSION_EXPIRED_COPY);
                redirectToSignIn({ redirectUrl: window.location.href });
                return false;
              }
              if (!r.ok) {
                const t = await r.text();
                setUploadProgress(null);
                throw new Error(
                  t.trim().slice(0, 300) || errText || "Upload step failed."
                );
              }
              const jr = (await r.json()) as {
                status?: string;
                error?: string;
              };
              const st = jr.status;
              if (
                st === "queued" ||
                st === "processing" ||
                st === "completed"
              ) {
                setUploadProgress(null);
                preflightSnapshotRef.current = { kind: "none" };
                setPreflightReadyHint(false);
                setPreflightTerminalFailed(false);
                logUiE2e("upload_response_received", uiE2eT0, expectedJobId);
                logUiE2e("upload_idempotent_recover", uiE2eT0, expectedJobId);
                return true;
              }
              if (st === "failed") {
                setUploadProgress(null);
                throw new Error(jr.error || "Processing failed");
              }
              setUploadProgress(null);
              throw new Error(errText || "Upload step failed.");
            }
          }

          const ok = status >= 200 && status < 300;
          if (!ok) {
            setUploadProgress(null);
            const fauxRes = new Response(raw, { status });
            if (status === 401 || /unauthorized/i.test(errText)) {
              setError(SESSION_EXPIRED_COPY);
              redirectToSignIn({ redirectUrl: window.location.href });
              return false;
            }
            if (
              status === 400 &&
              parsed.longVideoSegmentRequired === true
            ) {
              setError(
                errText ||
                  "Video is longer than 60 minutes. Choose Beginning, Middle, or End to process one 60-minute section."
              );
              return false;
            }
            throw new Error(
              errText || messageForFailedProcessResponse(fauxRes, raw)
            );
          }

          if (status !== 202) {
            setUploadProgress(null);
            throw new Error(
              "Unexpected response from server. Try again or update the app."
            );
          }

          const uploadJobId =
            typeof parsed.jobId === "string" ? parsed.jobId : "";
          if (!uploadJobId || uploadJobId !== expectedJobId) {
            setUploadProgress(null);
            throw new Error("Server did not return a consistent job id.");
          }

          setUploadProgress(null);
          preflightSnapshotRef.current = { kind: "none" };
          setPreflightReadyHint(false);
          setPreflightTerminalFailed(false);
          logUiE2e("upload_response_received", uiE2eT0, expectedJobId);
          return true;
        };

        let jobIdForPoll: string;

        if (fastR2) {
          const jobId =
            snap0.kind === "running" || snap0.kind === "r2_put_done"
              ? snap0.jobId
              : "";
          if (!jobId) {
            throw new Error("Preflight job id missing.");
          }
          if (preflightPutPromiseRef.current) {
            await preflightPutPromiseRef.current;
          }
          setIsCreatingJob(false);
          logUiE2e("preflight_reused", uiE2eT0, jobId);

          const postUploadComplete = () =>
            fetch("/api/process/upload-complete", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(uploadCompletePayload(jobId)),
            });

          let completeRes = await postUploadComplete();
          if (completeRes.status === 401) {
            sessionOk = await refreshClerkSessionForUpload(getToken);
            if (sessionOk) {
              completeRes = await postUploadComplete();
            }
          }
          if (completeRes.status === 401) {
            setUploadProgress(null);
            setError(SESSION_EXPIRED_COPY);
            redirectToSignIn({ redirectUrl: window.location.href });
            return;
          }

          const completeRaw = await completeRes.text();
          if (!(await finalizeUploadResponse(completeRaw, completeRes.status, jobId))) {
            return;
          }
          jobIdForPoll = jobId;
        } else if (fastMultipart) {
          const jobId =
            snap0.kind === "multipart_only" ? snap0.jobId : "";
          if (!jobId) {
            throw new Error("Preflight job id missing.");
          }
          setIsCreatingJob(false);
          logUiE2e("preflight_reused_multipart", uiE2eT0, jobId);

          const buildUploadForm = () => {
            const form = new FormData();
            form.append("file", uploadForJob);
            form.append("jobId", jobId);
            if (isLongVideo && longVideoSegment) {
              form.append("longVideoSegment", longVideoSegment);
            }
            if (clientTrimmedFile && videoDurationSec != null) {
              form.append("clientPretrimmedSegment", "true");
              form.append("originalDurationSec", String(videoDurationSec));
            }
            return form;
          };

          uploadStartMsRef.current = 0;
          setUploadProgress({
            loaded: 0,
            total: uploadForJob.size,
            percent: 0,
            etaSec: null,
          });

          logUiE2e("upload_request_started", uiE2eT0, jobId);

          const runUpload = () =>
            postMultipartWithUploadProgress(
              "/api/process/upload",
              buildUploadForm(),
              {
                onProgress: (p) => setUploadProgress(p),
                uploadStartMsRef,
              }
            );

          let xhrRes = await runUpload();
          if (xhrRes.status === 401) {
            sessionOk = await refreshClerkSessionForUpload(getToken);
            if (sessionOk) {
              uploadStartMsRef.current = 0;
              setUploadProgress({
                loaded: 0,
                total: uploadForJob.size,
                percent: 0,
                etaSec: null,
              });
              xhrRes = await runUpload();
            }
          }
          if (xhrRes.status === 401) {
            setUploadProgress(null);
            setError(SESSION_EXPIRED_COPY);
            redirectToSignIn({ redirectUrl: window.location.href });
            return;
          }

          if (!(await finalizeUploadResponse(xhrRes.body, xhrRes.status, jobId))) {
            return;
          }
          jobIdForPoll = jobId;
        } else {
        const postInit = () =>
          fetch("/api/process/init", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ platform, goal }),
          });

        let initRes = await postInit();
        if (initRes.status === 401) {
          sessionOk = await refreshClerkSessionForUpload(getToken);
          if (sessionOk) {
            initRes = await postInit();
          }
        }
        if (initRes.status === 401) {
          setIsCreatingJob(false);
          setError(SESSION_EXPIRED_COPY);
          redirectToSignIn({ redirectUrl: window.location.href });
          return;
        }

        const initRaw = await initRes.text();
        let initParsed: Record<string, unknown>;
        try {
          initParsed = JSON.parse(initRaw) as Record<string, unknown>;
        } catch {
          throw new Error(
            messageForFailedProcessResponse(initRes, initRaw, true)
          );
        }

        if (!initRes.ok) {
          setIsCreatingJob(false);
          const errText =
            typeof initParsed.error === "string" && initParsed.error
              ? initParsed.error
              : messageForFailedProcessResponse(initRes, initRaw);
          if (initRes.status === 401 || /unauthorized/i.test(errText)) {
            setError(SESSION_EXPIRED_COPY);
            redirectToSignIn({ redirectUrl: window.location.href });
            return;
          }
          throw new Error(errText);
        }

        if (initRes.status !== 202) {
          setIsCreatingJob(false);
          throw new Error(
            "Unexpected response from server. Try again or update the app."
          );
        }

        const jobId =
          typeof initParsed.jobId === "string" ? initParsed.jobId : "";
        if (!jobId) {
          setIsCreatingJob(false);
          throw new Error("Server did not return a job id.");
        }

        setIsCreatingJob(false);
        logUiE2e("init_response_received", uiE2eT0, jobId);

        const buildUploadForm = () => {
          const form = new FormData();
          form.append("file", uploadForJob);
          form.append("jobId", jobId);
          if (isLongVideo && longVideoSegment) {
            form.append("longVideoSegment", longVideoSegment);
          }
          if (clientTrimmedFile && videoDurationSec != null) {
            form.append("clientPretrimmedSegment", "true");
            form.append("originalDurationSec", String(videoDurationSec));
          }
          return form;
        };

        const postUploadUrl = () =>
          fetch("/api/process/upload-url", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobId }),
          });

        let urlRes: Response;
        try {
          urlRes = await postUploadUrl();
        } catch {
          urlRes = new Response(
            JSON.stringify({
              error:
                "Could not reach server for direct upload. Falling back to app upload.",
            }),
            { status: 503 }
          );
        }
        if (urlRes.status === 401) {
          sessionOk = await refreshClerkSessionForUpload(getToken);
          if (sessionOk) {
            try {
              urlRes = await postUploadUrl();
            } catch {
              urlRes = new Response(
                JSON.stringify({
                  error:
                    "Could not reach server for direct upload. Falling back to app upload.",
                }),
                { status: 503 }
              );
            }
          }
        }
        if (urlRes.status === 401) {
          setUploadProgress(null);
          setError(SESSION_EXPIRED_COPY);
          redirectToSignIn({ redirectUrl: window.location.href });
          return;
        }

        const urlText = await urlRes.text();
        let r2UploadUrl: string | null = null;
        let r2ContentType = "video/mp4";
        if (urlRes.ok && urlRes.status === 200) {
          try {
            const urlParsed = JSON.parse(urlText) as Record<string, unknown>;
            if (
              typeof urlParsed.uploadUrl === "string" &&
              urlParsed.uploadUrl.length > 0
            ) {
              r2UploadUrl = urlParsed.uploadUrl;
              if (typeof urlParsed.contentType === "string") {
                r2ContentType = urlParsed.contentType;
              }
            }
          } catch {
            /* no presigned URL */
          }
        }

        if (r2UploadUrl == null) {
          if (
            urlRes.status === 400 ||
            urlRes.status === 404 ||
            urlRes.status === 409
          ) {
            setUploadProgress(null);
            const fauxRes = new Response(urlText, { status: urlRes.status });
            let parsedErr: Record<string, unknown>;
            try {
              parsedErr = JSON.parse(urlText) as Record<string, unknown>;
            } catch {
              throw new Error(
                messageForFailedProcessResponse(fauxRes, urlText, true)
              );
            }
            const errText =
              typeof parsedErr.error === "string" && parsedErr.error
                ? parsedErr.error
                : messageForFailedProcessResponse(fauxRes, urlText);
            if (/unauthorized/i.test(errText)) {
              setError(SESSION_EXPIRED_COPY);
              redirectToSignIn({ redirectUrl: window.location.href });
              return;
            }
            throw new Error(errText);
          }
          logUiE2e("upload_multipart_fallback", uiE2eT0, jobId);
        }

        if (r2UploadUrl != null) {
          logUiE2e("r2_presign_received", uiE2eT0, jobId);
          uploadStartMsRef.current = 0;
          setUploadProgress({
            loaded: 0,
            total: uploadForJob.size,
            percent: 0,
            etaSec: null,
          });
          logUiE2e("upload_request_started", uiE2eT0, jobId);

          let putRes = await putFileToPresignedUrlWithProgress(
            r2UploadUrl,
            uploadForJob,
            r2ContentType,
            {
              onProgress: (p) => setUploadProgress(p),
              uploadStartMsRef,
            }
          );

          if (!putRes.ok) {
            setUploadProgress(null);
            const fauxPut = new Response(putRes.body, {
              status: putRes.status,
            });
            const errMsg =
              putRes.body.trim() ||
              messageForFailedProcessResponse(fauxPut, putRes.body);
            throw new Error(
              errMsg || "Upload to storage failed. Try again."
            );
          }

          logUiE2e("r2_put_finished", uiE2eT0, jobId);

          const postUploadComplete = () =>
            fetch("/api/process/upload-complete", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(uploadCompletePayload(jobId)),
            });

          let completeRes = await postUploadComplete();
          if (completeRes.status === 401) {
            sessionOk = await refreshClerkSessionForUpload(getToken);
            if (sessionOk) {
              completeRes = await postUploadComplete();
            }
          }
          if (completeRes.status === 401) {
            setUploadProgress(null);
            setError(SESSION_EXPIRED_COPY);
            redirectToSignIn({ redirectUrl: window.location.href });
            return;
          }

          const completeRaw = await completeRes.text();
          if (!(await finalizeUploadResponse(completeRaw, completeRes.status, jobId))) {
            return;
          }
        } else {
          uploadStartMsRef.current = 0;
          setUploadProgress({
            loaded: 0,
            total: uploadForJob.size,
            percent: 0,
            etaSec: null,
          });

          logUiE2e("upload_request_started", uiE2eT0, jobId);

          const runUpload = () =>
            postMultipartWithUploadProgress(
              "/api/process/upload",
              buildUploadForm(),
              {
                onProgress: (p) => setUploadProgress(p),
                uploadStartMsRef,
              }
            );

          let xhrRes = await runUpload();
          if (xhrRes.status === 401) {
            sessionOk = await refreshClerkSessionForUpload(getToken);
            if (sessionOk) {
              uploadStartMsRef.current = 0;
              setUploadProgress({
                loaded: 0,
                total: uploadForJob.size,
                percent: 0,
                etaSec: null,
              });
              xhrRes = await runUpload();
            }
          }
          if (xhrRes.status === 401) {
            setUploadProgress(null);
            setError(SESSION_EXPIRED_COPY);
            redirectToSignIn({ redirectUrl: window.location.href });
            return;
          }

          if (!(await finalizeUploadResponse(xhrRes.body, xhrRes.status, jobId))) {
            return;
          }
        }

        jobIdForPoll = jobId;
        }

        cancelSimulate = simulateProgress(1);

        const data = await pollJobUntilComplete(jobIdForPoll, uiE2eT0);

        if (
          typeof data.jobId !== "string" ||
          !data.jobId ||
          !Array.isArray(data.clips)
        ) {
          throw new Error(
            "Invalid result from server (missing job or clips). Try again or contact support."
          );
        }

        setResult(data);
        if (data.usage) {
          setUsage({
            minutesUsed: data.usage.minutesUsed,
            minutesLimit: data.usage.minutesLimit,
            minutesRemaining: data.usage.minutesRemaining,
            plan,
          });
        }
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
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            logUiE2e("result_rendered", uiE2eT0, data.jobId);
          });
        });
      } finally {
        cancelSimulate?.();
        setUploadProgress(null);
        setIsCreatingJob(false);
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : err instanceof TypeError && err.message.includes("fetch")
            ? "Network error — check your connection and try again."
            : "Something went wrong while finishing processing. Try again.";
      setError(msg);
      // Keep status/steps visible so users see where the run failed (e.g. stuck on "Finalizing results").
    } finally {
      generationInFlightRef.current = false;
    }
  };

  handleGenerateRef.current = handleGenerate;

  /** After preflight succeeds, start the same generate flow as the primary button (no extra click). */
  useEffect(() => {
    if (!preflightReadyHint || preflightUploadActive) return;
    if (!file || result) return;
    if (!authLoaded || !isSignedIn) return;
    if (usage != null && usage.minutesRemaining <= 0) return;
    if (preflightTerminalFailed) return;
    if (error) return;
    if (!uploadPrereqsMet) return;
    if (generationInFlightRef.current || isCreatingJob) return;

    void handleGenerateRef.current();
  }, [
    preflightReadyHint,
    preflightUploadActive,
    file,
    result,
    authLoaded,
    isSignedIn,
    usage,
    preflightTerminalFailed,
    error,
    isCreatingJob,
    uploadPrereqsMet,
  ]);

  const isProcessing =
    !error &&
    (isCreatingJob ||
      preflightUploadActive ||
      (uploadProgress !== null && !preflightUploadActive) ||
      (statusIdx >= 0 && statusIdx < STATUS_STEPS.length - 1));

  /** User tapped Upload Video; waiting for preflight to begin or finish (narrow gap before `preflightUploadActive`). */
  const mustWaitForPreflightGate =
    !!file &&
    isSignedIn &&
    authLoaded &&
    uploadTrigger > 0 &&
    !preflightReadyHint &&
    !preflightUploadActive &&
    !preflightTerminalFailed;

  const generateDisabled =
    !file ||
    isProcessing ||
    clientTrimBusy ||
    (usage != null && usage.minutesRemaining <= 0) ||
    mustWaitForPreflightGate ||
    (file && !isSignedIn) ||
    (file && !authLoaded) ||
    (file && !uploadPrereqsMet);

  /** Brief idle state after preflight before auto-start runs — keep CTA muted (no misleading primary). */
  const autoClipStartPending =
    preflightReadyHint &&
    !preflightUploadActive &&
    !error &&
    !isProcessing;

  const showPrimaryUploadCta =
    !!file &&
    isSignedIn &&
    authLoaded &&
    (usage == null || usage.minutesRemaining > 0) &&
    !preflightUploadActive &&
    !preflightReadyHint &&
    !isProcessing &&
    !error &&
    (uploadTrigger === 0 || preflightTerminalFailed);

  const showPrimaryGenerateCta =
    !generateDisabled &&
    preflightReadyHint &&
    !preflightTerminalFailed &&
    !error &&
    !autoClipStartPending;

  /** Bright retry after a failed auto-generation (upload already succeeded). */
  const showPrimaryGenRetryCta =
    !generateDisabled &&
    preflightReadyHint &&
    !preflightTerminalFailed &&
    !!error &&
    !isProcessing;

  const showPrimaryCta =
    showPrimaryUploadCta ||
    showPrimaryGenerateCta ||
    showPrimaryGenRetryCta;

  const uploadPhaseButtonLabel =
    uploadTrigger > 0 &&
    !preflightReadyHint &&
    !preflightTerminalFailed &&
    (preflightUploadActive || mustWaitForPreflightGate);

  let generateButtonLabel = "Upload Video";
  if (!file) {
    generateButtonLabel = "Choose a video first";
  } else if (!authLoaded) {
    generateButtonLabel = "Loading account...";
  } else if (!isSignedIn) {
    generateButtonLabel = "Sign in to generate";
  } else if (usage != null && usage.minutesRemaining <= 0) {
    generateButtonLabel = "No minutes remaining";
  } else if (file && !durationReady) {
    generateButtonLabel = "Reading video…";
  } else if (isLongVideo && !longVideoSegment) {
    generateButtonLabel = "Choose a 60-minute section";
  } else if (clientTrimBusy) {
    generateButtonLabel =
      clientTrimProgress != null && clientTrimProgress > 0.02
        ? "Trimming 60-minute section…"
        : "Preparing selected section…";
  } else if (uploadPhaseButtonLabel) {
    generateButtonLabel = "Uploading video...";
  } else if (isProcessing) {
    if (preflightUploadActive) {
      generateButtonLabel = uploadProgress
        ? "Uploading video..."
        : "Preparing video...";
    } else if (uploadProgress) {
      generateButtonLabel = "Uploading...";
    } else if (isCreatingJob) {
      generateButtonLabel = preflightReadyHint
        ? "Generating clips..."
        : "Preparing...";
    } else {
      generateButtonLabel = "Processing...";
    }
  } else if (preflightReadyHint && error && !isProcessing) {
    generateButtonLabel = "Generate Clips";
  } else if (
    preflightReadyHint &&
    !preflightUploadActive &&
    !error
  ) {
    generateButtonLabel = "Starting clip generation…";
  } else if (preflightTerminalFailed) {
    generateButtonLabel = "Upload Video";
  }

  return (
    <div className="min-h-screen">
      {/* ─── Navigation ─── */}
      <nav className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold text-white tracking-tight">Clipify</span>
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            plan === "power"
              ? "bg-amber-600/20 text-amber-400 border border-amber-500/30"
              : plan === "pro"
                ? "bg-purple-600/20 text-purple-400 border border-purple-500/30"
                : "bg-gray-800 text-gray-400 border border-gray-700"
          }`}>
            {plan === "power" ? "Power" : plan === "pro" ? "Pro" : "Free"}
          </span>
          {plan !== "power" && (
            <button
              type="button"
              onClick={() => handleUpgrade(plan === "free" ? "pro" : "power")}
              title={
                plan === "free"
                  ? `${PRO_POSITIONING.tagline}. ${PRO_POSITIONING.valuePitch}`
                  : `${POWER_POSITIONING.tagline}. ${POWER_POSITIONING.valuePitch}`
              }
              className="text-xs text-purple-400 hover:text-purple-300"
            >
              {plan === "free" ? "Upgrade to Pro" : "Upgrade to Power"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-4">
          {usage && (
            <div className="flex items-center gap-2 text-xs">
              <div className="w-20 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    usage.minutesUsed / usage.minutesLimit > 0.9
                      ? "bg-red-500"
                      : usage.minutesUsed / usage.minutesLimit > 0.7
                        ? "bg-yellow-500"
                        : "bg-purple-500"
                  }`}
                  style={{
                    width: `${Math.min(100, (usage.minutesUsed / usage.minutesLimit) * 100)}%`,
                  }}
                />
              </div>
              <span className="text-gray-400">
                {Math.round(usage.minutesRemaining)} min left
              </span>
            </div>
          )}
          <UserButton afterSignOutUrl="/sign-in" />
        </div>
      </nav>

      {result ? (
        /* ═══════════════════════════════════════════
           RESULTS VIEW — unchanged from existing UI
           ═══════════════════════════════════════════ */
        <div className="max-w-3xl mx-auto px-4 py-8">
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

            {result.scanInfo?.partialScan && (
              <div className="bg-amber-900/25 border border-amber-700/50 rounded-xl p-4 text-amber-100/90 text-sm leading-relaxed">
                This run scanned only the first{" "}
                {formatPlanMinutesForCopy(result.scanInfo.minutesScanned)} minutes of your
                video (your plan&apos;s remaining time). Upgrade to scan full-length uploads.
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

                  <div className="bg-gray-950 rounded-lg p-3 mb-4">
                    <div className="text-xs text-gray-500 mb-1 uppercase tracking-wider">
                      Suggested Hook
                    </div>
                    <div className="text-gray-200 text-sm italic">
                      &ldquo;{clip.hook}&rdquo;
                    </div>
                  </div>

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

                  <div className="mt-4 pt-4 border-t border-gray-800/80">
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                      Viral captions
                    </div>
                    {viralAccess === null && (
                      <p className="text-xs text-gray-600">Checking access…</p>
                    )}
                    {viralAccess === "none" && (
                      <p className="text-sm text-gray-400 leading-relaxed">
                        Premium viral-style captions (burned into your MP4) are on{" "}
                        <button
                          type="button"
                          onClick={() => handleUpgrade("pro")}
                          className="text-purple-400 hover:text-purple-300 underline underline-offset-2 font-medium"
                        >
                          Pro
                        </button>{" "}
                        (1 trial) and{" "}
                        <button
                          type="button"
                          onClick={() => handleUpgrade("power")}
                          className="text-amber-400/90 hover:text-amber-300 underline underline-offset-2 font-medium"
                        >
                          Power
                        </button>{" "}
                        (full access).
                      </p>
                    )}
                    {viralAccess === "trial" && (
                      <div className="space-y-2">
                        <p className="text-xs text-purple-200/85">
                          Pro: 1 trial — burns one premium caption style into this clip&apos;s MP4.
                        </p>
                        <button
                          type="button"
                          disabled={viralLoadingIndex === i}
                          onClick={() => handleViralCaptions(i)}
                          className="inline-flex items-center gap-2 bg-amber-600/25 hover:bg-amber-600/35 border border-amber-500/45 text-amber-100 px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {viralLoadingIndex === i ? (
                            <>
                              <span className="inline-block w-3.5 h-3.5 border-2 border-amber-500 border-t-amber-200 rounded-full animate-spin" />
                              Applying…
                            </>
                          ) : (
                            "Apply viral captions"
                          )}
                        </button>
                        <p className="text-[11px] text-gray-600 leading-snug">
                          Export is a new MP4 with captions baked in (requires ffmpeg with libass on the server). Your .srt download still works anytime.
                        </p>
                      </div>
                    )}
                    {viralAccess === "full" && (
                      <div className="space-y-2">
                        <p className="text-xs text-amber-200/85">
                          Power: full access — unlimited viral caption burns for this workspace.
                        </p>
                        <button
                          type="button"
                          disabled={viralLoadingIndex === i}
                          onClick={() => handleViralCaptions(i)}
                          className="inline-flex items-center gap-2 bg-amber-600/25 hover:bg-amber-600/35 border border-amber-500/45 text-amber-100 px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {viralLoadingIndex === i ? (
                            <>
                              <span className="inline-block w-3.5 h-3.5 border-2 border-amber-500 border-t-amber-200 rounded-full animate-spin" />
                              Applying…
                            </>
                          ) : (
                            "Apply viral captions"
                          )}
                        </button>
                        <p className="text-[11px] text-gray-600 leading-snug">
                          Export is a new MP4 with captions baked in (requires ffmpeg with libass on the server). Your .srt download still works anytime.
                        </p>
                      </div>
                    )}
                    {viralAccess === "exhausted" && (
                      <p className="text-sm text-gray-400 leading-relaxed">
                        You&apos;ve used your Pro trial for viral captions.{" "}
                        <button
                          type="button"
                          onClick={() => handleUpgrade("power")}
                          className="text-amber-400/90 hover:text-amber-300 underline underline-offset-2 font-medium"
                        >
                          Upgrade to Power
                        </button>{" "}
                        for unlimited burns.
                      </p>
                    )}
                  </div>

                  {isFindAnotherLimitReached && (
                    <div className="mt-2 text-xs text-gray-500 space-y-1.5 max-w-xl">
                      <p>
                        You&apos;ve used all {FREE_FIND_ANOTHER_LIMIT} free re-picks for this video.
                      </p>
                      <p className="text-gray-400 leading-relaxed">
                        {PRO_POSITIONING.coreIdea}{" "}
                        <span className="text-gray-300">{PRO_POSITIONING.tagline}</span>
                        {" — "}
                        {PRO_POSITIONING.valuePitch}{" "}
                        <button
                          type="button"
                          onClick={() => handleUpgrade("pro")}
                          className="text-purple-400 hover:text-purple-300 underline underline-offset-2 font-medium"
                        >
                          Upgrade to Pro
                        </button>{" "}
                        for more freedom to explore alternative clips and more
                        room to find better alternatives on every job.
                      </p>
                    </div>
                  )}

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
        </div>
      ) : (
        /* ═══════════════════════════════════════════
           HOMEPAGE — marketing + upload
           ═══════════════════════════════════════════ */
        <>
          {/* ── SECTION 1: HERO ── */}
          <section className="pt-16 pb-20">
            <div className="max-w-3xl mx-auto px-4 text-center">
              <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-6">
                Turn podcasts and interviews into clips that{" "}
                <span className="gradient-text">actually grow your audience</span>
              </h1>
              <p className="text-lg text-gray-400 max-w-2xl mx-auto mb-12">
                Upload a podcast episode or interview. Clipify finds the strongest
                moments, suggests hooks, and gives you short clips ready for
                TikTok, Reels, and Shorts.
              </p>

              {/* Upload + Settings */}
              <div className="max-w-2xl mx-auto space-y-6 text-left">
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
                        {(file.size / 1024 / 1024).toFixed(1)} MB
                        {videoDurationSec != null && (
                          <> — {fmtTime(videoDurationSec)}</>
                        )}{" "}
                        — click to change
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="text-4xl mb-3">🎙️</div>
                      <div className="text-gray-400 text-lg mb-1">
                        Drop a podcast episode or video here
                      </div>
                      <div className="text-gray-600 text-sm">
                        or click to browse — MP4, MOV, M4V
                      </div>
                    </div>
                  )}
                </div>

                {/* Platform, goal, plan + recommended clip settings (single card) */}
                <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-4 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
                      <p className="text-[11px] sm:text-xs text-gray-500 mt-2 leading-snug">
                        {goal === "growth"
                          ? "30–45s clips for faster social growth."
                          : "60–90s clips for deeper, monetizable content."}
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm text-gray-400 mb-1.5">
                        Plan
                      </label>
                      <div className="flex items-center gap-3 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5">
                        <span className={`text-sm font-medium ${
                          plan === "power"
                            ? "text-amber-400"
                            : plan === "pro"
                              ? "text-purple-400"
                              : "text-gray-300"
                        }`}>
                          {plan === "power" ? "Power" : plan === "pro" ? "Pro" : "Free"}
                        </span>
                        {usage && (
                          <span className="text-xs text-gray-500">
                            {Math.round(usage.minutesUsed)}/{usage.minutesLimit} min
                          </span>
                        )}
                        {plan !== "power" && (
                          <button
                            type="button"
                            onClick={() => handleUpgrade(plan === "free" ? "pro" : "power")}
                            title={
                              plan === "free"
                                ? `${PRO_POSITIONING.tagline}. ${PRO_POSITIONING.valuePitch}`
                                : `${POWER_POSITIONING.tagline}. ${POWER_POSITIONING.valuePitch}`
                            }
                            className="ml-auto text-xs text-purple-400 hover:text-purple-300 underline underline-offset-2"
                          >
                            {plan === "free" ? "Upgrade to Pro" : "Upgrade to Power"}
                          </button>
                        )}
                      </div>
                      {plan === "free" && (
                        <p className="text-xs text-gray-600 mt-2 leading-relaxed">
                          <span className="text-gray-500">{PRO_POSITIONING.tagline}.</span>{" "}
                          Pro is for consistent posting — not just more minutes, but a real weekly workflow with freedom to refine clips.
                        </p>
                      )}
                    </div>
                  </div>

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

                {file && minutesExhausted && (
                  <div className="bg-red-900/25 border border-red-800/60 rounded-xl p-4 text-sm text-red-200/95 leading-relaxed">
                    <p className="font-medium text-red-100 mb-1">
                      You&apos;ve used all your minutes this month.
                    </p>
                    <p className="text-red-200/90 mb-3">
                      Upgrade to keep generating clips, or wait until your usage resets.
                    </p>
                    {plan !== "power" && (
                      <button
                        type="button"
                        onClick={() => handleUpgrade(plan === "free" ? "pro" : "power")}
                        className="text-sm font-semibold text-purple-300 hover:text-purple-200 underline underline-offset-2"
                      >
                        {plan === "free" ? "Upgrade to Pro" : "Upgrade to Power"}
                      </button>
                    )}
                  </div>
                )}

                {file && durationReady && isLongVideo && (
                  <div className="bg-sky-900/20 border border-sky-700/50 rounded-xl p-4 text-sm text-sky-100/90 leading-relaxed">
                    <p className="font-medium text-sky-100 mb-2">
                      This video is longer than the recommended 60-minute processing limit.
                    </p>
                    <p className="mb-3 text-sky-100/85">
                      We&apos;ll scan one 60-minute section for clips so processing stays fast and
                      reliable. Choose which part of the video to use:
                    </p>
                    <div className="flex flex-col sm:flex-row gap-2">
                      {(
                        [
                          ["beginning", "Beginning"],
                          ["middle", "Middle"],
                          ["end", "End"],
                        ] as const
                      ).map(([seg, label]) => (
                        <button
                          key={seg}
                          type="button"
                          onClick={() => setLongVideoSegment(seg)}
                          className={`flex-1 py-2.5 px-3 rounded-lg text-sm font-medium transition-colors border ${
                            longVideoSegment === seg
                              ? "bg-sky-600/50 border-sky-400 text-white"
                              : "bg-gray-900/80 border-gray-600 text-gray-200 hover:border-sky-500/50"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {file && showPartialScanWarning && usage && (
                  <div className="bg-amber-900/20 border border-amber-700/45 rounded-xl p-4 text-sm text-amber-100/90 leading-relaxed">
                    <p className="font-medium text-amber-100 mb-2">
                      This video is longer than the minutes remaining on your current plan.
                    </p>
                    <p className="mb-2">
                      We&apos;ll scan only the first{" "}
                      {formatPlanMinutesForCopy(usage.minutesRemaining)} minutes for viral
                      clips.
                    </p>
                    <p className="text-amber-200/80 mb-3">
                      Upgrade to scan the full video.
                    </p>
                    {plan !== "power" && (
                      <button
                        type="button"
                        onClick={() => handleUpgrade(plan === "free" ? "pro" : "power")}
                        className="text-sm font-semibold text-purple-300 hover:text-purple-200 underline underline-offset-2"
                      >
                        {plan === "free" ? "Upgrade to Pro" : "Upgrade to Power"}
                      </button>
                    )}
                  </div>
                )}

                {/* Upload / generate CTA */}
                <button
                  type="button"
                  onClick={() => {
                    if (preflightReadyHint && error && !isProcessing) {
                      void handleGenerate();
                      return;
                    }
                    if (!preflightReadyHint || preflightTerminalFailed) {
                      void handleUploadVideoClick();
                      return;
                    }
                    void handleGenerate();
                  }}
                  disabled={generateDisabled}
                  aria-busy={clientTrimBusy}
                  className={`w-full py-4 rounded-xl font-semibold text-lg transition-all border ${
                    showPrimaryCta || clientTrimBusy
                      ? "bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white shadow-lg shadow-purple-500/20 border-transparent"
                      : "bg-gray-800/90 text-gray-500 border-gray-700/80 shadow-none"
                  } ${
                    generateDisabled
                      ? clientTrimBusy
                        ? "cursor-wait opacity-100"
                        : "cursor-not-allowed opacity-50"
                      : !showPrimaryCta
                        ? "cursor-pointer text-gray-300 border-gray-600/80 hover:bg-gray-800/95 opacity-100"
                        : "cursor-pointer opacity-100"
                  }`}
                >
                  {clientTrimBusy ? (
                    <span className="inline-flex items-center justify-center gap-2.5">
                      <span
                        className="inline-block h-5 w-5 shrink-0 rounded-full border-2 border-white/35 border-t-white animate-spin"
                        aria-hidden
                      />
                      <span>{generateButtonLabel}</span>
                    </span>
                  ) : (
                    generateButtonLabel
                  )}
                </button>
                {clientTrimBusy && !result && (
                  <div className="mt-3 space-y-2.5 text-center px-1">
                    <p className="text-xs text-gray-500 max-w-md mx-auto leading-relaxed">
                      Trimming to your selected 60-minute section in the browser
                      before upload. Large files may take a minute.
                    </p>
                    {clientTrimProgress != null && clientTrimProgress > 0.02 && (
                      <div className="w-full max-w-xs mx-auto space-y-1">
                        <p className="text-[11px] text-gray-500">
                          About {Math.round(clientTrimProgress * 100)}% complete
                        </p>
                        <div className="h-1 rounded-full bg-gray-800 overflow-hidden">
                          <div
                            className="h-full bg-purple-400/80 transition-[width] duration-200 ease-out"
                            style={{
                              width: `${Math.min(100, Math.round(clientTrimProgress * 100))}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {preflightUploadActive && !result && (
                  <div className="mt-2 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <p className="text-xs text-gray-500 text-center sm:text-left sm:flex-1">
                      {uploadProgress
                        ? "Uploading video… clip generation will begin automatically once upload is complete."
                        : "Preparing video… clip generation will begin automatically once upload is complete."}
                    </p>
                    <button
                      type="button"
                      onClick={cancelPreflightUpload}
                      className="text-xs text-gray-400 hover:text-gray-200 underline underline-offset-2 text-center sm:text-right shrink-0"
                    >
                      Cancel upload
                    </button>
                  </div>
                )}
                {preflightReadyHint &&
                  !preflightUploadActive &&
                  !isCreatingJob &&
                  file &&
                  !result &&
                  error && (
                    <p className="text-xs text-amber-400/90 mt-2 text-center">
                      Something went wrong. Tap Generate Clips to try again.
                    </p>
                  )}

                {/* Upload progress (real bytes); no fake pipeline steps here */}
                {!result && (isCreatingJob || uploadProgress) && (
                  <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-5">
                    {isCreatingJob && !uploadProgress && (
                      <p className="text-white font-medium">
                        {preflightReadyHint
                          ? "Upload complete. Generating clips…"
                          : "Creating job…"}
                      </p>
                    )}
                    {uploadProgress && (
                      <div className="space-y-3">
                        <p className="text-white font-medium">Uploading video…</p>
                        <div className="h-2.5 rounded-full bg-gray-800 overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-purple-600 to-pink-600 transition-[width] duration-150 ease-linear"
                            style={{
                              width: `${uploadProgress.percent}%`,
                            }}
                          />
                        </div>
                        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-gray-300">
                          <span>
                            {uploadProgress.percent}%
                            {uploadProgress.total > 0 && (
                              <>
                                {" "}
                                <span className="text-gray-500">
                                  ({fmtBytes(uploadProgress.loaded)} /{" "}
                                  {fmtBytes(uploadProgress.total)})
                                </span>
                              </>
                            )}
                          </span>
                          {uploadProgress.etaSec != null && uploadProgress.etaSec > 0 && (
                            <span className="text-gray-500 text-xs">
                              ~{uploadProgress.etaSec}s left
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Backend pipeline (after upload only; simulated steps) */}
                {status && !result && !uploadProgress && !isCreatingJob && (
                  <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-5">
                    <p className="text-xs text-gray-500 mb-3">
                      Upload complete. Generating clips…
                    </p>
                    <div className="space-y-2">
                      {STATUS_STEPS.slice(1).map((step, i) => {
                        const stepIndex = i + 1;
                        return (
                          <div
                            key={step}
                            className={`flex items-center gap-3 text-sm transition-opacity ${
                              stepIndex <= statusIdx ? "opacity-100" : "opacity-30"
                            }`}
                          >
                            <span>
                              {stepIndex < statusIdx ? (
                                <span className="text-green-400">✓</span>
                              ) : stepIndex === statusIdx ? (
                                <span className="animate-pulse text-purple-400">●</span>
                              ) : (
                                <span className="text-gray-600">○</span>
                              )}
                            </span>
                            <span
                              className={
                                stepIndex === statusIdx
                                  ? "text-white font-medium"
                                  : stepIndex < statusIdx
                                    ? "text-green-400"
                                    : "text-gray-600"
                              }
                            >
                              {step}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-4 flex items-end justify-between gap-3">
                      <p className="text-xs text-gray-500 min-w-0 flex-1">
                        This may take a moment, especially for longer videos.
                      </p>
                      <p
                        className="text-[11px] text-gray-500/85 shrink-0 text-right leading-snug max-w-[55%]"
                        title="Approximate time; resets when the step changes"
                      >
                        <ProcessingEtaCountdown statusIdx={statusIdx} />
                      </p>
                    </div>
                  </div>
                )}

                {/* Error */}
                {error && (
                  <div className="bg-red-900/30 border border-red-800 rounded-xl p-4 text-red-300 text-sm">
                    <span className="font-semibold">Couldn&apos;t finish:</span> {error}
                  </div>
                )}
              </div>

              {(!user || plan === "free") && (
                <p className="text-sm text-gray-600 mt-6">No credit card required</p>
              )}
            </div>
          </section>

          {/* ── Pricing ── */}
          <section className="py-16 md:py-20 border-t border-gray-800/60">
            <div className="max-w-5xl mx-auto px-4">
              <h2 className="text-3xl font-bold text-white text-center mb-3">
                Pick the plan that fits your workflow
              </h2>
              <p className="text-gray-400 text-center text-sm sm:text-base max-w-xl mx-auto">
                Every account starts free. Upgrade when you need more monthly processing.
              </p>
              <p className="text-gray-600 text-center text-xs sm:text-sm mt-2 mb-12 max-w-xl mx-auto">
                Editing, trimming, and refining clips do not use extra monthly
                minutes.
              </p>
              <div className="grid sm:grid-cols-3 gap-6 items-start">
                {/* Free */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col">
                  <h3 className="text-white font-bold text-lg mb-1">Free</h3>
                  <p className="text-gray-500 text-sm mb-5">
                    Try Clipify risk-free
                  </p>
                  <div className="text-2xl font-bold text-white mb-5">
                    {PLAN_LIMITS.free.minutesPerMonth.toLocaleString("en-US")}{" "}
                    <span className="text-sm font-normal text-gray-500">
                      min / month
                    </span>
                  </div>
                  <ul className="space-y-2.5 text-sm text-gray-300 flex-1">
                    <li className="flex items-start gap-2">
                      <span className="text-gray-600 mt-0.5">✓</span>
                      Create clips with hooks
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-gray-600 mt-0.5">✓</span>
                      Trim, refine, and regenerate
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-gray-600 mt-0.5">✓</span>
                      Great for trying your first episode
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-gray-600 mt-0.5">✓</span>
                      No credit card required
                    </li>
                  </ul>
                  {!user ? (
                    <button
                      type="button"
                      onClick={() => {
                        window.location.href = "/sign-up";
                      }}
                      className="mt-6 w-full py-2.5 rounded-lg text-sm font-semibold border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500 transition-colors"
                    >
                      Sign up free
                    </button>
                  ) : (
                    <div className="mt-6 w-full py-2.5 rounded-lg text-sm font-medium text-center text-gray-500 border border-gray-800 bg-gray-950/40">
                      Included
                    </div>
                  )}
                </div>
                {/* Pro — visually emphasized */}
                <div className="bg-gray-900 border-2 border-purple-500/50 rounded-xl p-7 relative shadow-lg shadow-purple-500/10 sm:-mt-2 sm:mb-[-0.5rem] flex flex-col">
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 bg-gradient-to-r from-purple-600 to-pink-600 text-white text-xs font-bold px-4 py-1 rounded-full shadow-md">
                    Most Popular
                  </div>
                  <h3 className="text-white font-bold text-lg mb-1">Pro</h3>
                  <p className="text-gray-400 text-sm mb-5">
                    Built for active podcasters and creators
                  </p>
                  <div className="text-2xl font-bold text-white mb-5">
                    {PLAN_LIMITS.pro.minutesPerMonth.toLocaleString("en-US")}{" "}
                    <span className="text-sm font-normal text-gray-500">
                      min / month
                    </span>
                  </div>
                  <ul className="space-y-2.5 text-sm text-gray-200 flex-1">
                    <li className="flex items-start gap-2">
                      <span className="text-purple-400 mt-0.5">✓</span>
                      {PLAN_LIMITS.pro.minutesPerMonth.toLocaleString("en-US")}{" "}
                      minutes/month
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-purple-400 mt-0.5">✓</span>
                      Enough for a real weekly workflow
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-purple-400 mt-0.5">✓</span>
                      More freedom to refine and explore clips
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-purple-400 mt-0.5">✓</span>
                      Built for consistent posting and growth
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-purple-400 mt-0.5">✓</span>
                      1 trial of premium viral captions (burned into your MP4)
                    </li>
                  </ul>
                  {!user ? (
                    <button
                      type="button"
                      onClick={() => {
                        window.location.href = "/sign-up";
                      }}
                      title={`${PRO_POSITIONING.tagline}. ${PRO_POSITIONING.valuePitch}`}
                      className="mt-6 w-full py-3 rounded-lg text-sm font-semibold bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white transition-all shadow-md shadow-purple-500/20"
                    >
                      Get started
                    </button>
                  ) : plan === "free" ? (
                    <button
                      type="button"
                      onClick={() => handleUpgrade("pro")}
                      title={`${PRO_POSITIONING.tagline}. ${PRO_POSITIONING.valuePitch}`}
                      className="mt-6 w-full py-3 rounded-lg text-sm font-semibold bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white transition-all shadow-md shadow-purple-500/20"
                    >
                      Upgrade to Pro
                    </button>
                  ) : plan === "pro" ? (
                    <button
                      type="button"
                      disabled
                      className="mt-6 w-full py-3 rounded-lg text-sm font-semibold border border-purple-500/40 bg-purple-950/40 text-purple-200/80 cursor-not-allowed shadow-inner"
                    >
                      Current plan
                    </button>
                  ) : (
                    <div className="mt-6 w-full py-3 rounded-lg text-sm font-medium text-center text-purple-200/50 border border-purple-500/20 bg-purple-950/25">
                      Included
                    </div>
                  )}
                </div>
                {/* Power — subtle gold premium accents */}
                <div className="relative bg-gradient-to-b from-gray-900 to-gray-950 border border-amber-500/25 rounded-xl p-6 flex flex-col shadow-xl shadow-amber-950/40 ring-1 ring-inset ring-amber-400/10">
                  <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-gradient-to-r from-amber-900/50 via-amber-800/40 to-amber-900/50 border border-amber-500/35 text-[10px] font-bold uppercase tracking-widest text-amber-200/90 shadow-sm shadow-amber-900/30">
                    Premium
                  </div>
                  <h3 className="text-white font-bold text-lg mb-1 mt-1">Power</h3>
                  <p className="text-gray-500 text-sm mb-5">
                    Built for high-volume workflows
                  </p>
                  <div className="text-2xl font-bold text-white mb-5">
                    {PLAN_LIMITS.power.minutesPerMonth.toLocaleString("en-US")}{" "}
                    <span className="text-sm font-normal text-gray-500">
                      min / month
                    </span>
                  </div>
                  <ul className="space-y-2.5 text-sm text-gray-300 flex-1">
                    <li className="flex items-start gap-2">
                      <span className="text-amber-300/90 mt-0.5 drop-shadow-[0_0_6px_rgba(251,191,36,0.25)]">
                        ✓
                      </span>
                      {PLAN_LIMITS.power.minutesPerMonth.toLocaleString("en-US")}{" "}
                      minutes/month
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-amber-300/90 mt-0.5 drop-shadow-[0_0_6px_rgba(251,191,36,0.25)]">
                        ✓
                      </span>
                      Everything in Pro
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-amber-300/90 mt-0.5 drop-shadow-[0_0_6px_rgba(251,191,36,0.25)]">
                        ✓
                      </span>
                      Ideal for agencies, clip pages, and large backlogs
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-amber-300/90 mt-0.5 drop-shadow-[0_0_6px_rgba(251,191,36,0.25)]">
                        ✓
                      </span>
                      More room to scale and experiment
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-amber-300/90 mt-0.5 drop-shadow-[0_0_6px_rgba(251,191,36,0.25)]">
                        ✓
                      </span>
                      Premium viral-style captions — unlimited burns into your MP4
                    </li>
                  </ul>
                  {!user ? (
                    <button
                      type="button"
                      onClick={() => {
                        window.location.href = "/sign-up";
                      }}
                      title={`${POWER_POSITIONING.tagline}. ${POWER_POSITIONING.valuePitch}`}
                      className="mt-6 w-full py-2.5 rounded-lg text-sm font-semibold border border-amber-500/45 text-amber-200/95 bg-amber-950/25 shadow-md shadow-amber-950/30 hover:border-amber-400/55 hover:bg-amber-950/40 hover:shadow-amber-900/40 transition-all"
                    >
                      Get started
                    </button>
                  ) : plan === "free" || plan === "pro" ? (
                    <button
                      type="button"
                      onClick={() => handleUpgrade("power")}
                      title={`${POWER_POSITIONING.tagline}. ${POWER_POSITIONING.valuePitch}`}
                      className="mt-6 w-full py-2.5 rounded-lg text-sm font-semibold border border-amber-500/45 text-amber-200/95 bg-amber-950/25 shadow-md shadow-amber-950/30 hover:border-amber-400/55 hover:bg-amber-950/40 hover:shadow-amber-900/40 transition-all"
                    >
                      Upgrade to Power
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled
                      className="mt-6 w-full py-2.5 rounded-lg text-sm font-semibold border border-amber-600/35 bg-gray-950/60 text-amber-200/60 cursor-not-allowed shadow-inner shadow-amber-950/20 ring-1 ring-amber-500/15"
                    >
                      Current plan
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* ── Footer ── */}
          <footer className="border-t border-gray-800/60 py-8">
            <div className="max-w-4xl mx-auto px-4 text-center text-sm text-gray-600">
              © {new Date().getFullYear()} Clipify. All rights reserved.
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
