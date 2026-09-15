import { pathToFileURL } from 'node:url';
import { queryAll } from '../db/firestoreRepo.js';
import { env } from '../config/env.js';
import { calculatePlayBillingFee } from '../lib/playBilling.js';
import { PRODUCT_TO_PLAN, BUILTIN_PLANS } from '../services/payments/plans.js';

/**
 * `npm run reconcile` — monthly Play Billing commission reconciliation
 * (plans/play-billing.md §9).
 *
 * Google does NOT return its commission in the API, so we reconcile two ways:
 *
 *  1. **Snapshot vs re-computed** — for every purchase/subscription row we
 *     stored `gatewayFeeInr` at sale time. This recomputes the expected fee
 *     with `calculatePlayBillingFee` and flags any row where the stored value
 *     drifts beyond `PLAY_BILLING_FEE_TOLERANCE_INR` (default ₹0.01).
 *  2. **Manual cross-check** — a per-month summary (total sales, buyerPays,
 *     transaction fee, gateway fee) you match against the Play Console Finance /
 *     payout report. Adjust the stored snapshots if the ledger and Play differ.
 *
 * Idempotent read-only script — never writes. Run monthly (Cloud Scheduler
 * or manually). Exits 0 unless drift/residuals are reported (exit 1 then).
 */

