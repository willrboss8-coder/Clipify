"use client";

import type { MutableRefObject } from "react";
import {
  R2_MULTIPART_CHUNK_BYTES,
  R2_MULTIPART_PART_MAX_RETRIES,
  R2_MULTIPART_THRESHOLD_BYTES,
} from "@/lib/r2-upload-config";

export interface UploadProgressState {
  loaded: number;
  total: number;
  percent: number;
  etaSec: number | null;
}

function storageKeyForJob(jobId: string): string {
  return `clipify_r2_mpu_${jobId}`;
}

interface MpuSessionV1 {
  v: 1;
  fileKey: string;
  uploadId: string;
  chunkSizeBytes: number;
  parts: { PartNumber: number; ETag: string }[];
}

function loadMpuSession(jobId: string, fileKey: string): MpuSessionV1 | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(storageKeyForJob(jobId));
    if (!raw) return null;
    const p = JSON.parse(raw) as MpuSessionV1;
    if (p.v !== 1 || p.fileKey !== fileKey) return null;
    if (p.chunkSizeBytes !== R2_MULTIPART_CHUNK_BYTES) return null;
    if (!p.uploadId || !Array.isArray(p.parts)) return null;
    return p;
  } catch {
    return null;
  }
}

function saveMpuSession(jobId: string, data: MpuSessionV1): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(storageKeyForJob(jobId), JSON.stringify(data));
  } catch {
    /* quota / private mode */
  }
}

function clearMpuSession(jobId: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(storageKeyForJob(jobId));
  } catch {
    /* ignore */
  }
}

async function fireAbortMultipart(jobId: string, uploadId: string): Promise<void> {
  try {
    await fetch("/api/process/r2-multipart/abort", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, uploadId }),
    });
  } catch {
    /* best-effort */
  }
}

function partSliceRange(
  partNumber: number,
  fileSize: number,
  chunk: number
): { start: number; end: number; size: number } {
  const start = (partNumber - 1) * chunk;
  const end = Math.min(start + chunk, fileSize);
  return { start, end, size: Math.max(0, end - start) };
}

function bytesCompletedBeforePart(
  partNumber: number,
  fileSize: number,
  chunk: number
): number {
  let sum = 0;
  for (let p = 1; p < partNumber; p++) {
    sum += partSliceRange(p, fileSize, chunk).size;
  }
  return sum;
}

/**
 * PUT file to a presigned R2 URL (cross-origin; do not send cookies).
 */
export function putFileToPresignedUrlWithProgress(
  uploadUrl: string,
  file: File,
  contentType: string,
  opts: {
    onProgress: (p: UploadProgressState) => void;
    uploadStartMsRef: MutableRefObject<number>;
    xhrRefForAbort?: MutableRefObject<XMLHttpRequest | null>;
    signal?: AbortSignal;
  }
): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (opts.xhrRefForAbort) opts.xhrRefForAbort.current = xhr;

    const onAbort = () => {
      xhr.abort();
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      opts.signal.addEventListener("abort", onAbort);
    }

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
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      if (opts.xhrRefForAbort) opts.xhrRefForAbort.current = null;
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        body: xhr.responseText,
      });
    };
    xhr.onerror = () => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      if (opts.xhrRefForAbort) opts.xhrRefForAbort.current = null;
      reject(new Error("Network error"));
    };
    xhr.onabort = () => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      if (opts.xhrRefForAbort) opts.xhrRefForAbort.current = null;
      reject(new Error("Upload aborted"));
    };
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.send(file);
  });
}

function putBlobToPresignedUrlWithProgress(
  uploadUrl: string,
  blob: Blob,
  opts: {
    onPartProgress: (loaded: number, total: number) => void;
    uploadStartMsRef: MutableRefObject<number>;
    signal?: AbortSignal;
  }
): Promise<{ ok: boolean; status: number; etag: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => {
      xhr.abort();
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      opts.signal.addEventListener("abort", onAbort);
    }

    xhr.open("PUT", uploadUrl);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        if (opts.uploadStartMsRef.current === 0) {
          opts.uploadStartMsRef.current = Date.now();
        }
        opts.onPartProgress(e.loaded, e.total);
      }
    };
    xhr.onload = () => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      const etag =
        xhr.getResponseHeader("ETag") ?? xhr.getResponseHeader("etag");
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        etag: etag?.trim() ?? null,
      });
    };
    xhr.onerror = () => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      reject(new Error("Network error"));
    };
    xhr.onabort = () => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      reject(new Error("Upload aborted"));
    };
    xhr.send(blob);
  });
}

