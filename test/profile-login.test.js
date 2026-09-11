import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAvatarOnLogin } from '../src/utils/profile-login.js';

test('profile-login: a user-edited avatar wins over the OAuth picture (no revert on re-login)', () => {
  const existing = 'https://cdn.example.com/edited-avatar.jpg';
  const oauthPic = 'https://lh3.googleusercontent.com/abc';
  assert.equal(resolveAvatarOnLogin(existing, oauthPic, undefined), existing);
});

test('profile-login: first signup seeds the Google picture when no avatar exists', () => {
  assert.equal(
    resolveAvatarOnLogin(null, 'https://lh3.googleusercontent.com/abc', undefined),
    'https://lh3.googleusercontent.com/abc',
  );
});

test('profile-login: photoURL alias is used when picture is absent', () => {
  assert.equal(
    resolveAvatarOnLogin(null, undefined, 'https://cdn.example.com/photo.jpg'),
    'https://cdn.example.com/photo.jpg',
  );
});

test('profile-login: all absent → null (no avatar)', () => {
  assert.equal(resolveAvatarOnLogin(null, undefined, undefined), null);
  assert.equal(resolveAvatarOnLogin(undefined, null, null), null);
});