import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getUserUsage } from "@/lib/usage";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const usage = await getUserUsage(userId);
    return NextResponse.json(usage);
  } catch (err) {
    console.error("[Usage] Failed to get usage:", err);
    return NextResponse.json(
      { error: "Failed to load usage" },
      { status: 500 }
    );
  }
}
