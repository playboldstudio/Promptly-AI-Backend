import { Prompt, PromptPurchase, UserSubscription } from '../../db/models.js';
import { sequelize } from '../../db/config.js';
import { razorpay, verifyPaymentSignature } from '../../lib/razorpay.js';
import { writeLedger } from '../ledger.js';

/**
 * PAID PROMPT SALES — Razorpay Checkout into the platform's account.
 *
 * Flow:
 *   1. POST /payments/checkout/order  → createCheckoutOrder():
 *        - validates the prompt is paid + published
 *        - enforces ONE UNLOCK per buyer (no duplicate orders if already purchased)
 *        - reads the BUYER's subscription platform_fee_percent (Pro=5%, Creator=0%)
 *        - freezes the financial snapshot (price / fee / net) right now
 *        - calls Razorpay Orders API → { order_id, amount, currency }
 *        - returns the order to the app, which opens Razorpay Checkout
 *   2. The app sends the payment response back → POST /payments/checkout/verify
 *        - verifies the Razorpay payment_signature (HMAC, server-side)
 *        - double-checks the captured amount matches the order
 *        - unlockPrompt() writes the PromptPurchase + ledger rows
 *
 * All money is integer rupees. `net_inr` is frozen at sale time so historical
 * accuracy survives fee changes.
 */

/** Amount razorpay orders expect (paise) for a given rupee amount. */
function inPaise(rupees) {
  return Math.round(rupees * 100);
}

/**
 * Phase 1 — create a Razorpay order for a paid prompt.
 * @returns {{ orderId, amountInr, currency, feePercent, feeInr, netInr, prompt }}
 */
export async function createCheckoutOrder({ buyerId, promptId }) {
  const prompt = await Prompt.findByPk(promptId);
  if (!prompt || prompt.status !== 'published') {
    return { error: { status: 404, message: 'Prompt not found' } };
  }
  if (!prompt.isPaid || !prompt.priceInr) {
    return { error: { status: 400, message: 'This prompt is free — nothing to pay' } };
  }

  // One unlock per buyer per prompt — reject if already purchased.
  const existing = await PromptPurchase.findOne({ where: { buyerId, promptId } });
  if (existing) {
    return { error: { status: 409, message: 'You already own this prompt' } };
  }

  // Platform fee % from the BUYER's current subscription (Pro=5%, Creator=0%).
  const subscription = await UserSubscription.findOne({
    where: { userId: buyerId, status: 'active' },
    include: [{ association: 'plan' }],
  });
  const feePercent = subscription?.plan?.platformFeePercent ?? 0;

  const priceInr = prompt.priceInr;
  const feeInr = Math.round((priceInr * feePercent) / 100);
  const netInr = priceInr - feeInr;

  const order = await razorpay.orders.create({
    amount: inPaise(priceInr),
    currency: 'INR',
    receipt: `prompt_${promptId}`,
    notes: { promptId, buyerId, feePercent },
  });

  return {
    orderId: order.id,
    amountInr: priceInr,
    currency: order.currency,
    feePercent,
    feeInr,
    netInr,
    prompt: {
      id: prompt.id,
      title: prompt.title,
      description: prompt.description,
      imageUrl: prompt.imageUrl,
    },
  };
}

/**
 * Phase 2 — verify the payment signature, then unlock the prompt.
 * Called by the app with the fields Razorpay Checkout returns on success.
 */
export async function verifyAndUnlock({
  buyerId,
  promptId,
  orderId,
  paymentId,
  signature,
}) {
  // Server-side signature check (HMAC-SHA256 of `order_id|payment_id`).
  if (!verifyPaymentSignature({ orderId, paymentId, signature })) {
    return { error: { status: 400, message: 'Invalid payment signature' } };
  }

  const prompt = await Prompt.findByPk(promptId);
  if (!prompt) return { error: { status: 404, message: 'Prompt not found' } };

  // Money integrity — never trust the client for the amount. Bind this payment
  // to THIS prompt's order and confirm the captured amount matches:
  // 1) the order belongs to this prompt (receipt = prompt_<id>, notes.promptId)
  // 2) the order amount equals the prompt price
  // 3) the payment is captured and its amount equals the order amount
  const [order, payment] = await Promise.all([
    razorpay.orders.fetch(orderId).catch(() => null),
    razorpay.payments.fetch(paymentId).catch(() => null),
  ]);

  if (
    !order ||
    order.receipt !== `prompt_${promptId}` ||
    order.notes?.promptId !== promptId
  ) {
    return { error: { status: 400, message: 'Order does not match this prompt' } };
  }
  if (Number(order.amount) !== prompt.priceInr * 100) {
    return { error: { status: 400, message: 'Order amount does not match the prompt price' } };
  }
  if (!payment || payment.order_id !== orderId || payment.status !== 'captured') {
    return { error: { status: 400, message: 'Payment has not been captured' } };
  }
  if (Number(payment.amount) !== Number(order.amount)) {
    return { error: { status: 400, message: 'Payment amount does not match the order' } };
  }

  const priceInr = Math.round(Number(payment.amount) / 100);
  return unlockPrompt({ buyerId, promptId, orderId, paymentId, priceInr });
}

/**
 * Write the PromptPurchase + ledger rows for a completed sale.
 * Wrapped in a transaction so money rows are all-or-nothing.
 */
async function unlockPrompt({ buyerId, promptId, orderId, paymentId, priceInr }) {
  const prompt = await Prompt.findByPk(promptId);
  if (!prompt) return { error: { status: 404, message: 'Prompt not found' } };

  const existing = await PromptPurchase.findOne({ where: { buyerId, promptId } });
  if (existing) {
    return { error: { status: 409, message: 'You already own this prompt' } };
  }

  // Prevents a caller from passing a made-up price while paying the real amount.
  if (Math.round(Number(priceInr)) !== prompt.priceInr) {
    return { error: { status: 400, message: 'Price does not match the prompt price' } };
  }

  // Recompute the financial snapshot from the *current* buyer fee.
  const subscription = await UserSubscription.findOne({
    where: { userId: buyerId, status: 'active' },
    include: [{ association: 'plan' }],
  });
  const feePercent = subscription?.plan?.platformFeePercent ?? 0;
  const feeInr = Math.round((priceInr * feePercent) / 100);
  const netInr = priceInr - feeInr;

  try {
    await sequelize.transaction(async (t) => {
      const purchase = await PromptPurchase.create(
        {
          buyerId,
          promptId,
          authorId: prompt.authorId,
          priceInr,
          platformFeeInr: feeInr,
          netInr,
          razorpayPaymentId: paymentId,
          status: 'completed',
        },
        { transaction: t },
      );

      // Ledger — credit the creator with the net amount.
      await writeLedger(
        {
          userId: prompt.authorId,
          type: 'paid_prompt_sale',
          direction: 'credit',
          amountInr: netInr,
          refId: purchase.id,
          note: `Sale of "${prompt.title}"`,
        },
        t,
      );

      // Ledger — debit the buyer by the price paid.
      await writeLedger(
        {
          userId: buyerId,
          type: 'paid_prompt_sale',
          direction: 'debit',
          amountInr: priceInr,
          refId: purchase.id,
          note: `Unlocked "${prompt.title}"`,
        },
        t,
      );
    });

    return { success: true, unlocked: true, promptId, paymentId, orderId };
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return { error: { status: 409, message: 'You already own this prompt' } };
    }
    throw err;
  }
}
