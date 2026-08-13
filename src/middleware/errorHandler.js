/**
 * Centralized error handler — converts thrown errors into consistent JSON.
 * `err.status` set by route/service code (e.g. 401, 404, 501) is honored;
 * a 409 CONFLICT can be signalled with err.code = 'CONFLICT' or err.status = 409;
 * anything else is a 500 with a safe message.
 */
// eslint-disable-next-line no-unused-vars -- Express requires 4 args to recognize an error handler
export function errorHandler(err, _req, res, _next) {
  const status = Number.isInteger(err.status) ? err.status : 500;
  const message = status >= 500 ? 'Internal server error' : err.message;

  if (status >= 500) {
    console.error(err);
  }

  return res.status(status).json({
    error: {
      message,
      code: err.code ?? (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST'),
    },
  });
}
