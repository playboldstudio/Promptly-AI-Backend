# Multi-Balance Wallet — earnings / deposits / bonus + FEFO bonus expiry

> **Phase 2** · Companion: [pricing.md](pricing.md), [play-billing.md](play-billing.md)

## 1. The three balances

| Balance | Source | Withdrawable? | Spend limit | Expires? | Priority |
|---|---|---|---|---|---|
| `earnings` | Paid prompt sales — **gross** (full price) | ✅ (15% Pro / 5% Creator withdrawal fee) | 100% of item price | no | 2 |
| `deposits` | Top-ups (Play Billing), **net after gateway fee** | ❌ | 100% of item price | no | 1 |
| `bonus` | Deposit fee-recycle, referral, rewards, promos | ❌ | **10% max** of item price | **90 days** | 3 |

Read the entitlement reason each balance buys differently:
- **earnings**: withdrawable; creator receives the **full gross** at sale; the
  **15% Pro / 5% Creator withdrawal fee** is the only deduction, applied when the
  creator initiates a payout (see [withdrawals.md](withdrawals.md)). No Play
  Billing commission is ever deducted here.
- **deposits**: user's *own money* — the net after Google's fee (a ₹100 top-up
  credits ₹85). Spend 100%, no expiry.
- **bonus**: *earned or recycled* money (deposit fee-recycle, referral, promo);
  gated by 10%-of-item-price cap + 90-day expiry.

> The **5% buyer transaction fee** on paid prompt purchases is **not a wallet
> balance** — it's app income collected at purchase, never credited to any user's
> `earnings`/`deposits`/`bonus`, and never withdrawable.

> Field names on the wallet doc are fixed scalar buckets, not a map, so a future
> balance type is a **new collection field + a seed default** — not a migration
> of existing docs.

## 2. Config — `src/services/payments/balance-types.js`

```javascript
export const BALANCE_TYPES = {
  earnings: {
    id: 'earnings', withdrawable: true,  maxUsePercent: 100,
    expires: null, notifyBeforeExpiry: null, priority: 2,
    description: 'Earnings from prompt sales',
  },
  deposits: {
    id: 'deposits', withdrawable: false, maxUsePercent: 100,
    expires: null, notifyBeforeExpiry: null, priority: 1,
    description: 'Credits from top-ups',
  },
  bonus: {
    id: 'bonus', withdrawable: false, maxUsePercent: 10,
    expires: 90, notifyBeforeExpiry: 7, priority: 3,
    description: 'Bonus credits from deposit fee-recycle, referrals, rewards, promos',
  },
};

export function getBalanceType(id) { return BALANCE_TYPES[id] ?? null; }
export function isWithdrawable(id) { return BALANCE_TYPES[id]?.withdrawable ?? false; }
export function getMaxUsePercent(id) { return BALANCE_TYPES[id]?.maxUsePercent ?? 0; }
export function getBalanceTypesByPriority() {
  return Object.values(BALANCE_TYPES).sort((a, b) => a.priority - b.priority);
}
```

## 3. Wallet doc & ledger

**`user_wallets` doc** (same id as user):

```javascript
{
  id: userId,
  earnings: 250,
  deposits: 100,
  bonus: 75,
  createdAt: Date,
  updatedAt: Date,
}
```

**Ledger rows** (`transactions` collection) are the **source of truth** — every
credit/debit writes a row with the running balance snapshotted:

```javascript
{
  userId, type, direction, amountInr, balanceAfterInr,
  balanceType: 'bonus',            // which bucket
  refId, note,
  gateway: 'play_billing',         // if a purchase
  platformFeeInr, gatewayFeeInr,   // if a purchase
  createdAt, updatedAt,
}
```

All mutating ops must run inside **Firestore transactions** (use `runTransaction` +
`inTxGet/inTxSet/inTxAdd` — never blind reads/writes).

## 4. Core operations

### 4.1 `getWallet`

```javascript
export async function getWallet(userId) {
  const doc = await findByPk(COLS.userWallets, userId);
  if (!doc) return { userId, balances: zeroBalances(), totalBalanceInr: 0 };
  const balances = {};
  let total = 0;
  for (const [id, cfg] of Object.entries(BALANCE_TYPES)) {
    balances[id] = { amountInr: Number(doc[id] ?? 0), ...cfg };
    total += balances[id].amountInr;
  }
  return { userId, balances, totalBalanceInr: total };
}
```

### 4.2 `creditBalance`

