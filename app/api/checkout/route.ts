import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe-server";

/** Build-safe: Stripe is only created at request time via getStripe(). */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let tier = "pro";
    try {
      const body = await req.json();
      if (body.tier === "power" || body.tier === "pro") tier = body.tier;
    } catch {
      // No body — default to pro
    }

    const priceId =
      tier === "power"
        ? process.env.STRIPE_POWER_PRICE_ID
        : process.env.STRIPE_PRO_PRICE_ID;

    if (!priceId) {
      return NextResponse.json(
        { error: `${tier} plan is not available yet` },
        { status: 400 }
      );
    }

    const origin =
      process.env.NEXT_PUBLIC_APP_URL ||
      req.headers.get("origin") ||
      `${req.nextUrl.protocol}//${req.nextUrl.host}`;

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        clerkUserId: userId,
        tier,
      },
      /** Copied onto the Subscription so webhooks can map price → plan without relying on Session metadata alone */
      subscription_data: {
        metadata: {
          clerkUserId: userId,
          tier,
        },
      },
      success_url: `${origin}?upgraded=true`,
      cancel_url: origin,
    });

    return NextResponse.json({ url: session.url });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Checkout failed";
    console.error("Stripe checkout error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
