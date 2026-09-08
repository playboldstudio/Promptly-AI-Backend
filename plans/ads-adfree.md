# Ads & One-Time Ad-Free Purchase

> **Phase 6** · Companion: [pricing.md](pricing.md) §3 (ad-free SKU), [play-billing.md](play-billing.md) (verify/grant)

## 1. Scope

- Free users see ads (banner + interstitial).
- A user can **remove ads forever with a one-time Play Billing purchase** (`ad_free`).
- **Subscribers (Pro/Creator) get ad-free as a perk** — a real perceived value
  that costs you nothing.

> Out of scope: **rewarded video**, interstitial mediation stack, ad-network
> backend. This file only covers the **ad-free entitlement** — the actual
> ad-serving is a separate project.

## 2. Entitlement model

Ad-free when **any** of:
- `user.adFree === true` (one-time purchase)
- Active Pro/Creator subscription within paid period
- Platform admin

```javascript
export function shouldShowAds({ user, subscription }) {
  if (user?.adFree) return false;
  if (user?.adFreeUntil && user.adFreeUntil > new Date()) return false;
  if (subscription?.status === 'active') return false;
  if (isAdminEmail(user?.email)) return false;
  return true; // free, non-subscribed → ads
}
```

Evaluate entitlement **once at login + on subscription events** and cache the
result on the user doc (`adFree`), rather than computing per request.

## 3. Data

```javascript
// users doc (denormalized entitlement):
{
  adFree: true,               // is this user ad-free?
  adFreePurchasedAt: Date | null,
  adFreeSku: 'ad_free' | null,
}

// ad_free_purchases (audit):
{
  id: userId,                 // one-time SKU → one record per user
  userId, productId: 'ad_free', purchaseToken,
  purchaseTime: Date, amountInr: 149,
  status: 'verified', createdAt, updatedAt,
}
```

## 4. Flow

```
User taps "Remove Ads"
  → Play Billing: purchase ad_free (₹149, one-time)
  → App → POST /payments/playbilling/ad-free { productId, purchaseToken }
  → Backend: verifyOneTimePurchase → set user.adFree = true → acknowledgePurchase
  → Return updated user
```

Endpoint: `POST /payments/playbilling/ad-free`

## 5. One-time vs quick-expiry

Current: **lifetime** (non-consumable, `adFree: true` forever). The
`adFreeUntil` path (₹149 for e.g. 1 month) is a future option — keep the SKU
flexible but ship **lifetime** first (cleanest mental model, matches `ad_free`
semantics).

## 6. Env vars

```bash
AD_FREE_PRODUCT_ID=ad_free
AD_FREE_PRICE_INR=149
```

SKU price is decided in [pricing.md](pricing.md) §3.

## 7. Related

- [play-billing.md](play-billing.md) — verify/grant flow
- [pricing.md](pricing.md) — SKU amount + subscription perk
- [reference.md](reference.md) — shared env