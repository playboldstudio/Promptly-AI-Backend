import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSplitFromBalances } from '../src/services/wallet.service.js';

function balances(overrides = {}) {
  return {
    earnings: { amountInr: 0 },
    deposits: { amountInr: 0 },
    bonus: { amountInr: 0 },
    ...Object.fromEntries(
      Object.entries(overrides).map(([k, v]) => [k, { amountInr: v }]),
    ),
  };
}

test('wallet-spend: deposits are spent before earnings before bonus (priority order)', () => {
  const split = calculateSplitFromBalances(
    balances({ deposits: 50, earnings: 30, bonus: 20 }),
    90,
  );
  assert.deepEqual(split.split, [
    { balanceType: 'deposits', amountToUse: 50 },
    { balanceType: 'earnings', amountToUse: 30 },
    { balanceType: 'bonus', amountToUse: 9 }, // 10% cap of 90
  ]);
});

test('wallet-spend: bonus is capped at 10% of item price', () => {
  const split = calculateSplitFromBalances(
    balances({ deposits: 0, earnings: 0, bonus: 200 }),
    100,
  );
  assert.deepEqual(split.split, [{ balanceType: 'bonus', amountToUse: 10 }]); // min(200, 10, 100)
  assert.equal(split.totalCovered, 10);
  assert.equal(split.remaining, 90);
});

test('wallet-spend: full coverage when balances exceed price (totalCovered = price, remaining 0)', () => {
  const split = calculateSplitFromBalances(
    balances({ deposits: 100, earnings: 100, bonus: 100 }),
    80,
  );
  assert.deepEqual(split.split, [
    { balanceType: 'deposits', amountToUse: 80 },
  ]);
  assert.equal(split.totalCovered, 80);
  assert.equal(split.remaining, 0);
});

test('wallet-spend: empty wallet → zero split, full residual', () => {
  const split = calculateSplitFromBalances(balances(), 99);
  assert.deepEqual(split.split, []);
  assert.equal(split.totalCovered, 0);
  assert.equal(split.remaining, 99);
});

test('wallet-spend: only unused balance types appear in the split (deposits exhausted, earnings covers rest)', () => {
  const split = calculateSplitFromBalances(
    balances({ deposits: 30, earnings: 70, bonus: 0 }),
    100,
  );
  assert.deepEqual(split.split, [
    { balanceType: 'deposits', amountToUse: 30 },
    { balanceType: 'earnings', amountToUse: 70 },
  ]);
  assert.equal(split.totalCovered, 100);
  assert.equal(split.remaining, 0);
});

test('wallet-buy: a full price is fully covered when balances exceed it (no Play Billing residual)', () => {
  // Mirrors what buyPromptWithWallet's coverage guard checks: totalCovered ≥ price.
  const split = calculateSplitFromBalances(
    balances({ deposits: 100 }),
    60,
  );
  assert.equal(split.totalCovered, 60);
  assert.equal(split.remaining, 0);
  assert.equal(split.split.some((s) => s.balanceType === 'bonus'), false);
});

test('wallet-buy: an empty wallet yields the full shortfall (drives the Top-up path)', () => {
  const split = calculateSplitFromBalances(balances(), 60);
  assert.equal(split.totalCovered, 0);
  assert.equal(split.remaining, 60); // the gap the UI shows as "Top up ₹60"
});

test('wallet-buy: wallet must cover price + 5% fee (totalDue = price × 1.05)', () => {
  // Price ₹60 → buyer pays ₹63. A ₹60 wallet can't cover the total due.
  const price = 60;
  const totalDue = Math.round(price * 1.05 * 100) / 100; // 63
  const split = calculateSplitFromBalances(balances({ deposits: 60 }), totalDue);
  assert.equal(split.totalCovered, 60);
  assert.equal(split.remaining, 3); // shortfall vs totalDue (fee not covered)
});

test('wallet-buy: full cover when balances exceed price + fee (bonus capped on totalDue)', () => {
  // Price ₹100 → totalDue ₹105. Deposits cover it fully.
  const price = 100;
  const totalDue = Math.round(price * 1.05 * 100) / 100; // 105
  const split = calculateSplitFromBalances(balances({ deposits: 200 }), totalDue);
  assert.deepEqual(split.split, [{ balanceType: 'deposits', amountToUse: 105 }]);
  assert.equal(split.totalCovered, 105);
  assert.equal(split.remaining, 0);
});

test('wallet-buy: bonus cap applies to totalDue, not the raw price', () => {
  // Price ₹100 → totalDue ₹105. Bonus is capped at 10% OF THE TOTAL (₹10.5),
  // same FEFO/percent rule as any purchase — never more than 10% of what's due.
  const price = 100;
  const totalDue = Math.round(price * 1.05 * 100) / 100; // 105
  const split = calculateSplitFromBalances(balances({ deposits: 0, earnings: 0, bonus: 500 }), totalDue);
  assert.deepEqual(split.split, [{ balanceType: 'bonus', amountToUse: 10.5 }]);
  assert.equal(split.totalCovered, 10.5);
  assert.equal(split.remaining, 94.5);
});

test('wallet-buy: deposits+earnings+bonus together must cover price + fee', () => {
  // Price ₹200 → totalDue ₹210. deposits+earnings pay 100%, bonus helps after.
  const price = 200;
  const totalDue = Math.round(price * 1.05 * 100) / 100; // 210
  const split = calculateSplitFromBalances(
    balances({ deposits: 100, earnings: 100, bonus: 100 }),
    totalDue,
  );
  assert.deepEqual(split.split, [
    { balanceType: 'deposits', amountToUse: 100 },
    { balanceType: 'earnings', amountToUse: 100 },
    { balanceType: 'bonus', amountToUse: 10 }, // min(100, 21 (10% of 210), 10)
  ]);
  assert.equal(split.totalCovered, 210);
  assert.equal(split.remaining, 0);
});