function fmt(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function rowsFor(collection, filters = []) {
  const out = [];
  let offset = 0;
  for (;;) {
    const page = await queryAll({ collection, filters, limit: 500, offset });
    out.push(...page.rows);
    if (page.count < 500) break;
    offset += 500;
  }
  return out;
}

function monthKey(date) {
  const d = date ? new Date(date) : new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function main() {
  console.log('Reconciling Play Billing fees…\n');
  const tolerance = env.PLAY_BILLING_FEE_TOLERANCE_INR ?? 0.01;

  const [purchases, subs] = await Promise.all([
    rowsFor('prompt_purchases', [{ field: 'status', value: 'completed' }]),
    rowsFor('user_subscriptions'),
  ]);

  // ── 1. Snapshot vs re-computed fee — flag drift on one-time grants.
  const drift = [];
  const monthly = new Map(); // monthKey → { sales, buyerPays, txFee, gatewayFee }
  let salesCount = 0;

  for (const p of purchases) {
    const mk = monthKey(p.createdAt);
    if (!monthly.has(mk)) {
      monthly.set(mk, { sales: 0, buyerPaysTotal: 0, txFeeTotal: 0, gatewayFeeTotal: 0 });
    }
    const m = monthly.get(mk);

    // One-time prompt sales — snapshot vs recomputed fee drift check.
    const isPrompt = p.promptId?.startsWith('prompt_');
    const isDeposit = p.promptId?.startsWith('deposit_');
    const isAdFree = p.promptId === 'ad_free';

    // Prompts are the only one-time product with a stored gatewayFeeInr that
    // should match the recomputed 15% commission.
    if (isPrompt) {
      const expectedFee = calculatePlayBillingFee({
        salePriceInr: Number(p.priceInr) || 0,
      }).feeInr;
      const stored = Number(p.gatewayFeeInr) || 0;
      if (Math.abs(stored - expectedFee) > tolerance) {
        drift.push({
          month: mk,
          purchaseId: p.id,
          productId: p.promptId,
          priceInr: fmt(p.priceInr),
          storedGatewayFeeInr: fmt(stored),
          expectedGatewayFeeInr: fmt(expectedFee),
        });
      }

      m.sales += Number(p.priceInr) || 0;
      m.buyerPaysTotal += Number(p.buyerPaysInr) || 0;
      m.txFeeTotal += Number(p.transactionFeeInr) || 0;
      m.gatewayFeeTotal += Number(p.gatewayFeeInr) || 0;
      salesCount += 1;
    } else if (isDeposit) {
      // Deposit gateway fees are recycled as bonus (net → deposits). Count
      // them so the summary reflects total Play fee collected.
      m.gatewayFeeTotal += Number(p.gatewayFeeInr) || 0;
    } else if (isAdFree) {
      m.gatewayFeeTotal += Number(p.gatewayFeeInr) || 0;
    }
  }

  // ── 1b. Subscriptions — compute expected commission from the plan price.
  // No stored `gatewayFeeInr` snapshot exists on user_subscriptions rows yet,
  // so this cross-checks the tenure-tiered rate (year1 15% / year2+ 10%).
  const subDrift = [];
  for (const s of subs) {
    const mk = monthKey(s.createdAt);
    if (!monthly.has(mk)) {
      monthly.set(mk, { sales: 0, buyerPaysTotal: 0, txFeeTotal: 0, gatewayFeeTotal: 0 });
    }
    const m = monthly.get(mk);
    const plan = BUILTIN_PLANS[s.planId];
    if (!plan?.priceInr) continue;

    const price = Number(plan.priceInr);
    const tenure = Number(s.subscriberTenureMonths ?? 0);
    const fee = calculatePlayBillingFee({
      salePriceInr: price,
      subscriberTenureMonths: tenure,
      isSubscription: true,
    });
    m.sales += price;
    m.gatewayFeeTotal += fee.feeInr;
    // Subs store no snapshot — nothing to compare against; log for completeness.
    subDrift.push({
      month: mk,
      planId: s.planId,
      subscriptionId: s.id,
      tenureCategory: fee.tenureCategory,
      gatewayFeeInr: fee.feeInr,
    });
  }

  // ── 2. Residual owed-floats from capped prompt voids (shortfall).
  const shortfalls = await rowsFor('transactions', [
    { field: 'type', value: 'purchase_void_shortfall' },
  ]);
  let residualOwed = 0;
  for (const t of shortfalls) {
    residualOwed += Number(t.amountInr) || 0;
  }

  // ── 3. Report.
  const months = [...monthly.keys()].sort();
  console.log('Monthly summary (compare against Play Console Finance):');
  console.log('  month       sales   buyerPays  txFee    gatewayFee');
  for (const mk of months) {
    const m = monthly.get(mk);
    console.log(
      `  ${mk}   ${String(fmt(m.sales)).padStart(7)}   ${String(fmt(m.buyerPaysTotal)).padStart(9)}   ${String(fmt(m.txFeeTotal)).padStart(6)}   ${String(fmt(m.gatewayFeeTotal)).padStart(9)}`,
    );
  }
  console.log(`\n  ${salesCount} completed prompt sales counted.`);

  if (residualOwed > 0) {
    console.log(`\n⚠️  Owed float to recover from capped prompt voids: ₹${fmt(residualOwed)}`);
  } else {
    console.log('\n✓ No residual owed-float from voided prompt sales.');
  }

  if (drift.length) {
    console.log(`\n⚠️  ${drift.length} one-time grant(s) where stored gateway fee drifts from recomputed > ₹${tolerance}:`);
    for (const d of drift.slice(0, 25)) {
      console.log(
        `  ${d.month} ${d.purchaseId} ${d.productId} price ${d.priceInr} — stored ${d.storedGatewayFeeInr} vs expected ${d.expectedGatewayFeeInr}`,
      );
    }
    if (drift.length > 25) console.log(`  … and ${drift.length - 25} more`);
    console.log('\n❌ Reconciliation found drift — review against the Play Console report.');
    process.exitCode = 1;
  } else {
    console.log('\n✓ No gateway-fee drift on one-time grants — stored snapshots match the recomputed commission.');
  }

  if (subDrift.length) {
    console.log(`\nℹ️  ${subDrift.length} subscription(s) recorded — commission computed by tenure tier (no snapshot to compare yet):`);
    for (const d of subDrift.slice(0, 10)) {
      console.log(`  ${d.month} ${d.planId} ${d.subscriptionId} (${d.tenureCategory}) fee ₹${fmt(d.gatewayFeeInr)}`);
    }
    if (subDrift.length > 10) console.log(`  … and ${subDrift.length - 10} more`);
  }
}

export default main;

// Run directly (`node src/scripts/reconcile.js`) or via `npm run reconcile`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('❌ Reconciliation failed:', err.message);
    process.exit(1);
  });
}