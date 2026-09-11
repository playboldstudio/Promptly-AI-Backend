import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationIdFor, bonusExpiryReminderMessage } from '../src/services/notifications.service.js';

test('notifications: dedupe doc id is userId_type_dedupeKey', () => {
  assert.equal(notificationIdFor('u1', 'bonus_expiry', 'vint_1'), 'u1_bonus_expiry_vint_1');
});

test('notifications: reminder message for a vintage expiring in ~7 days', () => {
  const expiresAt = Date.now() + 7 * 86_400_000;
  const msg = bonusExpiryReminderMessage({ amount: 15, expiresAt, now: Date.now() });
  assert.equal(msg.title, 'Bonus expiring soon');
  assert.match(msg.body, /₹15/);
  assert.match(msg.body, /expires in 7 days/);
  assert.equal(msg.days, 7);
});

test('notifications: reminder days floor at 1 for a vintage expiring today', () => {
  const now = Date.now();
  const msg = bonusExpiryReminderMessage({ amount: 5, expiresAt: now + 3_600_000, now });
  assert.equal(msg.days, 1);
  assert.match(msg.body, /expires in 1 day/); // singular
});

test('notifications: reminder message for a single day is singular', () => {
  const now = Date.now();
  const msg = bonusExpiryReminderMessage({ amount: 1, expiresAt: now + 1 * 86_400_000, now });
  assert.equal(msg.days, 1);
  assert.match(msg.body, /in 1 day\./);
});