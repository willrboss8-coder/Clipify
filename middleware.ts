import { NextResponse } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { isClerkAuthDebugEnabled, logClerkAuthDebug } from "@/lib/clerk-auth-debug";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks(.*)",
]);

/**
 * Do not call auth.protect() on /api/* — Clerk's protect() uses notFound() for
 * non-page requests when unauthenticated, which yields HTML/404 instead of JSON.
 * API routes use `auth()` and return `{ error }` JSON themselves.
 *
 * Still `await auth()` for API routes so Clerk fully resolves the session for
 * this request (helps route handlers see the same user as the browser session).
 */
export default clerkMiddleware(
  async (auth, req) => {
    try {
      if (isPublicRoute(req)) {
        return;
      }
      if (req.nextUrl.pathname.startsWith("/api/")) {
        const { userId } = await auth();
        logClerkAuthDebug("middleware:api", req, { userId });
        return;
      }
      await auth.protect();
    } catch (err) {
      const path = req.nextUrl.pathname;
      if (path.startsWith("/api/")) {
        console.error("[middleware]", path, err);
        return NextResponse.json(
          { error: "Request failed (middleware). Try again or sign in again." },
          { status: 500 }
        );
      }
      throw err;
    }
  },
  (req) => {
    const parties = process.env.CLERK_AUTHORIZED_PARTIES?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      ...(isClerkAuthDebugEnabled() ? { debug: true as const } : {}),
      ...(parties?.length ? { authorizedParties: parties } : {}),
    };
  }
);

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
