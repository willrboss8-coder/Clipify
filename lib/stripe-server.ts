import Stripe from "stripe";

/**
 * Lazy Stripe client — must not instantiate at module load or `next build` fails when
 * STRIPE_SECRET_KEY is unset during the build (Render/CI).
 */
let stripeSingleton: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripeSingleton) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    }
    stripeSingleton = new Stripe(key, {
      apiVersion: "2026-02-25.clover",
    });
  }
  return stripeSingleton;
}