async function postJson(
  url: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

const COMPLETE_MAX_RETRIES = 3;

async function uploadMultipartToR2(params: {
  file: File;
  jobId: string;
  fileKey: string;
  onProgress: (p: UploadProgressState) => void;
  uploadStartMsRef: MutableRefObject<number>;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const { file, jobId, fileKey, onProgress, uploadStartMsRef, signal } = params;
  const chunk = R2_MULTIPART_CHUNK_BYTES;
  const totalBytes = file.size;
  const totalParts = Math.max(1, Math.ceil(totalBytes / chunk));

  let uploadId: string;
  let parts: { PartNumber: number; ETag: string }[];

  const saved = loadMpuSession(jobId, fileKey);
  const savedTotalParts =
    saved &&
    Math.max(1, Math.ceil(totalBytes / saved.chunkSizeBytes)) === totalParts
      ? saved
      : null;

  if (
    savedTotalParts &&
    savedTotalParts.parts.length <= totalParts &&
    savedTotalParts.uploadId
  ) {
    uploadId = savedTotalParts.uploadId;
    parts = [...savedTotalParts.parts].sort(
      (a, b) => a.PartNumber - b.PartNumber
    );
    if (parts.length > totalParts) {
      clearMpuSession(jobId);
      return uploadMultipartToR2(params);
    }
  } else {
    if (saved) clearMpuSession(jobId);
    const initRes = await postJson(
      "/api/process/r2-multipart/init",
      { jobId },
      signal
    );
    if (!initRes.ok) {
      const t = await initRes.text();
      return {
        ok: false,
        status: initRes.status,
        body: t.slice(0, 4000),
      };
    }
    const initJson = (await initRes.json()) as { uploadId?: string };
    if (typeof initJson.uploadId !== "string" || !initJson.uploadId) {
      return {
        ok: false,
        status: 500,
        body: "Invalid init response",
      };
    }
    uploadId = initJson.uploadId;
    parts = [];
    saveMpuSession(jobId, {
      v: 1,
      fileKey,
      uploadId,
      chunkSizeBytes: chunk,
      parts: [],
    });
  }

  const emitAggregate = (partNumber: number, partLoaded: number, partTotal: number) => {
    const base = bytesCompletedBeforePart(partNumber, totalBytes, chunk);
    const loaded = Math.min(base + partLoaded, totalBytes);
    const percent = Math.min(100, Math.round((loaded / totalBytes) * 100));
    const elapsedSec = (Date.now() - uploadStartMsRef.current) / 1000;
    const rate = elapsedSec > 0 && loaded > 0 ? loaded / elapsedSec : 0;
    const etaSec =
      rate > 0 && totalBytes > loaded
        ? Math.max(0, Math.round((totalBytes - loaded) / rate))
        : null;
    onProgress({ loaded, total: totalBytes, percent, etaSec });
  };

  const startPart =
    parts.length > 0
      ? Math.max(...parts.map((p) => p.PartNumber)) + 1
      : 1;

  for (let partNumber = startPart; partNumber <= totalParts; partNumber++) {
    if (signal?.aborted) {
      await fireAbortMultipart(jobId, uploadId);
      throw new DOMException("Aborted", "AbortError");
    }

    const { start, end } = partSliceRange(partNumber, totalBytes, chunk);
    const blob = file.slice(start, end);

    let etag: string | null = null;
    let lastStatus = 0;

    for (let attempt = 0; attempt < R2_MULTIPART_PART_MAX_RETRIES; attempt++) {
      if (signal?.aborted) {
        await fireAbortMultipart(jobId, uploadId);
        throw new DOMException("Aborted", "AbortError");
      }

      const urlRes = await postJson(
        "/api/process/r2-multipart/part-url",
        { jobId, uploadId, partNumber },
        signal
      );
      if (!urlRes.ok) {
        const t = await urlRes.text();
        if (urlRes.status >= 400 && urlRes.status < 500 && urlRes.status !== 429) {
          return { ok: false, status: urlRes.status, body: t.slice(0, 4000) };
        }
        if (attempt === R2_MULTIPART_PART_MAX_RETRIES - 1) {
          return { ok: false, status: urlRes.status, body: t.slice(0, 4000) };
        }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }

      const urlJson = (await urlRes.json()) as { uploadUrl?: string };
      if (typeof urlJson.uploadUrl !== "string" || !urlJson.uploadUrl) {
        return {
          ok: false,
          status: 500,
          body: "Invalid part-url response",
        };
      }

      try {
        const put = await putBlobToPresignedUrlWithProgress(
          urlJson.uploadUrl,
          blob,
          {
            onPartProgress: (pl, pt) =>
              emitAggregate(partNumber, pl, pt),
            uploadStartMsRef,
            signal,
          }
        );
        lastStatus = put.status;
        if (put.ok && put.etag) {
          etag = put.etag;
          break;
        }
        etag = put.etag;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "";
        if (msg === "Upload aborted" || e instanceof DOMException) {
          await fireAbortMultipart(jobId, uploadId);
          throw e;
        }
        if (attempt === R2_MULTIPART_PART_MAX_RETRIES - 1) {
          return {
            ok: false,
            status: lastStatus || 0,
            body: msg || "Part upload failed",
          };
        }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }

    if (!etag) {
      return {
        ok: false,
        status: lastStatus || 502,
        body: "Missing ETag after part upload",
      };
    }

    parts.push({ PartNumber: partNumber, ETag: etag });
    saveMpuSession(jobId, {
      v: 1,
      fileKey,
      uploadId,
      chunkSizeBytes: chunk,
      parts,
    });
    emitAggregate(partNumber + 1, 0, chunk);
  }

  const sorted = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);
  if (sorted.length !== totalParts) {
    return { ok: false, status: 500, body: "Incomplete multipart parts" };
  }

  for (let c = 0; c < COMPLETE_MAX_RETRIES; c++) {
    if (signal?.aborted) {
      await fireAbortMultipart(jobId, uploadId);
      throw new DOMException("Aborted", "AbortError");
    }
    const completeRes = await postJson(
      "/api/process/r2-multipart/complete",
      { jobId, uploadId, parts: sorted },
      signal
    );
    if (completeRes.ok) {
      clearMpuSession(jobId);
      return { ok: true, status: 200, body: "" };
    }
    const errText = await completeRes.text();
    if (completeRes.status >= 400 && completeRes.status < 500 && completeRes.status !== 429) {
      return {
        ok: false,
        status: completeRes.status,
        body: errText.slice(0, 4000),
      };
    }
    await new Promise((r) => setTimeout(r, 800 * (c + 1)));
  }

  return {
    ok: false,
    status: 500,
    body: "Failed to complete multipart upload after retries",
  };
}

/**
 * Single PUT under threshold; multipart with per-part retry and session resume above threshold.
 * Final object key matches single-PUT flow; call upload-complete next as today.
 */
export async function uploadFileToR2WithProgress(params: {
  file: File;
  jobId: string;
  contentType: string;
  singlePutUrl: string;
  fileKey: string;
  onProgress: (p: UploadProgressState) => void;
  uploadStartMsRef: MutableRefObject<number>;
  signal?: AbortSignal;
  xhrRefForAbort?: MutableRefObject<XMLHttpRequest | null>;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const {
    file,
    jobId,
    contentType,
    singlePutUrl,
    fileKey,
    onProgress,
    uploadStartMsRef,
    signal,
    xhrRefForAbort,
  } = params;

  if (file.size <= R2_MULTIPART_THRESHOLD_BYTES) {
    return putFileToPresignedUrlWithProgress(
      singlePutUrl,
      file,
      contentType,
      {
        onProgress,
        uploadStartMsRef,
        xhrRefForAbort,
        signal,
      }
    );
  }

  return uploadMultipartToR2({
    file,
    jobId,
    fileKey,
    onProgress,
    uploadStartMsRef,
    signal,
  });
}
