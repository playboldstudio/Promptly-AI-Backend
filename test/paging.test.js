import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaging, MAX_LIMIT, DEFAULT_LIMIT } from '../src/utils/paging.js';

test('parsePaging: defaults when no query present', () => {
  assert.deepEqual(parsePaging({}), { limit: DEFAULT_LIMIT, offset: 0 });
  assert.deepEqual(parsePaging(undefined), { limit: DEFAULT_LIMIT, offset: 0 });
});

test('parsePaging: parses and clamps limit to MAX_LIMIT', () => {
  assert.deepEqual(parsePaging({ limit: '10', offset: '5' }), { limit: 10, offset: 5 });
  assert.deepEqual(parsePaging({ limit: '500' }), { limit: MAX_LIMIT, offset: 0 });
  assert.deepEqual(parsePaging({ limit: '0' }), { limit: DEFAULT_LIMIT, offset: 0 });
  assert.deepEqual(parsePaging({ limit: '-3' }), { limit: DEFAULT_LIMIT, offset: 0 });
});

test('parsePaging: floors non-numeric and negative offset to 0', () => {
  assert.deepEqual(parsePaging({ offset: '-3' }), { limit: DEFAULT_LIMIT, offset: 0 });
  assert.deepEqual(parsePaging({ limit: 'abc', offset: 'xyz' }), { limit: DEFAULT_LIMIT, offset: 0 });
  assert.deepEqual(parsePaging({ limit: '2.9' }), { limit: 2, offset: 0 });
});