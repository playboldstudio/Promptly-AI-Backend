import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODERATION_CONFIG, REPORT_REASONS } from '../src/services/moderation.service.js';

test('moderation: report reasons enum matches the plan (moderation.md §3)', () => {
  assert.deepEqual(REPORT_REASONS, ['spam', 'inappropriate', 'copyright', 'misleading', 'other']);
});

test('moderation: threshold defaults to 5 reports', () => {
  assert.equal(MODERATION_CONFIG.reportThreshold, 5);
});

test('moderation: appeal window defaults to 7 days', () => {
  assert.equal(MODERATION_CONFIG.appealWindowDays, 7);
});

test('moderation: threshold × appeal window → 7-day deadline math', () => {
  // A soft-delete at report #5 (threshold) sets appealDeadline = reportedAt + 7d.
  const reportedAt = new Date('2026-09-09T12:00:00Z');
  const appealDeadline = new Date(reportedAt.getTime() + MODERATION_CONFIG.appealWindowDays * 86_400_000);
  assert.equal(appealDeadline.toISOString(), '2026-09-16T12:00:00.000Z');
});