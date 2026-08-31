import { Router, raw } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { isAdminEmail } from '../config/env.js';
import { getProfile, getMyPrompts, getSavedPrompts, getPurchasedPrompts, getTransactions, setUpiId, setBankDetails, clearBankDetails, deleteAccount, updateProfile } from '../services/me.service.js';
import { getEarningsSummary, getEarningsByPrompt } from '../services/earnings.service.js';
import { uploadImage } from '../services/storage.service.js';
import { parsePaging } from '../utils/paging.js';
import { httpError } from '../utils/http-error.js';

const router = Router();

// Everything under /me requires a valid Bearer token.
router.use(requireAuth);

// Light validation — real UPI verification (NPCI) is out of scope; the admin
// settles manually and can eyeball the ID. Enforce the standard shape only.
const upiSchema = z.object({
  upiId: z.string().trim().min(4).max(80)
    .regex(/^[\w.\-]+@[a-zA-Z]+$/, 'Enter a valid UPI ID like name@upi'),
});

const profilePatchSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  bio: z.string().trim().max(300).optional(),
  avatarUrl: z.string().trim().url().max(1000).optional(),
});

// Bank-transfer payout details (the admin settles payouts via IMPS/NEFT).
const bankSchema = z.object({
  panNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Enter a valid PAN (e.g. ABCDE1234F)'),
  bankHolderName: z.string().trim().min(2).max(120),
  bankAccountNumber: z
    .string()
    .trim()
    .regex(/^\d{9,18}$/, 'Enter a valid bank account number'),
  bankIfsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC code (e.g. HDFC0001234)'),
  bankBranch: z.string().trim().min(2).max(80),
});

const paging = (req) => parsePaging(req.query);

router.get('/profile', async (req, res, next) => {
  try {
    const profile = await getProfile(req.userId);
    return res.json({ user: req.user, isAdmin: isAdminEmail(req.user?.email), ...profile });
  } catch (err) {
    return next(err);
  }
});

router.get('/prompts', async (req, res, next) => {
  try {
    const result = await getMyPrompts(req.userId, paging(req));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.get('/saved', async (req, res, next) => {
  try {
    const result = await getSavedPrompts(req.userId, paging(req));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.get('/transactions', async (req, res, next) => {
  try {
    const result = await getTransactions(req.userId, paging(req));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.get('/purchases', async (req, res, next) => {
  try {
    const result = await getPurchasedPrompts(req.userId, paging(req));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.get('/earnings', async (req, res, next) => {
  try {
    const summary = await getEarningsSummary(req.userId);
    return res.json({ earnings: summary });
  } catch (err) {
    return next(err);
  }
});

router.get('/earnings/prompts', async (req, res, next) => {
  try {
    const rows = await getEarningsByPrompt(req.userId);
    return res.json({ prompts: rows });
  } catch (err) {
    return next(err);
  }
});

router.post('/upi', async (req, res, next) => {
  try {
    const parsed = upiSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(httpError(400, parsed.error.issues[0]?.message ?? 'Invalid body — expected { upiId: string }'));
    const user = await setUpiId(req.userId, parsed.data.upiId);
    return res.json({ user });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /me/bank — save bank-transfer payout details.
 * Body: { panNumber, bankHolderName, bankAccountNumber, bankIfsc, bankBranch }
 */
router.post('/bank', async (req, res, next) => {
  try {
    const parsed = bankSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(httpError(400, parsed.error.issues[0]?.message ?? 'Invalid body'));
    const user = await setBankDetails(req.userId, parsed.data);
    return res.json({ user });
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /me/bank — remove the creator's bank-transfer payout details
 * (PAN + account + KYC images). They can re-add before the next withdrawal.
 */
router.delete('/bank', async (req, res, next) => {
  try {
    const user = await clearBankDetails(req.userId);
    return res.json({ user });
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /me/account — permanently delete the signed-in account. Cancels the
 * active subscription, removes saved prompts, soft-deletes + redacts the
 * profile (financial records are kept for audit), and removes the Firebase
 * Auth account so sign-in stops working.
 */
router.delete('/account', async (req, res, next) => {
  try {
    const result = await deleteAccount(req.userId);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/** Shared body for the two KYC image uploads (raw image, e.g. image/jpeg). */
function parseRawImage(req) {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return { error: 'Send the image file as the raw request body (image/jpeg, image/png, …)' };
  }
  const contentType = String(req.headers['content-type'] ?? 'image/jpeg').split(';')[0].trim();
  return { buffer: req.body, contentType };
}

/** Upload a raw image body to the user's KYC folder; returns the public URL. */
async function uploadKycImage(req, reqUserId) {
  const img = parseRawImage(req);
  if (img.error) throw httpError(400, img.error);
  return uploadImage({ folder: `kyc/${reqUserId}`, buffer: img.buffer, contentType: img.contentType });
}

/**
 * POST /me/bank/pan-image — upload the PAN card image (raw body).
 */
router.post(
  '/bank/pan-image',
  raw({ type: 'image/*', limit: '3mb' }),
  async (req, res, next) => {
    try {
      const panImageUrl = await uploadKycImage(req, req.userId);
      const user = await setBankDetails(req.userId, { panImageUrl });
      return res.json({ user, panImageUrl });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * POST /me/bank/account-image — upload the bank account image
 * (passbook / cancelled cheque). Raw body.
 */
router.post(
  '/bank/account-image',
  raw({ type: 'image/*', limit: '3mb' }),
  async (req, res, next) => {
    try {
      const bankAccountImageUrl = await uploadKycImage(req, req.userId);
      const user = await setBankDetails(req.userId, { bankAccountImageUrl });
      return res.json({ user, bankAccountImageUrl });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * PATCH /me/profile — edit display profile fields.
 * Accepts a partial object: { fullName?, bio?, avatarUrl? }.
 */
router.patch('/profile', async (req, res, next) => {
  try {
    const parsed = profilePatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(httpError(400, parsed.error.issues[0]?.message ?? 'Invalid body'));
    const user = await updateProfile(req.userId, parsed.data);
    return res.json({ user });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /me/avatar — upload a profile picture (raw image body, e.g. image/jpeg).
 * Stores the bytes in Cloud Storage and saves the public URL on the user doc.
 */
router.post(
  '/avatar',
  raw({ type: 'image/*', limit: '3mb' }),
  async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return next(httpError(400, 'Please upload an image file (JPG, PNG or WebP)'));
      }
      const contentType = String(req.headers['content-type'] ?? 'image/jpeg').split(';')[0].trim();
      const avatarUrl = await uploadImage({
        folder: `avatars/${req.userId}`,
        buffer: req.body,
        contentType,
      });
      const user = await updateProfile(req.userId, { avatarUrl });
      return res.json({ user, avatarUrl });
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
