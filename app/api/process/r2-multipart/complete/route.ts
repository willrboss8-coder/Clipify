import { NextRequest, NextResponse } from "next/server";
import { logClerkAuthDebug } from "@/lib/clerk-auth-debug";
import { requireAwaitingUploadJob } from "@/lib/r2-multipart-guard";
import {
  completeMultipartUploadForJobSource,
  isR2Configured,
  type CompletedPart,
} from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function jsonError(message: string, status: number) {
  const safe = message.slice(0, 2000);
  return NextResponse.json(
    { error: safe },
    {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }
  );
}

function parseParts(raw: unknown): CompletedPart[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CompletedPart[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const o = item as { PartNumber?: unknown; ETag?: unknown };
    const pn =
      typeof o.PartNumber === "number" && Number.isFinite(o.PartNumber)
        ? Math.floor(o.PartNumber)
        : null;
    const etag = typeof o.ETag === "string" ? o.ETag.trim() : "";
    if (pn == null || pn < 1 || !etag) return null;
    out.push({ PartNumber: pn, ETag: etag });
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    let body: {
      jobId?: string;
      uploadId?: string;
      parts?: unknown;
    };
    try {
      body = (await req.json()) as {
        jobId?: string;
        uploadId?: string;
        parts?: unknown;
      };
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    const uploadId =
      typeof body.uploadId === "string" ? body.uploadId.trim() : "";

    const guard = await requireAwaitingUploadJob(jobId);
    logClerkAuthDebug("api/process/r2-multipart/complete:POST", req, {
      userId: guard.ok ? guard.userId : null,
    });

    if (!guard.ok) {
      return jsonError(guard.message, guard.status);
    }

    if (!isR2Configured()) {
      return jsonError(
        "Direct-to-storage upload is not configured (set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).",
        503
      );
    }

    if (!uploadId) {
      return jsonError("Missing uploadId", 400);
    }

    const parts = parseParts(body.parts);
    if (!parts || parts.length === 0) {
      return jsonError("Missing or invalid parts", 400);
    }

    try {
      await completeMultipartUploadForJobSource(jobId, uploadId, parts);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to complete multipart upload";
      console.error("[R2] multipart complete error:", err);
      return jsonError(msg, 500);
    }

    return NextResponse.json(
      { jobId, ok: true as const },
      {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to complete multipart upload";
    console.error("r2-multipart/complete error:", err);
    return jsonError(message, 500);
  }
}
