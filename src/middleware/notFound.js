/** 404 handler — any route that doesn't match falls through here. */
export function notFound(_req, res) {
  res.status(404).json({
    error: { message: 'Route not found', code: 'NOT_FOUND' },
  });
}
