import { NextRequest, NextResponse } from "next/server";
import { stat, readFile } from "fs/promises";
import path from "path";
import { getStorageRoot } from "@/lib/storage-path";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const STORAGE = getStorageRoot();
  const segments = params.path;

  // Prevent path traversal
  if (segments.some((s) => s === ".." || s.includes("..") || s.startsWith("/"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const filePath = path.join(STORAGE, ...segments);
  const resolved = path.resolve(filePath);

  // Ensure resolved path is within storage
  if (!resolved.startsWith(STORAGE)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const data = await readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const contentType =
      ext === ".mp4"
        ? "video/mp4"
        : ext === ".srt"
          ? "text/plain"
          : "application/octet-stream";

    return new NextResponse(data, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(data.length),
        "Content-Disposition": `inline; filename="${path.basename(resolved)}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
