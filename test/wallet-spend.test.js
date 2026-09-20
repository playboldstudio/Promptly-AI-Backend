import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSplitFromBalances, bonusFirstOpts } from '../src/services/wallet.service.js';

// Buy flow split opts — mirrors buyPromptWithWallet: bonus FIRST, capped at
// 10% of the RAW price (not the fee-inclusive total), then deposits → earnings.
const BUY_SPLIT = (priceInr) => ({
  order: ['bonus', 'deposits', 'earnings'],
  capBase: { bonus: priceInr },
});

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

test('wallet-buy: bonus is spent FIRST, up to 10% of the raw price, fee from deposits', () => {
  // Price ₹100 → totalDue ₹105. Bonus covers 10% of the RAW price (₹10), then
  // deposits cover the rest including the ₹5 fee. Bonus never pays the fee.
  const price = 100;
  const totalDue = Math.round(price * 1.05 * 100) / 100; // 105
  const split = calculateSplitFromBalances(
    balances({ deposits: 200, bonus: 500 }),
    totalDue,
    BUY_SPLIT(price),
  );
  assert.deepEqual(split.split, [
    { balanceType: 'bonus', amountToUse: 10 }, // 10% of price, not totalDue
    { balanceType: 'deposits', amountToUse: 95 }, // 85 price remainder + 10 fee
  ]);
  assert.equal(split.totalCovered, 105);
  assert.equal(split.remaining, 0);
});

test('wallet-buy: bonus less than 10% → take ALL of it, balance from deposit/earnings', () => {
  const price = 100;
  const totalDue = Math.round(price * 1.05 * 100) / 100; // 105
  const split = calculateSplitFromBalances(
    balances({ deposits: 50, earnings: 60, bonus: 6 }),
    totalDue,
    BUY_SPLIT(price),
  );
  assert.deepEqual(split.split, [
    { balanceType: 'bonus', amountToUse: 6 }, // below the 10 cap → all of it
    { balanceType: 'deposits', amountToUse: 50 },
    { balanceType: 'earnings', amountToUse: 49 },
  ]);
  assert.equal(split.totalCovered, 105);
  assert.equal(split.remaining, 0);
});

test('wallet-buy: bonus capped on total due when no capBase passed (spend default)', () => {
  // Default split (used by wallet/spend) still caps bonus at 10% of whatever
  // item amount is passed — here the fee-inclusive total.
  const price = 100;
  const totalDue = Math.round(price * 1.05 * 100) / 100; // 105
  const split = calculateSplitFromBalances(
    balances({ deposits: 0, earnings: 0, bonus: 500 }),
    totalDue,
  );
  assert.deepEqual(split.split, [{ balanceType: 'bonus', amountToUse: 10.5 }]);
  assert.equal(split.totalCovered, 10.5);
  assert.equal(split.remaining, 94.5);
});

test('wallet-buy: bonus-first order means deposits/earnings may be skipped entirely', () => {
  // Price ₹100, totalDue ₹105. Bonus max ₹10 — but totalDue needs 105, so a
  // tiny balance can't fully cover; deposits/earnings take the rest.
  const price = 100;
  const totalDue = Math.round(price * 1.05 * 100) / 100; // 105
  const split = calculateSplitFromBalances(
    balances({ bonus: 200 }),
    totalDue,
    BUY_SPLIT(price),
  );
  assert.deepEqual(split.split, [{ balanceType: 'bonus', amountToUse: 10 }]);
  assert.equal(split.totalCovered, 10);
  assert.equal(split.remaining, 95);
});

test('wallet-allocate: preview shows bonus first (10% of price), then deposits, then earnings', () => {
  // ₹99 prompt → bonus (10% cap) first, deposits, then earnings — the same
  // split the buy flow charges, so the app preview matches the purchase.
  const split = calculateSplitFromBalances(
    balances({ deposits: 80, earnings: 60, bonus: 40 }),
    99,
    bonusFirstOpts(99),
  );
  assert.deepEqual(split.split, [
    { balanceType: 'bonus', amountToUse: 9.9 },
    { balanceType: 'deposits', amountToUse: 80 },
    { balanceType: 'earnings', amountToUse: 9.1 },
  ]);
  assert.equal(split.totalCovered, 99);
  assert.equal(split.remaining, 0);
});

test('wallet-allocate: bonus-first still caps bonus at 10% of the raw price basis', () => {
  // Lots of bonus + plenty of deposits → bonus takes exactly 10% of 99, then
  // deposits cover the rest; earnings untouched.
  const split = calculateSplitFromBalances(
    balances({ deposits: 200, earnings: 0, bonus: 500 }),
    99,
    bonusFirstOpts(99),
  );
  assert.deepEqual(split.split, [
    { balanceType: 'bonus', amountToUse: 9.9 },
    { balanceType: 'deposits', amountToUse: 89.1 },
  ]);
  assert.equal(split.totalCovered, 99);
  assert.equal(split.remaining, 0);
});