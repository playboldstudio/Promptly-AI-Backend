# Promptly AI — Payments & Payouts Architecture (UPI manual settle)

> **Status:** Design doc for the **live** payment flow in this repo
> (`Promptly-AI-Backend`). Simple and UPI-based: **no creator KYC / PAN / bank
> account**, no Razorpay Route / Linked Accounts / RazorpayX for MVP. Subscribed
> users earn, then withdraw to their UPI — an **admin approves the request and
> transfers from the admin's own UPI app**, then marks it paid/failed.
>
> This is the design implemented by `src/services/payments/*`, `src/routes/*` and
> `src/db/models/*`. Match the Android app contract in the `Promptly-AI` repo.
>
> Companion to the repo README's "Money model" section.

## Status

| # | Work item | Sections | Status |
|---|---|---|---|
| 1 | Payout eligibility gates — Pro/Creator subscription, UPI, min, balance, single-active | §4, §6 | ✅ done |
| 2 | Admin role gate on `/payments/admin/*` | §10, §11 | ⏳ pending |
| 3 | Configurable `MIN_WITHDRAWAL_INR` + fee percent | §1, §6 | ⏳ pending |
| 4 | Money-integrity fixes — verify `amountInr`, stop `save_count` bump on purchase, gate `promptText` on `/me/saved` | §5, §9 | ⏳ pending |
| 5 | Android withdraw UI gating | §6 | ⏳ pending |
| 6 | Android earnings/withdrawal status UI | §4, §12 | ⏳ pending |

> ✅ = implemented and committed on `feature/razorpay-payouts` / `feature/ui-prototype`.
> ⏳ = upcoming. Sections not in the table are live backend behavior already.

---

## Color legend

| Color | Actor |
|---|---|
| **BLUE** | Promptly / platform (Android app, Node/Express backend, admin) |
| **GREEN** | Razorpay |
| **PURPLE** | Creator (a subscribed user) |
| **ORANGE** | Customer / normal user |
| **RED** | Failure / error |

---

## 1. Money model (three streams, all Razorpay)

1. **Subscriptions** — user picks **Pro (₹49/mo)** or **Creator (₹99/mo)** and pays
   via Razorpay **Subscriptions** (recurring). Powers posting perks + payout
   eligibility. Backend: `src/services/payments/subscriptions.service.js`.
2. **Paid prompt sales** — a buyer unlocks a creator's prompt via Razorpay
   **Checkout**. Money lands in **Promptly's** account; the creator's share is
   `net = price × (100 − fee%) / 100` (Pro=5% fee, Creator=0%, configurable).
   Backend: `src/services/payments/checkout.service.js`.
3. **Creator payouts** — a **subscribed** creator (Pro/Creator) who reaches the
   withdrawal minimum requests a withdrawal → **admin** transfers from the admin's
   own UPI app to the creator's saved UPI → admin marks it **paid** (or **failed**).
   Backend: `src/services/payments/payouts.service.js`.

Key decisions baked in:

- **No** RazorpayX / Route / Linked Accounts / separate merchant accounts.
- **No** creator KYC, PAN, or bank account — a saved **UPI ID** is the payout
  destination (`POST /me/upi`).
- All money is **integer rupees** (never floats).
- Every credit/debit writes one row to `transactions` (the ledger).
- A payout **reserves** the balance at request time (ledger debit), so the same
  money can't be withdrawn twice; admin marking it paid is final bookkeeping, and
  marking it failed **returns** the reserved balance.

```
Subscriptions  Subscriber ──(₹/mo, Razorpay Subscriptions)──► Platform
Paid prompts   Buyer ──────(₹, Razorpay Checkout)───────────► Platform pool
                                                              │  net = price × (100 − fee%) / 100
                                                              ▼
                                                       Creator balance (ledger)
                                                              │  withdraw (min, via saved UPI)
                                                              ▼  admin transfers via their OWN UPI app
                                                              ▼
                                                       Creator's UPI (paid)
```

---

## 2. Platform setup (what Promptly needs in Razorpay)

