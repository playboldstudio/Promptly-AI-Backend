# Monetization Plan — Tiers, One-Time Products, Deposit + Bonus

> **Phase 0** — decide pricing before anything else. Every other phase file
> depends on the product config spelled out here.

## 0. TL;DR

- Bump the monthly tiers: **Pro ₹49 → ₹99** and **Creator ₹99 → ₹199**.
- Add **annual** variants priced ~2 months free.
- One-time in-app products: **ad-free ₹149**, **deposit packs** ₹10 / ₹100 / ₹500 / ₹1000.
- **Deposit top-ups** deduct the Play Billing fee at credit time → `deposits` gets
  the **net**, and the fee is **recycled as `bonus`**. So "₹100 top-up" = ₹85
  deposits + ₹15 bonus — the user feels full value, the wallet stays honest.
- **Platform fees raised:** Pro **15%**, Creator **5%** (withdrawal/platform fee).
- **Two separate fees** (see below): a **5% buyer transaction fee** on paid
  prompt purchases and a **15%/5% withdrawal fee** — the Play Billing commission
  is absorbed by the platform and **never** deducted at withdrawal.

---

## 1. Why raise the prices

The current tiers (Pro ₹49, Creator ₹99) are thin from **2024** — India's
subscription sweet spot has moved to **₹99–₹199**. Play Billing takes 15% off
every rupee, so at ₹49 the fee is ₹7.35 — ugly on a feature-light plan that
mostly unlocks "can post paid prompts."

| Plan | Now | Proposed | Play Billing 15% | Net to you |
|------|-----|----------|------------------|------------|
| Pro (monthly) | ₹49 | **₹99** | ₹14.85 | ₹84.15 |
| Creator (monthly) | ₹99 | **₹199** | ₹29.85 | ₹169.15 |
| Pro (annual) | – | **₹999** (~2 mo free vs monthly) | ₹149.85 | ₹849.15 |
| Creator (annual) | – | **₹1,999** (~2 mo free vs monthly) | ₹299.85 | ₹1,699.15 |

> *"Net to you"* is the **platform's** take on the subscription itself (Play
> Billing commission is the platform's cost). Creator prompt-sale fees are a
> separate matter — see the two-fee table below.

**Why these numbers:**
- **₹99** is the India-standard entry tier (music, fitness, productivity apps).
- **₹199** ≈ ₹6.6/day — a "creator tool" price, not an impulse buy.
- **₹999 / ₹1,999 annual** ≈ 2 months of monthly pricing free — the classic
  annual-plan anchor that lifts LTV and cuts churn.

> ⚠️ These are *recommendations*, not guarantees. Validate with a price-test
> (A/B the ₹99 vs ₹79 Pro) before committing in Play Console. If your user base
> is price-sensitive early, ship ₹79 → ₹149 and climb later.

**The two fees on a paid prompt sale:**

| Queue | Amount (₹99 prompt) | Who pays | Where it goes |
|---|---|---|---|
| **Transaction fee** (in-app) | 5% × price = **₹4.95** | Buyer (pays ₹103.95) | App (platform) — never credited, never withdrawable |
| **Withdrawal fee** | **15%** Pro seller / **5%** Creator seller | Creator (at withdrawal) | Platform |

```
Buyer pays:      ₹99.00 + ₹4.95 (5% transaction) = ₹103.95
  → app collects ₹4.95 immediately (app income)
  → creator's earnings: ₹99.00 (full gross)
Creator withdraws: ₹99.00 − ₹14.85 (15% Pro) = ₹84.15   (or −₹4.95 → ₹94.05 for 5% Creator)
```

> Creator's **earnings** = full gross price credited at sale. Google's 15% Play
> Billing commission is **settled at payment time** (the platform's cost, out of
> the ₹103.95) — it is **not** deducted from the creator or the buyer at withdrawal.
> The withdrawal fee (15%/5%) is the only deduction at payout. See
> [withdrawals.md](withdrawals.md).

---

## 2. Plan entitlements (align with product scope)

| | Free | Pro (₹99/mo) | Creator (₹199/mo) |
|---|---|---|---|
| Browse / use prompts | ✅ | ✅ | ✅ |
| Daily prompt posts | 3 | Unlimited | Unlimited |
| Sell paid prompts | ❌ | ✅ | ✅ |
| Withdrawal fee on your payouts | – | **15%** | **5%** |
| Ad-free | ❌ | ✅ (perk) | ✅ (perk) |
| Deposit top-ups | ✅ | ✅ | ✅ |
| Referral / bonus | ✅ | ✅ | ✅ |
| Withdraw earnings | ✅ (min ₹60) | ✅ | ✅ |
| **NEW** Like/save counts on your prompts | – | ✅ | ✅ |
| **NEW** Priority in engagement feed | – | – | ✅ |

