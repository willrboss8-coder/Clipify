import type { NextRequest } from "next/server";

/** Local-only: set `CLERK_AUTH_DEBUG=1` (ignored when NODE_ENV is production). */
export function isClerkAuthDebugEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const v = process.env.CLERK_AUTH_DEBUG;
  return v === "1" || v === "true";
}

/**
 * Safe structured logs (no cookie values). Compare middleware vs route handler for the same request.
 */
export function logClerkAuthDebug(
  phase: string,
  req: NextRequest | Request,
  extra: { userId: string | null | undefined }
): void {
  if (!isClerkAuthDebugEnabled()) return;

  const h = req.headers;
  const host = h.get("host");
  const xfHost = h.get("x-forwarded-host");
  const xfProto = h.get("x-forwarded-proto");
  const cookie = h.get("cookie");
  const cookieNames = cookie
    ? cookie.split(";").map((p) => p.trim().split("=")[0]).filter(Boolean)
    : [];
  const clerkCookieLikely = cookieNames.some(
    (n) =>
      n.includes("__session") ||
      n.includes("__clerk") ||
      n.toLowerCase().includes("clerk")
  );

  const sk = process.env.CLERK_SECRET_KEY;
  const pk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  console.log(
    JSON.stringify({
      tag: "[clerk-auth-debug]",
      phase,
      host,
      xForwardedHost: xfHost,
      xForwardedProto: xfProto,
      path:
        "nextUrl" in req && req.nextUrl
          ? req.nextUrl.pathname
          : "(request)",
      userId: extra.userId ?? null,
      cookieHeaderLength: cookie?.length ?? 0,
      cookieNameCount: cookieNames.length,
      cookieNamesSample: cookieNames.slice(0, 10),
      clerkCookieLikely,
      clerkSecretKeyMode: sk?.startsWith("sk_live")
        ? "live"
        : sk?.startsWith("sk_test")
          ? "test"
          : sk
            ? "unknown_prefix"
            : "missing",
      clerkPublishableKeyMode: pk?.startsWith("pk_live")
        ? "live"
        : pk?.startsWith("pk_test")
          ? "test"
          : pk
            ? "unknown_prefix"
            : "missing",
    })
  );
}