```
[BLUE] Promptly Business → [GREEN] Razorpay Business Account (KYC done)
   │
   ├─ Checkout   — works out of the box (payment gateway)
   ├─ Subscriptions — create two plans in the dashboard:
   │      Pro ₹49/mo → RAZORPAY_PLAN_PRO_ID
   │      Creator ₹99/mo → RAZORPAY_PLAN_CREATOR_ID
   ├─ Webhooks   — point at POST /webhooks/razorpay with a real secret
   │
   ├─ TEST keys (rzp_test_*) → backend integration → end-to-end test
   └─ LIVE keys (rzp_live_*) → production
```

> **Not required for MVP:** Route / Linked Accounts / RazorpayX. They add creator
> KYC and business verification — the opposite of this design. Revisit only if you
> later want fully automated payouts without an admin in the loop.
>
> Verify with Razorpay that the subscription billing model fits Promptly's business
> type and current Indian compliance (TDS/GST on creator payments when you scale).

---

## 3. Becoming a subscriber (buyer)

```
[ORANGE] User opens plan screen → taps "Upgrade to Pro/Creator"
[BLUE]  POST /payments/subscriptions { planId: "pro" | "creator" }
[BLUE]  validate plan active + no existing active subscription
[GREEN] create Razorpay subscription → returns short_url
[ORANGE] app opens short_url → user pays the first month
[GREEN] webhook subscription.charged
[BLUE]  verify signature + idempotent dedupe
[BLUE]  activate the UserSubscription row + ledger debit (subscription_payment)
[ORANGE] user is now Pro/Creator (perks + payout eligibility unlocked)
[GREEN] renewals → subscription.charged again → period rolls forward
       cancel/expire → subscription.cancelled / .expired → status flips
```

Routes: `POST /payments/subscriptions` → `src/services/payments/subscriptions.service.js`;
activation from the webhook → `activateSubscription()`.

---

## 4. Creator eligibility (no KYC, no PAN, no bank)

Any user can publish free prompts. To **earn from paid prompts** the account needs:

- **Active paid subscription** (Pro or Creator plan) — unlocks paid posting / lower fees.
- **Saved UPI ID** on the profile (`POST /me/upi`, shape-validated) — the payout
  destination. No document upload, no PAN, no bank-account number.

```
[PURPLE] user becomes a subscribed creator
   │
[BLUE]  save UPI ID on profile (POST /me/upi)  ← THE ONLY payout requirement
   │
[BLUE]  eligibility for withdrawal =
   │        active paid subscription (pro/creator)
   │        + saved valid UPI ID
   │        + available balance ≥ minimum withdrawal
   ▼
[PURPLE] can publish paid prompts → buyers pay → earnings accrue → can withdraw
```

> The UPI ID is **snapshotted onto the payout row at request time**, so the creator
> changing UPI later never redirects a pending payment.
>
> TODO (backend): the current `requestPayout()` checks the saved UPI and balance but
> **hasn't yet gated on an active paid subscription** — add GATE 1 below in
> `src/services/payments/payouts.service.js`.

---

## 5. Paid prompt purchase (example: price ₹50)

```
[ORANGE] User taps "Buy — Cyberpunk Samurai ₹50"
[BLUE]  POST /payments/checkout/order { promptId }
   │    validate paid + published + one-unlock-per-buyer
   │    compute fee from the BUYER's subscription (Pro=5%, Creator=0%)
[GREEN] create Razorpay order (₹50 = 5000 paise)
[ORANGE] user completes Razorpay Checkout
[GREEN] payment captured → ₹50 into PROMPTLY's account (merchant of record)
[BLUE]  POST /payments/checkout/verify → HMAC signature verified server-side
[BLUE]  DB transaction:
   │    prompt_purchases  priceInr=50, platformFeeInr=?, netInr=?
   │    ledger CREDIT creator  net   (earnings)
   │    ledger DEBIT buyer      50   (purchase)
[ORANGE] user gets the prompt unlocked
```

The exact split is backend-configurable (fee percent on the subscription plan).

---

## 6. Withdrawal — request → admin approve → admin transfer → mark paid (min, UPI)

