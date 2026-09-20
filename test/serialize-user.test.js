import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeUser } from '../src/utils/serialize-user.js';
import { ADMIN_EMAILS } from '../src/config/env.js';

test('serialize-user: an email in ADMIN_EMAILS serializes with role "admin"', () => {
  if (!ADMIN_EMAILS.length) {
    // No admin configured in this environment — nothing to assert.
    return;
  }
  const user = serializeUser({ id: 'u1', email: ADMIN_EMAILS[0], role: 'viewer' });
  assert.equal(user.role, 'admin');
  assert.equal(user.isAdmin, true);
});

test('serialize-user: non-admin emails keep their stored role (default "viewer")', () => {
  assert.equal(serializeUser({ id: 'u2', email: 'someone@example.com' }).role, 'viewer');
  assert.equal(serializeUser({ id: 'u2', email: 'someone@example.com' }).isAdmin, false);
  assert.equal(serializeUser({ id: 'u3', email: 'someone@example.com', role: 'creator' }).role, 'creator');
});

test('serialize-user: null user serializes to null', () => {
  assert.equal(serializeUser(null), null);
});