```javascript
export async function creditBalance(userId, balanceType, amountInr, meta = {}) {
  if (!getBalanceType(balanceType)) throw new Error('Unknown balance type');
  if (amountInr <= 0) throw new Error('Amount must be positive');

  return runTransaction(async (tx) => {
    const wallet = (await inTxGet(tx, COLS.userWallets, userId)) ?? {};
    const newBalance = Number(wallet[balanceType] ?? 0) + amountInr;
    inTxSet(tx, COLS.userWallets, userId, { [balanceType]: newBalance, updatedAt: new Date() });
    inTxAdd(tx, COLS.transactions, {
      userId, type: meta.type ?? `${balanceType}_credit`, direction: 'credit',
      amountInr, balanceType, balanceAfterInr: newBalance,
      refId: meta.refId ?? null, note: meta.note ?? `Credited ${balanceType}`,
      createdAt: new Date(), updatedAt: new Date(),
    });
    return { balanceType, amountInr, newBalance };
  });
}
```

### 4.3 `calculatePaymentSplit` — the 10% cap + priority

```javascript
export async function calculatePaymentSplit(userId, itemPriceInr) {
  const wallet = await getWallet(userId);
  const remaining = { value: itemPriceInr };
  const split = [];

  for (const typeCfg of getBalanceTypesByPriority()) {
    if (remaining.value <= 0) break;
    const bal = wallet.balances[typeCfg.id]?.amountInr ?? 0;
    if (bal <= 0) continue;

    const maxFromType = Math.floor(itemPriceInr * (typeCfg.maxUsePercent / 100));
    const use = Math.min(bal, maxFromType, remaining.value);
    if (use > 0) { split.push({ balanceType: typeCfg.id, amountToUse: use }); remaining.value -= use; }
  }

  return {
    split,
    totalCovered: itemPriceInr - remaining.value,
    remaining: remaining.value,
  };
}
```

> **Note:** `bonus` is `priority: 3`, so it's *always spent last* — the user's own
> money (deposits → earnings) is consumed before bonus. That's the intended UX.

### 4.4 `debitBalances`

```javascript
export async function debitBalances(userId, entries, { spendBonusOldestFirst = true } = {}) {
  return runTransaction(async (tx) => {
    const wallet = (await inTxGet(tx, COLS.userWallets, userId)) ?? {};
    const results = [];
    for (const entry of entries) {
      const cur = Number(wallet[entry.balanceType] ?? 0);
      if (cur < entry.amountInr) {
        throw Object.assign(new Error(`Insufficient ${entry.balanceType} balance`),
                            { insufficient: true, balanceType: entry.balanceType });
      }
      const newBall = cur - entry.amountInr;
      inTxSet(tx, COLS.userWallets, userId, { [entry.balanceType]: newBall, updatedAt: new Date() });
      inTxAdd(tx, COLS.transactions, { userId,
        type: entry.meta?.type ?? `${entry.balanceType}_debit`, direction: 'debit',
        amountInr: entry.amountInr, balanceType: entry.balanceType,
        balanceAfterInr: newBall, refId: entry.meta?.refId ?? null,
        note: entry.meta?.note ?? `Debited ${entry.balanceType}`,
        createdAt: new Date(), updatedAt: new Date() });
      results.push({ balanceType: entry.balanceType, debited: entry.amountInr, newBalance: newBall });
    }
    return results;
  });
}
```

### 4.5 ★ Deposit top-up — deduct fee at credit, recycle as bonus

A top-up splits the payment: the **net** goes to `deposits`, the **gateway fee is
recycled as `bonus`** (so the user "feels" full value while the wallet stays
honest). This replaces the old "credit gross ₹100" model.