```
[PURPLE] Creator sees Available and taps "Withdraw ₹50"
[BLUE]  GATE 1  active paid subscription (pro/creator)      → else [RED] "Subscriber only"
[BLUE]  GATE 2  saved UPI ID present                       → else [RED] "Add UPI on your profile"
[BLUE]  GATE 3  amount ≥ MIN_WITHDRAWAL_INR (₹60 default)  → else [RED] "Below minimum"
[BLUE]  GATE 4  amount ≤ available balance                 → else [RED] "Insufficient balance"
[BLUE]  GATE 5  no payout already pending/processing        → else [RED] "Already processing"
   │
[BLUE]  DB transaction (all-or-nothing):
   │      create payout (status=PENDING, amountInr, upiId snapshot)
   │      ledger DEBIT amountInr  ← reserves the balance
   ▼
[BLUE] ADMIN review (GET /payments/admin/payouts?status=pending)
   │      shows creator, amount, UPI to pay to
   │
[BLUE] ADMIN transfers the amount via the ADMIN's own UPI app → creator's UPI
   │
   ├── ADMIN marks PAID (POST /payments/admin/payouts/:id/mark-paid)
   │        → payout.status = paid   ✅
   │
   └── ADMIN marks FAILED (POST /payments/admin/payouts/:id/mark-failed)
            → payout.status = failed
            → ledger CREDIT amountInr   ← balance returned, retry allowed
```

- `payout.status`: `pending → paid` (bookkeeping: the money is already reserved in
  the ledger at request time) or `pending → failed` (reservation reversed).
- No Razorpay transfer API and **no webhook** for the payout itself — the admin's
  action is the source of truth.
- ⚠️ Security: `POST /payments/admin/*` is currently gated only by `requireAuth`.
  Add a real admin check before production.

---

## 7. Money flow diagram

```
        [ORANGE] NORMAL USER ────₹ / subscription/checkout────► [GREEN] RAZORPAY
        [PURPLE] Subscribed creator (Pro/Creator, saved UPI)   │
                                                               ▼
                                              [BLUE] PROMPTLY ACCOUNT (pool)
                                                       │
                                    ┌──────────────────┴──────────────────┐
                                    ▼                                     ▼
                     [BLUE] Platform fee (own revenue)      [PURPLE] Creator share (ledger balance)
                                    │                                     │  withdraw request
                                    ▼                                     │
                     Promptly's bank                        [BLUE] Admin approves → transfers
                                                               from ADMIN's own UPI app
                                                               ▼
                                                     [PURPLE] Creator's UPI (paid)
```

| Step | Who pays whom / where money goes |
|---|---|
| Subscription | User → Razorpay → Promptly (recurring) |
| Paid purchase | Buyer → Razorpay Checkout → Promptly pool |
| Split | fee stays with Promptly; net credited to creator ledger |
| Withdrawal | Admin's UPI → Creator's UPI (manual, approved) |

---

## 8. Webhook architecture

```
[ORANGE] Android App ──► [BLUE] Node/Express API ──► [GREEN] Razorpay API
                                                         │
                          [GREEN] Razorpay events ──webhook──► [BLUE] backend (raw body)
                                                                  │  verify HMAC signature
                                                                  │  idempotent log (unique dedupe_key) → replays are no-ops
                                                                  │  dispatch → activate/deactivate subscription, mark sale
                                                                  ▼
[ORANGE] App fetches latest status ◄── GET /me/... (profile, earnings, transactions)
```

Implemented in `src/services/webhooks.service.js` + `src/routes/webhooks.js`
(mounted with `express.raw` in `src/app.js`).

| Event | Action |
|---|---|
| `payment.captured` | verify → unlock purchase + ledger credit (covered by checkout verify too) |
| `subscription.charged` | activate/roll-forward subscription + ledger debit |
| `subscription.cancelled` / `.expired` | deactivate subscription |

**Payouts have no webhook** — they are a manual UPI transfer confirmed by the admin
(no transfer API → no transfer webhooks). The Android app simply re-fetches
`me/earnings` + payout status after the admin acts.

