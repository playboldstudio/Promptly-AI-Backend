import { UniqueConstraintError, ValidationError } from 'sequelize';

/**
 * Centralized error handler — converts thrown errors into consistent JSON.
 * `err.status` set by route/service code (e.g. 401, 404, 501) is honored;
 * Sequelize errors map to 409/400; anything else is a 500 with a safe message.
 */
// eslint-disable-next-line no-unused-vars -- Express requires 4 args to recognize an error handler
export function errorHandler(err, _req, res, _next) {
  if (err instanceof UniqueConstraintError) {
    return res.status(409).json({
      error: {
        message: 'A record with that value already exists',
        code: 'CONFLICT',
      },
    });
  }

  if (err instanceof ValidationError) {
    return res.status(400).json({
      error: {
        message: err.message,
        code: 'VALIDATION_ERROR',
      },
    });
  }

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
