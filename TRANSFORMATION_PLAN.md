# Promptly AI — Backend Transformation Plan (Index)

> **Branch:** `feat/playbilling-referrals`
> **Date:** 2026-09-08
> **Status:** Planning

> **This file is now the master index.** The detailed feature-by-feature plans
> live in [`plans/`](plans/README.md). See the [full original
> TRANSFORMATION_PLAN.md history](#) (git) for the consolidated single-file
> version this replaced.

---

## Where everything is

| Plan | File | Status |
|---|---|---|
| **Master index** | [`plans/README.md`](plans/README.md) | ✅ |
| Monetization (tiers, SKUs, deposit+bonus, 5% buyer fee) | [`plans/pricing.md`](plans/pricing.md) | ✅ |
| Play Billing + RTDN + refunds | [`plans/play-billing.md`](plans/play-billing.md) | 🚧 Draft |
| Multi-balance wallet + FEFO bonus | [`plans/wallet.md`](plans/wallet.md) | 🚧 Draft |
| Referral + oAuth anti-abuse | [`plans/referrals.md`](plans/referrals.md) | 🚧 Draft |
| Withdrawal fee model | [`plans/withdrawals.md`](plans/withdrawals.md) | 🚧 Draft |
| ~~Web checkout (Razorpay)~~ | ~~`plans/web-checkout.md`~~ | ❌ Removed (Play Billing only) |
| Ads & ad-free | [`plans/ads-adfree.md`](plans/ads-adfree.md) | 🚧 Draft |
| Moderation & engagement | [`plans/moderation.md`](plans/moderation.md) | 🚧 Draft |
| Shared reference (data model, endpoints, env, risks) | [`plans/reference.md`](plans/reference.md) | 🚧 Draft |

## Build order

```
Phase 0  pricing          ← decide pricing first (drives all config)
Phase 1  play-billing     ← verify + RTDN + void/refund + reconciliation
Phase 2  wallet           ← balances + FEFO bonus vintages + migration
Phase 3  referrals        ← oAuth gate + apply + anti-abuse
Phase 4  withdrawals      ← withdrawal fee (15%/5%) deduction at payout — no gateway fee
Phase 5  ads-adfree       ← ad-free SKU + entitlement
Phase 6  moderation       ← report→appeal→admin (+ defer like/share)
```

## Summary

- **Play Billing** is the **sole payment gateway** — one-time purchases
  (prompts, deposits, ad-free) and subscriptions (Pro/Creator) all go through
  it. Razorpay is removed entirely.
- **Wallet:** earnings (withdrawable) / deposits (user money) / **bonus** (earned
  or recycled, 10%-max, 90-day expiry, FEFO).
- **Deposit top-ups** deduct the gateway fee at credit → net to `deposits`, fee
  recycled to `bonus` (user "feels" full value).
- **Two separate fees on paid prompts:** a **5% buyer transaction fee** (app
  income, never withdrawable) and a **15% Pro / 5% Creator withdrawal fee**
  (deducted when the creator initiates a payout). Play Billing commission is
  absorbed by the platform — never deducted at withdrawal.
- **Referral:** oAuth-only, immediate bonus both sides, Play Account ID + IP
  anti-abuse.
- **Withdrawals** (creator sales only): deduct ONLY the withdrawal fee (15% Pro /
  5% Creator) at payout; gateway fee (Play Billing commission) is the platform's
  cost, never re-deducted; monthly reconciliation for bookkeeping.
- **Ads:** one-time `ad_free` SKU + subscription perk.
- **Moderation:** report → soft-delete → 7-day appeal → admin approve/reject.

Start with **[plans/pricing.md](plans/pricing.md)**.