```javascript
// In wallet.service — the deposit path of POST /payments/playbilling/deposit
export async function handleDepositTopUp({ userId, priceInr, gateway = 'play_billing' }) {
  const feePercent = 15; // Play Billing commission (sole gateway)
  const gatewayFeeInr = Math.round((priceInr * feePercent) / 100);
  const netDeposit = priceInr - gatewayFeeInr;               // what the user actually owns

  return runTransaction(async (tx) => {
    const wallet = (await inTxGet(tx, COLS.userWallets, userId)) ?? {};

    // 1) deposits += net
    const newDeposits = Number(wallet.deposits ?? 0) + netDeposit;
    // 2) bonus += fee, as a 90-day vintage
    const vintageId = `dep_fee_${...}`; // e.g. the deposit tx id
    const vintages = { ...(wallet.bonusVintages ?? {}),
                       [vintageId]: { remaining: gatewayFeeInr, expiresAt: +90d } };
    const newBonus = (sum of vintage remainings);

    inTxSet(tx, COLS.userWallets, userId, {
      deposits: newDeposits,
      bonus: newBonus,
      bonusVintages: vintages,
      updatedAt: new Date(),
    });

    // Two ledger rows, same refId (the deposit tx)
    inTxAdd(tx, COLS.transactions, { userId, type: 'deposit_credit', direction: 'credit',
      balanceType: 'deposits', amountInr: netDeposit, balanceAfterInr: newDeposits,
      gateway, gatewayFeeInr, refId, note: 'Top-up deposit_m — net after fee',
      createdAt: new Date(), updatedAt: new Date() });
    inTxAdd(tx, COLS.transactions, { userId, type: 'deposit_fee_bonus', direction: 'credit',
      balanceType: 'bonus', amountInr: gatewayFeeInr, balanceAfterInr: newBonus,
      refId, note: 'Gateway fee recycled as bonus', createdAt: new Date(), updatedAt: new Date() });
  });
}
```

> **Balance invariant:** `wallet.bonus` ≡ Σ `bonusVintages[].remaining` — the
> deposit recycle creates a vintage just like any other bonus credit, so FEFO
> spend + expiry (below) apply identically.

### 4.6 Refund of a top-up (deposit credits)

When a top-up is refunded/voided (see [play-billing.md](play-billing.md) §7):

```javascript
// Refund the NET back out of deposits; the recycled bonus comes back too.
// (The user never "owns" the bonus, so no bonus refund is owed — it's just
//  removed from its vintage so it can't be spent.)
export async function refundDeposit({ userId, netDeposit, vintageId }) {
  return runTransaction((tx) => {
    const w = inTxGet(tx, COLS.userWallets, userId);
    w.deposits -= netDeposit;
    delete w.bonusVintages[vintageId];
    w.bonus = sumRemaining(w.bonusVintages);
    inTxSet(tx, COLS.userWallets, userId, { ...w, updatedAt: new Date() });
    inTxAdd(tx, COLS.transactions, { userId, type: 'deposit_refund', direction: 'debit',
      balanceType: 'deposits', amountInr: netDeposit, refId: vintageId, ... });
  });
}
```

---

## 5. ★ FEFO bonus expiry (the fix for the old design)

The origin plan's `checkBonusExpiry()` **summed whole credits and never actually
debited** — and it ignored *partially spent* bonus. The 90-day window is
**per-credit**, so expiry must track per-credit remaining amounts and debits must
**spend oldest credits first**.

### 5.1 Per-credit tracking

Instead of a single `bonus` scalar, track bonus as **expiring sub-balances** in a
`wallet.bonusVintages` map — keyed by credit id, holding the *remaining* amount
and its expiry:

```javascript
// On the wallet doc:
{
  ...balances,
  bonusVintages: {
    'ref_ABC123': { remaining: 40, expiresAt: '2026-12-01T00:00:00Z' },
    'ref_DEF456': { remaining: 25, expiresAt: '2027-01-15T00:00:00Z' },
  },
}
```

`bonus` (the spendable scalar) = **sum of all `remaining`** — always consistent
with the vintages.

### 5.2 Spend bonus oldest-first (FEFO)

When `debitBalances` debits `bonus`:

```javascript
function consumeBonus(tx, wallet, amountInr) {
  // Bonus spends oldest-expiring credits first.
  const vintages = Object.entries(wallet.bonusVintages ?? {})
    .sort((a, b) => new Date(a[1].expiresAt) - new Date(b[1].expiresAt));
  let toConsume = amountInr;
  const consumed = [];
  for (const [id, v] of vintages) {
    if (toConsume <= 0) break;
    const take = Math.min(v.remaining, toConsume);
    v.remaining -= take;
    toConsume -= take;
    consumed.push({ id, amount: take });
    if (v.remaining === 0) delete wallet.bonusVintages[id];
  }
  // Vintages before a change must be re-saved; the tx must re-set the wallet doc.
  inTxSet(tx, COLS.userWallets, wallet.id, { bonusVintages: wallet.bonusVintages, updatedAt: new Date() });
  return consumed;
}
```

### 5.3 Expiry sweep — daily

