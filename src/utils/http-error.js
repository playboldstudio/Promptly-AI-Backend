/**
 * HTTP error helpers.
 *
 * The Express app communicates failures to the errorHandler via `err.status`.
 * These one-liners remove the repeated
 *   const err = new Error(msg); err.status = 400; return next(err);
 * pattern from every route handler.
 */

/** Create a `next(err)`-compatible Error with an HTTP status. */
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}