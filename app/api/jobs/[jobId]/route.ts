import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { readJobRecord } from "@/lib/jobStore";
import { logE2EApiPollCompleted } from "@/lib/e2e-timing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  _req: Request,
  { params }: { params: { jobId: string } }
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobId = params.jobId;
  if (!jobId || !UUID_RE.test(jobId)) {
    return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  }

  const record = await readJobRecord(jobId);
  if (!record) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (record.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (record.status === "completed") {
    logE2EApiPollCompleted(jobId);
  }

  return NextResponse.json(
    {
      jobId: record.jobId,
      status: record.status,
      result: record.status === "completed" ? record.result : undefined,
      error: record.status === "failed" ? record.error : undefined,
    },
    { headers: { "Content-Type": "application/json; charset=utf-8" } }
  );
}
