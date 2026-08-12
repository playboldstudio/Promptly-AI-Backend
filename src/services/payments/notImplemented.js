/**
 * Throws a 501 for payment flows that are specified but not yet wired to Razorpay.
 * Keeps the business-rule shape visible and the endpoints honest (no fake money).
 */
export function notImplemented(feature) {
  const err = new Error(`${feature} not wired up yet — see src/services/payments/`);
  err.status = 501;
  err.code = 'NOT_IMPLEMENTED';
  throw err;
}
