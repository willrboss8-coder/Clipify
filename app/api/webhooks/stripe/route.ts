import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { clerkClient } from "@clerk/nextjs/server";
import { getStripe } from "@/lib/stripe-server";

export const dynamic = "force-dynamic";

type PaidTier = "pro" | "power";

function tierFromPriceId(priceId: string | undefined): PaidTier | null {
  if (!priceId) return null;
  const power = process.env.STRIPE_POWER_PRICE_ID;
  const pro = process.env.STRIPE_PRO_PRICE_ID;
  if (power && priceId === power) return "power";
  if (pro && priceId === pro) return "pro";
  return null;
}

function tierFromMetadata(tier: string | undefined): PaidTier {
  return tier === "power" ? "power" : "pro";
}

/**
 * Prefer the Stripe Price ID on the subscription (matches what was charged).
 * Fall back to session/subscription metadata when env IDs are missing or unknown price.
 */
async function resolveTierFromCheckoutSession(
  session: Stripe.Checkout.Session
): Promise<PaidTier> {
  const metaFallback = tierFromMetadata(session.metadata?.tier);

  const subId = session.subscription;
  if (typeof subId !== "string" || !subId) {
    return metaFallback;
  }

  try {
    const sub = await getStripe().subscriptions.retrieve(subId, {
      expand: ["items.data.price"],
    });
    const priceId = sub.items.data[0]?.price?.id;
    const fromPrice = tierFromPriceId(
      typeof priceId === "string" ? priceId : undefined
    );
    if (fromPrice) return fromPrice;

    const subMeta = sub.metadata?.tier;
    if (subMeta === "power" || subMeta === "pro") {
      return subMeta;
    }
  } catch (err) {
    console.error(
      "[Stripe Webhook] Could not load subscription for tier resolution:",
      err
    );
  }

  return metaFallback;
}

async function applyPlanToClerk(
  clerkUserId: string,
  tier: PaidTier,
  customerId: string | null,
  subscriptionId: string | null
) {
  const client = await clerkClient();
  const publicMetadata: Record<string, string> = { plan: tier };
  if (customerId) publicMetadata.stripeCustomerId = customerId;
  if (subscriptionId) publicMetadata.stripeSubscriptionId = subscriptionId;
  await client.users.updateUserMetadata(clerkUserId, {
    publicMetadata,
  });
  console.log(`[Stripe Webhook] User ${clerkUserId} set to ${tier}`);
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

  if (!sig || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("[Stripe Webhook] Missing signature or webhook secret");
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Signature failed";
    console.error("[Stripe Webhook] Signature verification failed:", message);
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const clerkUserId = session.metadata?.clerkUserId;

      if (clerkUserId) {
        const tier = await resolveTierFromCheckoutSession(session);
        await applyPlanToClerk(
          clerkUserId,
          tier,
          typeof session.customer === "string" ? session.customer : null,
          typeof session.subscription === "string" ? session.subscription : null
        );
      }
    }

    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object as Stripe.Subscription;
      const clerkUserId = sub.metadata?.clerkUserId;
      if (!clerkUserId) {
        console.warn(
          "[Stripe Webhook] subscription.updated: missing clerkUserId in subscription metadata"
        );
      } else {
        const priceId = sub.items.data[0]?.price?.id;
        let tier = tierFromPriceId(
          typeof priceId === "string" ? priceId : undefined
        );
        if (!tier) {
          tier = tierFromMetadata(sub.metadata?.tier);
        }
        await applyPlanToClerk(
          clerkUserId,
          tier,
          typeof sub.customer === "string" ? sub.customer : null,
          sub.id
        );
      }
    }
  } catch (err) {
    console.error("[Stripe Webhook] Handler error:", err);
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
