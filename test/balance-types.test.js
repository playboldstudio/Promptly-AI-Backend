import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BALANCE_TYPES, getBalanceType, getBalanceTypesByPriority, isWithdrawable, getMaxUsePercent, zeroBalances } from '../src/services/payments/balance-types.js';

test('balance-types: exactly three buckets — earnings, deposits, bonus', () => {
  assert.deepEqual(Object.keys(BALANCE_TYPES).sort(), ['bonus', 'deposits', 'earnings']);
});

test('balance-types: earnings is the only withdrawable bucket', () => {
  assert.equal(isWithdrawable('earnings'), true);
  assert.equal(isWithdrawable('deposits'), false);
  assert.equal(isWithdrawable('bonus'), false);
});

test('balance-types: spend order (priority) is deposits → earnings → bonus', () => {
  const ids = getBalanceTypesByPriority().map((b) => b.id);
  assert.deepEqual(ids, ['deposits', 'earnings', 'bonus']);
});

test('balance-types: bonus is capped at 10% of an item price', () => {
  assert.equal(getMaxUsePercent('bonus'), 10);
  assert.equal(getMaxUsePercent('deposits'), 100);
  assert.equal(getMaxUsePercent('earnings'), 100);
});

test('balance-types: zeroBalances returns a clean all-zero doc', () => {
  assert.deepEqual(zeroBalances(), { earnings: 0, deposits: 0, bonus: 0, bonusVintages: {} });
});

test('balance-types: getBalanceType rejects unknown ids', () => {
  assert.equal(getBalanceType('nope'), null);
  assert.equal(getBalanceType('earnings').id, 'earnings');
});