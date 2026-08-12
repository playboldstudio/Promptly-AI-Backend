# Promptly AI — Creator Payments & Payouts Architecture

> **Status:** Design document for the creator payout flow using **Razorpay Route /
> Linked Accounts**. This replaces the current manual-settle (UPI + admin bank
> transfer) model so creators are represented through Razorpay's supported
> marketplace/Linked Account flow, not as raw bank-detail recipients.
>
> Companion to `DATABASE_SCHEMA.md` and the Android `Promptly-AI` repo.

---

## Color legend

| Color | Actor |
|---|---|
| **BLUE** | Promptly / platform (Android app, Node/Express backend, admin) |
| **GREEN** | Razorpay |
| **PURPLE** | Creator |
| **ORANGE** | Customer / normal user |
| **RED** | Failure / error |

---

## 1. Platform setup

```
[BLUE] Promptly Business
   └─ owns the PRIMARY Razorpay account (merchant of record)

[GREEN] Razorpay Business Account
   └─ Complete Razorpay KYC/onboarding for Promptly (business entity)
   └─ ENABLE PRODUCT: Route / Linked Accounts (marketplace payouts)
        │
        │  An ordinary Payment Gateway account does NOT automatically include
        │  marketplace payouts. Route/Linked-Account access is product-gated and
        │  depends on Promptly's business type & eligibility.
        │  => VERIFY WITH RAZORPAY before implementation.
        │
   └─ Configure settlement model (T+0/T+1, on-hold window, optional profit sharing)
   └─ Generate TEST API keys (rzp_test_*)
   └─ Create Pro / Creator subscription plans (already in backend seed)

[BLUE] Backend integration (this repo)
   └─ Test Mode (test orders, test linked accounts, ngrok/tunnel for webhooks)
        │  Successful end-to-end test
        ▼
   └─ LIVE API keys (rzp_live_*) + real webhook secret + PUBLIC_BASE_URL
        ▼
   PRODUCTION
```

---

## 2. Creator onboarding

```
[PURPLE] Normal user taps "Become a Creator"
   │
[BLUE] Accept Creator Terms
   │
[BLUE] Creator Profile setup
   │
   ▼
[BLUE] Start payout onboarding
   │
[GREEN] CREATE LINKED ACCOUNT (type = route)
   │   legal_info (name / PAN), contact info, bank account / VPA
   │   Razorpay auto-creates Contact + Fund Account
   │
[GREEN] Creator completes Razorpay KYC / verification
   │   (email/SMS onboarding link - individual vs business docs)
   │
   ├─[GREEN] status: pending -> active (verified) ───────────────► ELIGIBLE
   │
   └─[RED]   rejected / suspended / inactive
              │  block withdrawals; allow re-submission / re-KYC
   │
[BLUE] Backend syncs onboarding state
   │   (poll linked-account status + subscribe to linked-account webhooks)
   │
[BLUE] Persist on the creator row:
   │   razorpay_linked_account_id, fund_account_id,
   │   onboarding_status (none|pending|verified|rejected|suspended),
   │   payout_status (eligible|blocked)
   │
   ▼
[PURPLE] Creator can now receive earnings + request withdrawals
```

The creator is **not** a separate merchant, never handles Razorpay funds directly
for sales, and Promptly never manually transfers bank details. Every payout is a
Razorpay transfer to the creator's Linked Account, which settles to their bank.

---

## 3. Paid prompt purchase (example: price ₹50)

