import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePromptFlags } from '../src/services/prompt-metrics.js';

test('derivePromptFlags: trending above engagement threshold', () => {
  const flags = derivePromptFlags({ viewCount: 60, saveCount: 40, createdAt: new Date() });
  assert.equal(flags.isTrending, true);
  assert.equal(flags.isNew, true);
});

test('derivePromptFlags: not trending below threshold', () => {
  const flags = derivePromptFlags({ viewCount: 59, saveCount: 40, createdAt: new Date() });
  assert.equal(flags.isTrending, false);
});

test('derivePromptFlags: missing counts default to 0 (no throw)', () => {
  const flags = derivePromptFlags({ createdAt: new Date() });
  assert.equal(flags.isTrending, false);
  assert.equal(flags.isNew, true);
});

test('derivePromptFlags: isNew false after 7 days', () => {
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const flags = derivePromptFlags({ viewCount: 0, saveCount: 0, createdAt: old });
  assert.equal(flags.isNew, false);
});

test('derivePromptFlags: future createdAt is not new', () => {
  const future = new Date(Date.now() + 1000);
  const flags = derivePromptFlags({ viewCount: 0, saveCount: 0, createdAt: future });
  assert.equal(flags.isNew, false);
});
