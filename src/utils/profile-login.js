/**
 * Profile resolution helpers for OAuth login (src/routes/auth.js).
 *
 * The avatar rule: a user-edited avatar ALWAYS wins over the OAuth token's
 * picture, so signing out and back in never reverts a custom picture to the
 * Google one. The Google picture is only used to seed the avatar on first
 * signup (or when the user has no avatar yet).
 */

/**
 * Resolve the avatarUrl to persist on login.
 * @param {string|null} existingAvatar - the stored users.avatarUrl (may be a
 *   user-edited/custom avatar, or from a prior signup).
 * @param {string|null|undefined} oauthPicture - decoded.picture from the token.
 * @param {string|null|undefined} oauthPhotoURL - decoded.photoURL (alias).
 * @returns {string|null}
 */
export function resolveAvatarOnLogin(existingAvatar, oauthPicture, oauthPhotoURL) {
  return existingAvatar ?? oauthPicture ?? oauthPhotoURL ?? null;
}