```javascript
// Cloud Scheduler → daily run over all wallets with bonusVintages
export async function expireBonusVintages() {
  const now = Date.now();
  // query wallets having bonusVintages
  for (const wallet of wallets) {
    for (const [id, v] of Object.entries(wallet.bonusVintages ?? {})) {
      if (new Date(v.expiresAt) > now) continue;
      // Expired — debit the remaining amount.
      await runTransaction((tx) => {
        const w = inTxGet(tx, COLS.userWallets, wallet.id);
        const already = w.bonusVintages[id];
        if (!already) return; // already handled — idempotent
        delete w.bonusVintages[id];
        inTxSet(tx, COLS.userWallets, wallet.id, { bonusVintages: w.bonusVintages, updatedAt: new Date() });
        inTxAdd(tx, COLS.transactions, {
          userId: wallet.id, type: 'bonus_expired', direction: 'debit',
          amountInr: already.remaining, balanceType: 'bonus',
          balanceAfterInr: bonusAfter(w, already.remaining),
          refId: id, note: `Bonus ${id} expired`, createdAt: new Date(), updatedAt: new Date(),
        });
      });
    }
  }
}
```

> This **actually removes the expired money** (the origin plan never did) and
> handles partial spend correctly.

### 5.4 Expiry reminder

```javascript
// Checks bonus credits within 7 days of expiry, per user.
export async function notifyBonusExpirySoon(userId) {
  const wallet = await getWallet(userId);
  const expiring = Object.entries(wallet.bonusVintages ?? {})
    .filter(([, v]) => {
      const days = (new Date(v.expiresAt) - Date.now()) / 86_400_000;
      return days > 0 && days <= 7;
    })
    .map(([id, v]) => ({ id, amount: v.remaining, expiresAt: v.expiresAt }));
  // → push notification: "🎁 Your ₹X bonus expires in N days. Use it before it's gone!"
  return { expiring };
}
```

**Key**: The expiry sweep vintages **independent of the spend scalar** — so
previously-spent bonus isn't marked as expired (the old bug).

---

## 6. Migration from `user_balances`

```javascript
// One-time migration: for each user_balances.balanceInr → seed the wallet doc.
//  - balanceInr → deposits (closest to user's own money)
//  - no bonus/earnings history from old system
export async function migrateBalances() {
  const old = await queryAll({ collection: 'user_balances' });
  for (const { userId, balanceInr } of old.rows) {
    await upsert(COLS.userWallets, userId, {
      deposits: balanceInr, earnings: 0, bonus: 0, bonusVintages: {},
      createdAt: new Date(), updatedAt: new Date(),
    });
  }
}
```

> If old balances were *earnings* (creator payouts), map to `earnings` instead.
> Decide per your existing deployment semantics.
>
> **Deposit-model migration:** existing gross deposits stay as-is (don't claw back
> the already-credited ₹15/₹100). Only **new** top-ups use the net + fee-recycle
> model. No data backfill needed — the split is forward-only.

## 7. Env vars

```bash
DEPOSIT_MIN_INR=10          # (or 20 if you fear micro-deposit fees)
DEPOSIT_MAX_INR=10000
BONUS_EXPIRY_DAYS=90
BONUS_EXPIRY_REMINDER_DAYS=7
```

## 8. Implementation order

```
[ ] balance-types.js + BALANCE_TYPES
[ ] wallet.service.js (get/credit/debit/split) in Firestore txs
[ ] user_wallets collection + migration from user_balances
[ ] GET /wallet
[ ] wire checkout + subscriptions to wallet splits
[ ] FEFO vintages (bonusVintages) + consumeBonus in debitBalances
[ ] expiry sweep (Cloud Scheduler) + reminder notification
[ ] deposit top-up split (net → deposits, fee → bonus vintage)  ★
[ ] refund/void debit paths from play-billing (incl. deposit refund §4.6)
```

## 9. Open questions

1. **Migration semantics** — the old single `balanceInr` → deposits or earnings?
   (Affects withdrawal backward-compat.)
2. **Negative positions** — after a refund, can a wallet bucket go negative, or
   must we block redemptions until recovered? (Recommendation: block spend on
   over-credited deposits to keep balances honest.)

## 10. Related

- [pricing.md](pricing.md) — deposit vs bonus funnels §4, §5
- [play-billing.md](play-billing.md) — grant/void wiring (§5.1, §7)
- [withdrawals.md](withdrawals.md) — earnings withdrawal
- [reference.md](reference.md) — `transactions` schema, indexes, env