```
[ORANGE] User taps "Buy - Cyberpunk Samurai ₹50"
   │
[BLUE]  POST /payments/checkout/order { promptId }
   │   validates paid + published, rejects duplicate purchase
   │   computes split with a CONFIGURABLE commission (e.g. 20%)
   │   creates a Razorpay ORDER (₹50 = 5000 paise)
   ▼
[GREEN] Razorpay Order created
   │
[ORANGE] User completes Razorpay Checkout (UPI / card / netbanking)
   ▼
[GREEN] PAYMENT CAPTURED -> ₹50 lands in PROMPTLY's balance (merchant of record)
   │   ("Where does the money initially go?" -> Promptly primary account, NOT creator)
   │
   ├──> [GREEN] Webhook `payment.captured` -> [BLUE] backend
   │        verify HMAC signature -> idempotent dedupe -> handle
   │
[BLUE] Unlock prompt for buyer (prompt text returned)
[BLUE] Write DB rows (one transaction):
   │   prompt_purchases (status=completed, priceInr=50, platformFeeInr=10, netInr=40)
   │   ledger CREDIT creator  ₹40   status=PENDING       (earnings)
   │   platform fee ₹10 recorded separately (stays in platform balance)
   │
[ORANGE] User gets the prompt
```

Money split (configurable commission percent in env/backend config):
- Creator share: **₹40 -> PENDING earnings**
- Platform fee: **₹10 -> Promptly revenue** (settles to Promptly's own bank like a normal merchant settlement)

---

## 4. Creator earnings ledger

Do not treat PENDING as pay-out-able money. Internal state machine per earning row:

```
PENDING  --(hold/settle window, configurable e.g. T+7 / on_hold_until)-->  AVAILABLE
                              (in Option B: purely date-driven)
AVAILABLE --(withdrawal request + successful Razorpay transfer)-->  WITHDRAWN
```

Creator dashboard (extends the existing `/me/earnings` contract in
`src/services/earnings.service.js`):

| Field | Meaning |
|---|---|
| **Total Earnings** | Sum of creator share of completed sales (lifetime) |
| **Pending Earnings** | share inside the hold window / awaiting settlement |
| **Available Balance** | settled minus reserved withdrawals |
| **Withdrawn** | sum of successfully settled transfers |
| **Lifetime Earnings** | Available + Withdrawn (+ in-flight processing) |

Schema guidance over the draft (integer rupees, status machines only):

| Entity | Fields to add / use |
|---|---|
| `users` | `razorpay_linked_account_id`, `fund_account_id`, `onboarding_status`, `payout_status` |
| `prompt_purchases` (acts as `CreatorTransaction`) | freeze `price_inr`, `platform_fee_inr`, `net_inr` at sale; add `earning_status` (pending\|available\|withdrawn\|reversed) |
| `transactions` | authoritative ledger (already exists) |
| `payouts` (acts as `CreatorWithdrawal`) | add `razorpay_transfer_id`, `on_hold`, `hold_until`, `transfer_status`, `settlement_id`, `processed_at` |

---

## 5. Minimum withdrawal (Available ₹135, min ₹100)

```
[PURPLE] Creator taps "Withdraw ₹135"
   │
[BLUE]  GATE 1  availableBalance >= MIN_WITHDRAWAL_INR (₹100)        -> else [RED] "Below minimum"
[BLUE]  GATE 2  amount <= availableBalance                           -> else [RED] "Insufficient balance"
[BLUE]  GATE 3  onboarding_status = verified & linked account ACTIVE -> else [RED] "Finish KYC first"
[BLUE]  GATE 4  no payout already pending/processing (idempotency)   -> else [RED] "Already processing"
   │
[BLUE]  DB TRANSACTION (all-or-nothing):
   │     create payout (status=PENDING, amountInr=135)
   │     ledger DEBIT ₹135 (reserves the balance)
   │
   ▼
[GREEN] POST /v1/transfers { account_id: <linked_account>, amount: 13500, notes: { payoutId } }
   │   returns transfer_id - ACCEPT, not SUCCESS
   │
[BLUE]  save razorpay_transfer_id; payout.status = PROCESSING
   │
[GREEN] async pipeline: transfer.created -> transfer.processing -> transfer.processed (settled)
   │
   ├──[GREEN] webhook `transfer.processed` -> [BLUE] verify signature + dedupe
   │        payout.status = PAID/SUCCESS; processedAt = now        -> [PURPLE] "Withdrawal Successful"
   │
   └──[RED] webhook `transfer.failed` / `transfer.reversed`
             payout.status = FAILED
             ledger CREDIT ₹135 (returns reservation)              -> balance restored, retry allowed
```

`MIN_WITHDRAWAL_INR` is backend-configurable (project uses ₹100; increase the current
₹60 value used by the manual-settle flow in `src/services/payments/payouts.service.js`).

---

## 6. Automatic vs manual payout — recommendation

| | **Option A - auto-transfer at purchase** | **Option B - accumulate + withdraw on demand** |
|---|---|---|
| When transfer happens | at sale (`on_hold`), auto-release T+N | only when the creator withdraws |
| Movement | per-sale transfer + on-hold toggle + release | one transfer per withdrawal |
| Refund story | creator money may already be moving -> recover from hold/reversal | money still in platform balance -> refund purely platform-side |
| Webhooks / edge cases | many (per sale) | few (only withdrawals) |
| Complexity | higher | lower |
| Fits existing code | needs checkout rewrite | maps to current `payouts` service (replace manual settle with transfer + webhook) |

> **Recommendation for MVP: Option B.** Money is retained correctly in the Promptly
> primary account (no payout risk on a later-refunded sale), failure handling is one
> repeated pattern, and it matches the ledger already built. Move to Option A (with
> per-sale `on_hold`) later for better creator UX.

---

## 7. Money flow diagram

```
           [ORANGE] NORMAL USER
                │   ₹50 via Razorpay Checkout
                ▼
            [GREEN] RAZORPAY  --payment.captured--> [BLUE] PROMPTLY PRIMARY ACCOUNT
                                                        │  money lands HERE first (merchant of record)
                                                        │  ₹50 in platform balance
                                                        │
                                    ┌───────────────────┴────────────────────┐
                                    ▼                                        ▼
                     [BLUE] Promptly fee ₹10                     [PURPLE] Creator share ₹40
                     (settles to Promptly's own                     │
                     bank like normal merchant)                     ▼
                                                            [GREEN] Creator's LINKED ACCOUNT
                                                                     │  settles per linked-account config
                                                                     ▼
                                                                  Creator's Bank
```

Exact movement depends on the Route / Linked-Account configuration: `on_hold` vs
instant release, settlement schedules, and whether Razorpay **Profit Sharing** is
enabled (auto-split) or Promptly does the split implicitly (recommended for MVP:
platform keeps the fee, transfer only the creator share at withdrawal).

---

## 8. Webhook architecture

```
[ORANGE] Android App ---> [BLUE] Node/Express API ---> [GREEN] Razorpay API
                                                           │
                                     [GREEN] Razorpay events --webhook--> [BLUE] backend (raw body)
                                                                           │  verify HMAC signature
                                                                           │  idempotent log (unique dedupe_key) -> replays are no-ops
                                                                           │  dispatch by event -> DB update
                                                                           │  (purchases, ledger, payouts, earnings)
                                                                           ▼
[ORANGE] App fetches latest status  <--------  [BLUE] GET /me/... (status)
```

Events to handle (exact names to verify in the current Razorpay docs; this repo's
`src/services/webhooks.service.js` already implements signature verification +
dedupe + dispatch, extend the dispatch table):

| Event | Action |
|---|---|
| `payment.failed` | nothing to credit |
| `payment.captured` | unlock prompt + write earnings ledger (PENDING) |
| `transfer.created` / `processing` | payout state = PROCESSING |
| `transfer.processed` | payout = PAID / SUCCESS |
| `transfer.failed` / `reversed` | payout = FAILED, reverse the reservation |
| `refund.*` / payment `reversed` | open refund flow; reverse / redact creator earnings |
| `linked_account.*` onboarding events | refresh creator eligibility |

**Rule:** success is set **only** when the transfer reaches `processed` / settled via
webhook — never when `transfer.create` merely returns an ID.

---

## 9. Failure handling

| # | Failure | Design response | State |
|---|---|---|---|
| 1 | Customer payment failed | no `captured` webhook -> nothing written | - |
| 2 | Captured but webhook delayed | reconcile (poll `/payments/:id`, retry queue) | purchase pending |
| 3 | Creator onboarding incomplete | GATE 3 blocks withdrawal | withdraw rejected |
| 4 | Creator account not eligible | `payout_status = blocked`, prompt back-office | withdraw rejected |
| 5 | Transfer failed | credit ledger back (reserve released), allow retry | payout FAILED |
| 6 | Insufficient balance | GATE 2 + re-check inside the DB transaction | withdraw rejected |
| 7 | Duplicate withdrawal | GATE 4 + single active-withdrawal per creator | second request rejected |
| 8 | Network timeout | transfer may have succeeded -> idempotency key / re-fetch transfer by ID; never double-create | payout PROCESSING |
| 9 | Webhook delivered twice | unique `dedupe_key` (already built) | replay no-op |
| 10 | Refund after creator transfer | hold window absorbs it; past that, net out from next earnings | reversal row |
| 11 | Reversal | `transfer.reversed` webhook -> mark payout reversed, restore ledger | REVERSED |

Withdrawal request guard (idempotency chain):

```
REQUEST -> existing pending/processing? --yes--> reject
   no -> create payout(pending) + ledger debit -> transfer.create -> store transfer_id -> await webhook -> final status
```

---

## 10. Admin dashboard (reconciliation)

| Section | Columns / KPIs |
|---|---|
| **Creators** | name, creatorId, linkedAccountId, onboarding status, payout status |
| **Earnings** | Total GMV, creator earnings, platform revenue, pending, available |
| **Withdrawals** | pending · processing · successful · failed · reversed (with retry action) |
| **Transactions** | paymentId · prompt · creator · customer · amount · platform fee · creator share · transferId · status |

---

## 11. Compliance box (do not hard-code)

- Route / Linked-Account access is **not automatic** — verify eligibility / enablement
  for Promptly's business type with Razorpay **before** building.
- Creator KYC, onboarding document lists, individual-vs-company requirements,
  TDS/GST handling on creator payouts, and settlement minima: **verify with Razorpay
  and your CA** for current Indian compliance. Keep everything configurable, not
  asserted in code.

---

## 12. One-screen version (hand to the Android developer)

```
 CUSTOMER                PROMPTLY (Node/Express + Postgres)                RAZORPAY
 -----------------       ---------------------------------                  --------------
 Buy ₹50 prompt -> POST /payments/checkout/order -> Order -> user pays -> PAYMENT CAPTURED
                                                                   ^                    | ₹50 -> PROMPTLY account
                       verify webhook <-- payment.captured <--------|
                       unlock prompt; ledger: creator +₹40 (PENDING), fee +₹10
 CREATOR
 --------
 Dashboard: Total | Pending | Available | Withdrawn
      |
      +-- Withdraw ₹135 --> checks: min ₹100? balance? KYC active? no duplicate?
                            --> payout(pending) + ledger debit
                            --> POST /transfers { linked_account } --> transfer_id (NOT success)
                            --> webhook transfer.processed --> payout = PAID
                            --> webhook transfer.failed    --> balance restored, retry
 ADMIN: creators · earnings · withdrawals · transactions (all reconcile-able)

 WHO PAYS WHOM : customer -> Promptly (₹50). Promptly -> creator's Linked Account (₹40) only via withdrawal.
 WHERE MONEY   : initially goes to the Promptly primary Razorpay account.
 CREATOR ELIGIBILITY : Razorpay Linked Account verified (KYC) -> payout_status eligible.
 SUCCESS PROOF: transfer.processed webhook (never the transfer-API accept).
 FAILURES     : transfer failed/reversed -> ledger reservation reversed -> retry.
```