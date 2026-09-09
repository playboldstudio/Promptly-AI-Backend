# Withdrawal Fee Model

> **Phase 4** · Companion: [wallet.md](wallet.md) (earnings), [play-billing.md](play-billing.md) (fee calc + reconciliation)

## 1. The model — two separate fees (neither is Play Billing's commission)

There are **two fees**, charged to two different parties at two different
moments. They are **separate** and never share a calculation.

| Fee | Who pays | When | Amount |
|---|---|---|---|
| **Transaction fee** | **Buyer** (in-app) | At purchase | **5% of prompt price** → paid to the app |
| **Withdrawal (platform) fee** | **Creator** (seller) | At withdrawal | **15%** (Pro seller) / **5%** (Creator seller) |

Play Billing's ~15% commission on the collected payment is **Google's cut** —
settled at payment time, absorbed by the platform as cost of revenue. It is
**never deducted** from the creator (or the buyer) again at withdrawal.

```
BUY (real-time):
  Buyer pays ₹99 + 5% = ₹103.95 via Play Billing
  Google takes ₹15.59 (15%)      ← platform's cost of payment, settled at payment time
  Transaction fee to app: ₹4.95  ← app income (a fee — the buyer can NEVER withdraw it)
  Creator credited: ₹99.00 (gross) ← creator's "earnings" balance = full prompt price

WITHDRAWAL (initiated by creator):
  Creator requests: ₹99.00  (earnings balance, gross)
  Platform/withdrawal fee: ₹14.85 (15% Pro seller)  |  ₹4.95 (5% Creator seller)
  Play Billing commission deduction: ₹0   ← already absorbed by the platform
  Net payout to creator: ₹84.15 (Pro seller)  |  ₹94.05 (Creator seller)
```

## 2. Withdrawal formula

```javascript
// Withdrawal deducts ONLY the seller's platform fee. No gateway fee —
// Play Billing's commission is absorbed by the platform at payment time.
// The 5% buyer transaction fee was collected at purchase and is app income,
// not part of this balance.
// BUILT: src/services/payments/withdrawal-fees.js (pure, unit-tested)
//   + used by payouts.service.js at request + eligibility preview.
export function calculateWithdrawal({ earningsBalance, platformFeePercent }) {
  const platformFeeInr = Math.round((earningsBalance * platformFeePercent) / 100);
  const netPayout = earningsBalance - platformFeeInr;
  return { earningsBalance, platformFeePercent, platformFeeInr, netPayout };
}
```

## 3. Flow

```
Creator taps "Withdraw"
  → GET /payments/payouts/eligibility
       → { earnings, platformFeePercent, platformFeeInr, minWithdrawalInr, netIfWithdrawNow }
  → POST /payments/payouts
       → { earnings, platformFeeInr, netPayout, upi/bank }
  → Admin settles (manual bank transfer) — existing back-office
  → payout marked settled in ledger
```

**Show the fee breakdown BEFORE the creator commits** — this addresses the
"unsafe" concern by making the math transparent, not hidden:

```
Withdrawable earnings:          ₹1,000.00   (gross sales, per your plan)
Platform fee deduction:           ₹150.00   (15% Pro seller) / ₹50.00 (5% Creator)
Net you receive:                  ₹  850.00 / ₹  950.00
```

## 4. Gateway fee accounting (tracking, NOT deducted at withdrawal)

The Play Billing commission is **not deducted at withdrawal** — Google takes
it from the collected payment before it reaches the platform. We still store
it for reconciliation and bookkeeping:

- **Per-sale** `gatewayFeeInr` stored on `prompt_purchases` at grant time
  (calculated via [play-billing.md](play-billing.md) §4 `calculatePlayBillingFee`).
- **Not used at withdrawal** — it's the *platform's* cost, already paid. Only the
  seller's platform fee (15%/5%) is deducted at withdrawal.
- **Reconciliation** (run monthly): compare calculated vs Play Console reports,
  adjust if diff > `PLAY_BILLING_FEE_TOLERANCE_INR` (₹0.01), set
  `gatewayFeeSource: 'reconciled'`.

```javascript
export async function reconcilePlayBillingFees({ reportData }) {
  const adjustments = [];
  for (const order of reportData) {
    const purchase = await findPurchaseByOrderId(order.orderId);
    if (!purchase) continue;
    const actualFeeInr = order.commission / 100;      // Google reports paise
    const diff = Math.abs(actualFeeInr - purchase.gatewayFeeInr);
    if (diff > env.PLAY_BILLING_FEE_TOLERANCE_INR) {
      await update(COLS.promptPurchases, purchase.id, {
        gatewayFeeInr: actualFeeInr, gatewayFeeSource: 'reconciled', reconciledAt: new Date(),
      });
      adjustments.push({ orderId: order.orderId, diff: actualFeeInr - purchase.gatewayFeeInr });
    }
  }
  return { adjustments, totalAdjusted: adjustments.length };
}
```

## 5. Transaction fee vs withdrawal fee vs gateway fee

**Three fees, three parties, never confused:**

| Fee | Who pays | When | Adder |
|---|---|---|---|
| **Transaction fee** | **Buyer** | At purchase (in-app) | **5%** of prompt price → **app income** (not credited to any user, not withdrawable) |
| **Withdrawal (platform) fee** | **Creator** | When they initiate withdrawal | **15%** (Pro seller) / **5%** (Creator seller) |
| **Gateway fee (Play Billing ~15%)** | **Platform** | At payment time | Absorbed by the platform — **never** deducted from creator or buyer |

All three are tracked on `prompt_purchases` for reconciliation, but only the
**withdrawal/platform fee** affects the creator's payout. The transaction fee is
app income. The gateway fee is informational (audit trail + monthly
reconciliation).

> **Note:** the deposit-side *gateway fee* is handled **differently** — it's deducted
> at credit time and recycled to bonus (not at payout). Creator sales and user
> top-ups **both** keep the gateway fee out of withdrawal; only the deposit flow
> converts it to bonus. See [wallet.md](wallet.md) §4.5.

## 6. Env vars

```bash
MIN_WITHDRAWAL_INR=60                # existing
PLAY_BILLING_FEE_TOLERANCE_INR=0.01  # reconciliation tolerance
```

## 7. Edge cases

- **Refunded sale already paid out** — the creator's negative float against future
  earnings (capped at the withdrawal fee already collected on the refunded sale).
  See [play-billing.md](play-billing.md) §7.
- **Single gateway (Play Billing)** — all sales absorb the same ~15% gateway fee.
  Platform/withdrawal fee (15%/5%) applies uniformly; the gateway fee is never
  deducted at payout.
- **No withdrawal for a long time** — earnings balance is full gross; the
  eligibility call previews the platform-fee deduction so the amount is never
  misleading.

## 8. Related

- [wallet.md](wallet.md) — earnings credit/debit + FEFO
- [play-billing.md](play-billing.md) — fee calc + RTDN + refund/void
- [reference.md](reference.md) — payout endpoints, `prompt_purchases` schema