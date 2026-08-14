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
