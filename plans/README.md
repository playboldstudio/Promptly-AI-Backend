# Promptly AI — Feature Plans

Feature-by-feature plans for the backend transformation. The old single-file
`TRANSFORMATION_PLAN.md` is now split here so each feature is documented
independently and can be built in isolation.

## Index

| File | Feature | Status | Build order |
|------|---------|--------|-------------|
| [pricing.md](pricing.md) | Monetization — Pro/Creator tiers, one-time purchases, deposit + bonus rewards | ✅ Ready | Phase 0 (decide before anything else) |
| [play-billing.md](play-billing.md) | Play Billing integration (purchases, subscriptions, RTDN, refunds) | ✅ Built | Phase 1 |
| [wallet.md](wallet.md) | Multi-balance wallet (earnings / deposits / bonus) + FEFO bonus expiry | ✅ Built | Phase 2 |
| [referrals.md](referrals.md) | Referral program + oAuth-only signup + anti-abuse | 🚧 Draft | Phase 3 |
| [withdrawals.md](withdrawals.md) | Withdrawal model (only platform fee deducted at payout — no gateway fee) | 🚧 Draft | Phase 4 |
| ~~[web-checkout.md](web-checkout.md)~~ | ~~Razorpay web checkout (dual gateway)~~ | ❌ Removed | — |
| [ads-adfree.md](ads-adfree.md) | Ads & one-time ad-free purchase | 🚧 Draft | Phase 5 |
| [moderation.md](moderation.md) | Prompt engagement & report→appeal→admin moderation | 🚧 Draft | Phase 6 |
| [reference.md](reference.md) | Shared reference — data model, API endpoints, env vars, roadmap, risks | 🚧 Draft | Cross-cutting |

## Build order

```
Phase 0  pricing          ← decide pricing/entitlements first (drives everything else)
Phase 1  play-billing     ← Play Billing verification + RTDN + refunds
Phase 2  wallet           ← multi-balance wallet + FEFO bonus expiry
Phase 3  referrals        ← referral program + oAuth signup + anti-abuse
Phase 4  withdrawals      ← platform-fee-only deduction at payout (no gateway fee)
Phase 5  ads-adfree       ← one-time ad-free purchase
Phase 6  moderation       ← like/save/share + report→appeal→admin
```

## How to use

1. Read **[pricing.md](pricing.md)** first — it decides the product config for
   every other phase.
2. Each phase file is self-contained: design, data model, endpoints, env vars,
   implementation order, and open questions.
3. **Shared** schema/endpoint/env-var definitions live in
   [reference.md](reference.md), not duplicated per-file.
4. When a file's 🚧 Draft → ✅ Ready, flip its status here and link the PR/commit.

> Legacy: the original single-file plan remains at `TRANSFORMATION_PLAN.md` for
> history. Do not edit it — use these files.