---

## 9. Failure handling

| # | Failure | Design response | State |
|---|---|---|---|
| 1 | Subscription payment failed | no `subscription.charged` → never activated | - |
| 2 | Checkout payment failed | no capture → no unlock, no ledger write | - |
| 3 | Payment captured but webhook delayed | buyer paid but not unlocked → verify endpoint reconciles / Razorpay replays | risk: manual unblock |
| 4 | Creator not subscribed | GATE 1 blocks withdrawal | withdraw rejected |
| 5 | Creator has no UPI / invalid UPI | GATE 2 blocks withdrawal | withdraw rejected |
| 6 | Amount below minimum | GATE 3 | withdraw rejected |
| 7 | Insufficient balance | GATE 4 + re-check inside DB transaction | withdraw rejected |
| 8 | Duplicate withdrawal request | GATE 5 (single active payout) + DB constraint | second request rejected |
| 9 | Admin marks failed | ledger credit returns the reservation | payout failed, retry OK |
| 10 | Admin marks paid by mistake | rejects if not pending; manual correction path | payout paid |
| 11 | Webhook delivered twice | unique `dedupe_key` | replay no-op |
| 12 | Network timeout on request | response may not arrive but state is DB-consistent; retry the request | idempotent |
| 13 | Refund of a paid prompt | platform-side refund; creator's net reversed via ledger (return reservation / net out next earning) | reversal row |

---

## 10. Admin dashboard (reconciliation)

| Section | Columns / KPIs |
|---|---|
| **Creators** | name, email, plan (pro/creator), UPI ID, subscribed since, payout eligibility |
| **Earnings** | total GMV, creator earnings, platform revenue, available balance |
| **Withdrawals** | pending (pay via UPI app) · paid · failed — each with amount, UPI, requestedAt |
| **Transactions** | paymentId/refId · prompt · creator · customer · amount · platform fee · creator share · status |

---

## 11. Compliance / notes (do not hard-code)

- No creator KYC/PAN — the payout destination is a user-supplied UPI ID, so confirm
  Promptly may operate this settlement model under current Indian rules (consult a
  CA / Razorpay on TDS, GST on commission, and UPI-payout liability).
- Keep minimum withdrawal (`MIN_WITHDRAWAL_INR`) and fee percent as backend config.
- **Option to upgrade later:** replace the manual UPI step with RazorpayX Payouts
  (business-verification required) or Route/Linked Accounts (creator KYC required);
  the ledger + status model in this doc ports to either.

---

## 12. One-screen version (hand to the Android developer)

```
 BUYER                     PROMPTLY (Node/Express + Postgres)                    RAZORPAY
 -----                     ---------------------------------                      --------
 Upgrade (₹49/₹99/mo)  -> POST /payments/subscriptions  -> plan short_url -> pay -> subscription.charged
 Buy ₹50 prompt       -> POST /payments/checkout/order  -> order --------> checkout -> captured
   webhook verified; unlock; ledger: creator +net (earnings), fee kept

 CREATOR (Pro/Creator subscriber, saved UPI, NO KYC/PAN)
 --------
 Earnings: Total | Available | Withdrawn | (pending)
    |
    +-- Withdraw ₹50 --> gates: subscribed? UPI saved? min? balance? duplicate?
                           --> payout(pending) + ledger debit (reserve)
   ADMIN: lists pending -> transfers from ADMIN's UPI app -> mark PAID | FAILED
   PAID  -> balances update, "Withdrawal successful"
   FAILED-> ledger credit restores balance, retry allowed

 WHO PAYS WHOM : user -> Promptly (₹49/99/mo, ₹50 per prompt). Creator paid from ADMIN's UPI.
 WHERE MONEY   : subscriptions + purchases land in the Promptly Razorpay account.
 ELIGIBILITY   : active Pro/Creator subscription + saved UPI ID (no PAN/bank/KYC).
 SUCCESS PROOF : payout.status = paid set by admin AFTER the real UPI transfer.
 FAILURES      : failed/duplicate/ineligible blocked by gates + ledger reversal.
```