import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAY_CONSOLE_TO_INTERNAL,
  INTERNAL_TO_PLAY_CONSOLE,
  internalProductId,
  playConsoleProductId,
} from '../src/services/payments/playConsoleIds.js';

test('playConsoleIds: every Play Console subscription maps to the internal plan', () => {
  assert.equal(internalProductId('playbold-promptly-pro-monthly'), 'pro');
  assert.equal(internalProductId('playbold-promptly-pro-yearly'), 'pro_annual');
  assert.equal(internalProductId('playbold-promptly-creator-monthly'), 'creator');
  assert.equal(internalProductId('playbold-promptly-creator-yearly'), 'creator_annual');
});

test('playConsoleIds: every Play Console one-time product maps to the internal id', () => {
  assert.equal(internalProductId('playbold.promptly.ad'), 'ad_free');
  assert.equal(internalProductId('playbold.promptly.deposit_s'), 'deposit_s');
  assert.equal(internalProductId('playbold.promptly.deposit_m'), 'deposit_m');
  assert.equal(internalProductId('playbold.promptly.deposit_l'), 'deposit_l');
  assert.equal(internalProductId('playbold.promptly.deposit_xl'), 'deposit_xl');
});

test('playConsoleIds: internal-to-console is the exact reverse of console-to-internal', () => {
  for (const [consoleId, internalId] of Object.entries(PLAY_CONSOLE_TO_INTERNAL)) {
    assert.equal(playConsoleProductId(internalId), consoleId);
  }
  for (const [internalId, consoleId] of Object.entries(INTERNAL_TO_PLAY_CONSOLE)) {
    assert.equal(internalProductId(consoleId), internalId);
  }
});

test('playConsoleIds: dynamic prompt unlock ids pass through unchanged', () => {
  assert.equal(internalProductId('prompt_abc123'), 'prompt_abc123');
  assert.equal(playConsoleProductId('prompt_abc123'), 'prompt_abc123');
});

test('playConsoleIds: unknown standalone ids are left as-is', () => {
  assert.equal(internalProductId('some-other-sku'), 'some-other-sku');
  assert.equal(internalProductId('pro'), 'pro'); // already-internal is a no-op
});