**Changes vs today:**
- **Withdrawal fees raised:** Pro **5% → 15%**, Creator **0% → 5%** (charged when
  a creator initiates a payout). Creator keeps the *discount* (still 10% cheaper
  than Pro) so upgrading stays attractive, but the platform makes margin on both
  tiers.
- Added **ad-free as a subscription perk** — a real perceived value that costs you
  nothing, and it makes the one-time ad-free SKU a *try-then-buy*.
- **Creator gets feed priority** — a non-monetary differentiator between Pro and
  Creator, since both otherwise sell paid prompts.

---

## 3. One-time in-app product pricing (Play Billing)

| Product | SKU | Price (₹) | Type | Notes |
|---|---|---|---|---|
| Remove Ads (lifetime) | `ad_free` | **₹149** | One-time, non-consumable | One purchase, forever |
| Deposit Pack S | `deposit_s` | **₹10** | Consumable | Minimum top-up (matches Google's floor) |
| Deposit Pack M | `deposit_m` | **₹100** | Consumable | Stripe-style default |
| Deposit Pack L | `deposit_l` | **₹500** | Consumable | Common mid-size |
| Deposit Pack XL | `deposit_xl` | **₹1000** | Consumable | Power users |

**₹149 for ad-free — why:**
- Sits in Google Play's "impulse" band (₹100–₹300).
- Annual Pro is ₹999: a one-time ₹149 is an easy upsell for a light user who
  won't subscribe.
- If you later want *bonus-generous* ad-free, keep the SKU but add a bonus
  credit — the price is set, the mechanics can evolve.

> **For deposits:** price the SKU in Play Console at the *cash top-up* amount.
> Google's fee comes out of that — that fee is what gets recycled as `bonus`
> (§4 below). A "₹100 deposit" → ₹85 `deposits` + ₹15 `bonus`. ₹10 is the minimum
> saver tier; if you want to avoid micro amounts, set deposit_min to **₹20**.

---

## 4. Deposit mechanics — "can we give 10 + bonus?"

**Answer: Yes — deduct the gateway fee at *credit* time and recycle it as bonus.**

When a user tops up ₹100, Google takes ₹15 (15%). Instead of the old plan (which
would either show a reduced deposit or make you eat the ₹15), we split it:

```
Top up ₹100 (deposit_m)
  → Play Billing takes ₹15 (15% gateway fee)
  → wallet.deposits += ₹85        (net spendable — the honest balance)
  → wallet.bonus    += ₹15        (the fee, recycled as bonus)
  → user "feels" full ₹100 of value, wallet stays correct
```

That's the familiar **fintech "recharge bonus"** pattern (Paytm/MobiKwik style).

### Why this is coherent

- **`deposits`** is the user's *own money* — it should be the net they actually
  have. Crediting gross ₹100 means we're lending them ₹15 we already paid Google.
- **`bonus`** is *earned/recycled* money — the ₹15 we were going to lose to Google
  anyway becomes a retention credit instead. It's spend-limited (10% cap), expires
  in 90 days, and can't be withdrawn.

### The one liability to be aware of (★)

> Recycling a fee into bonus is **not free** in the long run:
> - The ₹15 bonus is non-withdrawable & expires in 90 days — good.
> - **But** when bonus is spent on another creator's prompt, that creator gets real
>   `earnings` that later **can be withdrawn** — funded by *you*, since there's no
>   new Google payment behind bonus spend.
> - So the ₹15 you recycled can eventually come back as ₹15 of *your* payout to a
>   creator. The 10% cap + 90-day expiry contain this — it's a **deliberate
>   retention subsidy**, not a free lunch.

That's an acceptable trade — you get an honest wallet and a spending flywheel — but
it should be a *choice*, not an accident. (This applies to **user top-ups**. Creator
*paid-prompt sales* use a different split: a **5% buyer transaction fee** goes to the
app at purchase, and the **15%/5% withdrawal fee** is taken at payout. Both flows
share one principle: the **Play Billing commission is absorbed by the platform** and
is never deducted at withdrawal.)

### Deposit flow (concrete)

```
User taps "Add ₹100"
  → Play Billing: purchase deposit_m (₹100)
  → App sends token → POST /payments/playbilling/deposit { productId: "deposit_m", token }
  → Backend verifies via Android Publisher API (one-time, consumable)
  → Acknowledge purchase (to prevent refund)
  → gatewayFee = 100 × 15% = ₹15
  → wallet.deposits += ₹85   (net)
  → wallet.bonus    += ₹15   (fee recycled as bonus, FEFO vintage)
  → transactions (2 rows):
       { type: 'deposit_credit',      direction: 'credit', balanceType: 'deposits',
         amountInr: 85, gatewayFeeInr: 15, note: 'Top-up deposit_m — net after fee' }
       { type: 'deposit_fee_bonus',   direction: 'credit', balanceType: 'bonus',
          amountInr: 15, refId: <deposit tx>, note: '₹15 fee recycled as bonus' }
```

### Pricing writes

```javascript
// In wallet.service — deposit handler: net to deposits, fee→bonus (FEFO vintage)
export async function handleDepositTopUp({ userId, priceInr }) {
  const { feePercent } = calculateTopUpFee(priceInr);          // 15%
  const netDeposit = Math.round((priceInr * (100 - feePercent)) / 100);
  const bonusCredit = priceInr - netDeposit;

  return runTransaction(async (tx) => {
    // deposits += netDeposit
    // bonus    += bonusCredit (as a bonusVintage with 90-day expiry)
    // two ledger rows, same refId
  });
}
```

> **Backward-compatible note:** if you previously already granted gross deposits,
> the recycle is a one-time migration (existing `deposits` stay; only *new* top-ups
> split). See wallet.md §6.

---

## 5. Rewards design (bonus funnel)

Bonus is **earned or recycled**, never bought outright. Sources:

| Source | Bonus (₹) | Notes |
|---|---|---|
| Deposit top-up (fee recycle) | 15% of top-up | ₹100 top-up → ₹15 bonus (see §4) |
| Referral — referrer | 50 | Immediate, on valid oAuth signup |
| Referral — referee (welcome) | 25 | Immediate, on signup |
| Daily login streak (future) | 5–10 | 7-day / 14-day streaks |
| Promo / voucher (future) | variable | Admin-created |
| Top-creator reward (future) | 200 | Monthly |
| Subscription perk (future) | 20 | Pro/Creator monthly allowance |

All credit to the **same `bonus` balance** — single rule set (10% max, 90-day
expiry). Adding a future reward = a new credit, nothing structural.

> **Design guardrail:** the deposit fee-recycle **is** a percentage-of-top-up bonus
> (15%) — it's contained by the 10%-of-item-price *spend* cap, so it's spend-safe.
> But don't *compound* it: no cashback on top of the recycle, no purchase-%
> rebates, until you explicitly design a cashback economy. The recycle is the one
> built-in percentage bonus; keep everything else flat.

---

## 6. Play Billing price points (India) — what to place

Play Console mandates **predefined price tiers** — you can't set arbitrary INR.
The relevant India price points near our targets:

| Target | Predefined price point (INR, approx.) |
|---|---|
| ₹99 → | ₹99 ✓ (exact tier) |
| ₹199 → | ₹199 ✓ (exact tier) |
| ₹999 annual | ₹999 ✓ (exact tier, or nearest approved point) |
| ₹1,999 annual | ₹1,999 ✓ |
| ₹149 ad-free | ₹149 ✓ (or nearest: ₹100 / ₹150 / ₹190) |
| ₹10 / ₹100 / ₹500 / ₹1000 | ₹10 ✓ / ₹100 ✓ / ₹500 ✓ / ₹1000 ✓ |

> **Verify against the live list** in Play Console before creating products —
> prices drift and vary by country. The tiers above are the standard India set
> but the console is authoritative.

---

## 7. Open questions

1. **Price-test strategy** — ship ₹99/₹199 straight, or ₹79/₹149 and inch up?
2. **Annual plans now or later?** Pushing annual early lifts LTV but adds config
   (play-billing + wallet must handle yearly entitlements).
3. **Platform-fee gap too big?** Pro pays 15%, Creator pays 5% — a 10-point gap is
   now the upgrade incentive. If that erodes margin on Creator-heavy sales, narrow
   to Pro 12% / Creator 5% later.
4. **Deposit min** — ₹10 or ₹20? (₹10 is Google's floor but ~15% of it goes to fee.)
5. **Deposit-bonus recycle liability** — confirming the bonus-spend flywheel cost
   (§4) is acceptable before shipping.

---

## 8. Related files

- [wallet.md](wallet.md) — how earnings/deposits/bonus are spent & expire
- [play-billing.md](play-billing.md) — SKU verification, consumables, refunds
- [referrals.md](referrals.md) — where the referral bonus amounts live
- [ads-adfree.md](ads-adfree.md) — the `ad_free` SKU entitlement
- [reference.md](reference.md) — shared env vars (DEPOSIT_MIN_INR, plan config)