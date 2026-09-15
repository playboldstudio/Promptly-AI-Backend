# Prompt Engagement & Moderation

> **Phase 7** (deferrable — see below) · Companion: [pricing.md](pricing.md)

## 1. Scope & build priority

| Feature | Build priority |
|---|---|
| **Report → soft-delete → appeal → admin** | ✅ **Build early** (paid-content moderation is a safety/liability need) |
| Like / save / share counts | 🕐 **Defer** (not payment-related) |
| Feed-priority ranking | ✅ After counts exist, cheap win |

This feature is **orthogonal to the payment transformation** — do it after
Play Billing + wallet + referrals are shipped, but don't let it block them.

## 2. Engagement metrics

```
👍 like      — one per user per prompt (toggleable)
🔖 save      — one per user per prompt (already exists for saved prompts)
➤ share     — increments a counter (no join table — just the count)
🚩 report    — a user flags a prompt with a reason
```

**Denormalized counters on the prompts doc**, updated atomically:

```javascript
{
  likeCount: 42,
  saveCount: 17,
  shareCount: 8,
  reportCount: 3,
}
```

**Join tables** (only for like + report — idempotent, race-safe):

```javascript
// prompt_likes — id = (userId_promptId)
{ id, userId, promptId, likedAt: Date }

// prompt_reports — id = (userId_promptId)
{ id, userId, promptId, reason: 'spam'|'inappropriate'|'copyright'|'misleading'|'other',
  description: string | null, status: 'pending'|'resolved'|'dismissed', createdAt: Date }
```

> **Shares** need no join table — just `shareCount++` (fire-and-forget).

## 3. Report reasons

```javascript
zod enum: ['spam', 'inappropriate', 'copyright', 'misleading', 'other']
```

## 4. Report → soft-delete → appeal workflow

```
1. User reports a prompt → prompt_reports row + reportCount++
2. reportCount ≥ threshold (5) → prompt soft-deleted (status: 'reported', hidden)
3. Creator notified; has 7 DAYS to appeal
4. Creator appeals (POST /prompts/:id/appeal { reason }) → status: 'appealed'
5. Admin reviews → APPROVE (restore, reset reportCount) | REJECT (hard delete)
6. No appeal within 7 days → stays 'reported' (hidden) or auto-deleted
```

**Moderation state on the prompts doc:**

```javascript
{
  status: 'published' | 'reported' | 'appealed' | 'deleted',
  reportCount, reportedAt: Date | null,
  reportedBy: ['userId1', ...],             // who reported (for admin)
  appealStatus: 'none' | 'pending' | 'approved' | 'rejected',
  appealReason: string | null,
  appealDeadline: Date | null,              // reportedAt + 7 days
  appealedAt: Date | null,
}
```

## 5. Core logic

```javascript
const MODERATION_CONFIG = {
  reportThreshold: 5,
  appealWindowDays: 7,
};

export async function handleReportThreshold({ promptId, reportCount }) {
  if (reportCount < MODERATION_CONFIG.reportThreshold) return { softDeleted: false };
  await update(COLS.prompts, promptId, {
    status: 'reported', reportedAt: new Date(), appealStatus: 'none',
    appealDeadline: new Date(Date.now() + MODERATION_CONFIG.appealWindowDays * 86_400_000),
  });
  await notifyCreatorPromptFlagged(promptId);
  return { softDeleted: true };
}

export async function appealPrompt({ promptId, authorId, reason }) {
  const prompt = await findByPk(COLS.prompts, promptId);
  if (!prompt) return { error: { status: 404, message: 'Prompt not found' } };
  if (prompt.authorId !== authorId) return { error: { status: 403, message: 'Only the author can appeal' } };
  if (prompt.status !== 'reported') return { error: { status: 409, message: 'Not flagged for review' } };
  if (new Date() > new Date(prompt.appealDeadline)) return { error: { status: 400, message: 'Appeal window closed (7 days)' } };

  await update(COLS.prompts, promptId, { status: 'appealed', appealStatus: 'pending',
    appealReason: reason, appealedAt: new Date() });
  return { success: true, status: 'appealed' };
}

export async function approveAppeal({ promptId }) {
  await update(COLS.prompts, promptId, { status: 'published', appealStatus: 'approved',
    reportCount: 0, reportedAt: null, reportedBy: [], appealDeadline: null });
  await notifyCreatorPromptRestored(promptId);
  return { success: true, status: 'published' };
}

export async function rejectAppeal({ promptId }) {
  await update(COLS.prompts, promptId, { status: 'deleted', appealStatus: 'rejected' });
  await notifyCreatorPromptDeleted(promptId);
  return { success: true, status: 'deleted' };
}
```

## 6. Endpoints

```
POST   /prompts/:id/like          — toggle like (idempotent)
POST   /prompts/:id/unlike        — remove like (idempotent)
POST   /prompts/:id/save          — save (exists)
POST   /prompts/:id/unsave        — unsave (exists)
POST   /prompts/:id/share         — shareCount++
POST   /prompts/:id/report        — report { reason, description? }
POST   /prompts/:id/appeal        — creator appeal (7-day window)
GET    /admin/prompts/reports     — moderation queue (admin)
POST   /admin/prompts/:id/approve — approve appeal → published
POST   /admin/prompts/:id/reject  — reject → deleted
POST   /admin/prompts/:id/dismiss-report — dismiss below threshold
```

## 7. Admin moderation queue

```
GET /admin/prompts/reports?status=pending
  → list of prompts in 'reported' | 'appealed' states
  → each entry: prompt, author, reportCount, reasons, appeal content
  → admin: approve | reject | dismiss
```

> **Admin wallet/refund tooling** (a `PATCH /admin/wallets/:id` endpoint) belongs
> elsewhere — but flag it here: support will need manual wallet adjustments for
> refund disputes, separate from moderation.

## 8. Rate limiting / abuse

- `/prompts/:id/report` should be **rate-limited** (e.g. 5 reports/user/hour) —
  report-stuffing is a real abuse vector.
- Like/share endpoints can share a generic authenticated limiter.

## 9. Related

- [reference.md](reference.md) — endpoints, indexes
- [pricing.md](pricing.md) — Pro/Creator "like/save counts" entitlement