# Promptly AI — API Reference & Response Models

Complete inventory of every HTTP endpoint in the backend, with request contracts
(route params, query, body, validation rules) and the exact JSON response models
returned by each route. Field names are taken straight from the source
(`src/routes/*.js`, `src/services/*.js`) — nothing here is invented.

Generated against `master` (latest commit `b0a493a`, notification + Play Billing
audit fixes). For known issues and the production-readiness plan, see
`PAYMENT_API_AUDIT_REPORT.md`.

---

## 1. Global conventions

### 1.1 Base paths (mounted in `src/app.js`)

| Router | Mounted at |
|---|---|
| `health.js` | `/` |
| `auth.js` | `/` |
| `prompts.js` | `/` |
| `admin-prompts.js` | `/` |
| `me.js` | `/me` |
| `payments.js` | `/payments` |
| `referrals.js` | `/referrals` |
| `rtdn.js` | `/webhooks/google/rtdn` |

### 1.2 Authentication

- All requests carry `Authorization: Bearer <token>`.
- In **production** the token must be a valid Firebase ID token (verified with
  the Admin SDK, signature + expiry + audience). `requireAuth` resolves it to the
  Firestore `users` doc and attaches `req.userId` (doc id = Firebase UID).
- In **non-production** a bare UUID user id string is also accepted (dev login),
  and `POST /auth/dev/login` is active (returns 404 in production).
- If `DEV_AUTH_PASSWORD` is set, `Bearer <password>:<email>` authenticates as
  that email's user (dev backdoor — never set in production).
- `optionalAuth` attaches `req.user`/`req.userId` when a *valid* token is present,
  otherwise treats the caller as anonymous. Invalid tokens are silently anonymous.
- Admin-gated routes check `isAdminEmail(req.user.email)` against `ADMIN_EMAILS`.

### 1.3 Errors

All failures (except the RTDN webhook, which always returns 200) use the shared
HTTP error envelope from `src/middleware/errorHandler.js`:

```json
{ "error": { "message": "Human-readable message", "code": "BAD_REQUEST" } }
```

- `code` is `BAD_REQUEST` for any status < 500 (or a specific code where set),
  `INTERNAL` for ≥ 500.
- Status 500 responses always return `message: "Internal server error"` and log
  the real error server-side.
- `404` for unknown routes uses the same envelope.

### 1.4 Pagination

`limit` / `offset` query params (parsed by `src/utils/paging.js`):

| Param | Default | Max | Behavior |
|---|---|---|---|
| `limit` | 50 | 100 | non-finite/`<1` → 50; capped at 100 |
| `offset` | 0 | — | non-finite/`<1` → 0 |

### 1.5 Rate limits

| Scope | Window | Max | Applies to |
|---|---|---|---|
| Login | 60s | 30 | `POST /auth/login`, `POST /auth/dev/login` |
| Money | 60s | 60 | Play billing verify/void, sub delete, wallet spend/buy, payout create, admin mark-paid/mark-failed, admin wallet patch |
| Reports | 3600s | 5 | `POST /prompts/:id/report` |
| Referrals | 60s | 30 | `POST /referrals/code`, `GET /referrals/:code/validate`, `POST /referrals/apply` |

Rate-limit violations respond with the standard error envelope
(`message` = the limiter's configured message, status 429).

### 1.6 Data conventions

- **Timestamps**: Firestore `Timestamp`s are returned as ISO-8601 **strings** by
  the repo layer (`src/db/firestoreRepo.js` normalizes every read).
- **Money**: INR rupees as **numbers** with at most 2 decimals (`toMoney`).
- **Keys absent vs null**: paid `promptText` is *deleted* from the response (key
  absent), never returned as null; wallet balances always carry all three keys.

---

## 2. Health

### `GET /health` — public

```json
{
  "status": "ok",
  "db": "up",
  "uptime": 1234.56,
  "timestamp": "2026-09-16T12:00:00.000Z"
}
```

`db` is `"up"` when Firestore answers a ping, else `"down"` (still 200).

---

## 3. Auth

### `POST /auth/login` — public, 30/min

Verify a Firebase ID token, upsert the user profile, and (on oAuth sign-ups)
best-effort apply a referral code.

Body:
```json
{
  "idToken": "<firebase-id-token>",
  "referralCode": "AB3D9K2M",
  "playAccountId": "optional-account-device-fingerprint"
}
```
`referralCode` and `playAccountId` are optional (default `""`).

Response:
```json
{
  "user": { "...": "full users doc — see §10.1" },
  "token": "<the same idToken you sent>",
  "referral": {
    "applied": true,
    "referrerBonus": 50,
    "refereeBonus": 25,
    "balanceType": "bonus"
  }
}
```
`referral` is `null` when no code was sent; `{ "applied": false, "reason": "…" }`
when a code was sent but could not be applied (referral never blocks login).

Errors: `401` for an invalid/expired token
(`"Your sign-in has expired. Please sign in again"`); `400` for a malformed body.

### `POST /auth/dev/login` — public (dev only), 30/min

Body: `{ "email": "a@b.com", "fullName": "optional" }`

Response: `{ "token": "<userId>", "user": { "...": "users doc" } }`

Returns **404** when `NODE_ENV === 'production'`.

---

## 4. Prompts (content)

### `POST /prompts` — auth

Create a prompt. Paid prompts require the Pro or Creator plan (`canPostPaid`).

Body:
```json
{
  "title": "Golden Hour Portrait",        // 1–60 chars
  "description": "Warm sunset portrait",  // 1–100 chars
  "promptText": "Nikon Z9, 50mm f/1.8, ISO 100, golden hour backlight…",
  "imageUrl": "https://…/cover.jpg",      // optional, nullable; iff no imageUrl then images[] required
  "images": ["https://…/1.jpg"],          // optional, ≤ 10 URLs
  "category": "portrait",                 // enum, see below
  "tags": ["portrait", "sunset"],         // ≤ 20 tags, each 1–40 chars
  "isPaid": false,
  "priceInr": 99                          // required (int > 0) iff isPaid=true
}
```

Category enum: `portrait | studio | vintage | retro | cinematic | anime | art |
birthday | festive | other`.

Response — **201**:
```json
{
  "prompt": {
    "id": "…",
    "title": "Golden Hour Portrait",
    "description": "Warm sunset portrait",
    "imageUrl": "https://…/cover.jpg",
    "images": ["https://…/cover.jpg"],
    "category": "portrait",
    "tags": ["portrait", "sunset"],
    "isPaid": false,
    "priceInr": null,
    "viewCount": 0,
    "saveCount": 0,
    "createdAt": "2026-09-16T12:00:00.000Z",
    "isTrending": false,
    "isNew": true,
    "author": { "id": "uid", "fullName": "…", "avatarUrl": "…", "role": "…" },
    "savedByMe": false
  }
}
```
Note: `promptText` is stored but **not echoed** (whitelist serializer).

Errors: `400` invalid body / free prompt without images / paid without price;
`403` paid posting without plan (`"Paid prompts require the Pro or Creator plan"`);
`404` user missing.

### `POST /prompts/image` — auth, raw image body ≤ 3 MB

Upload a prompt cover (JPG/PNG/WebP/…). Runs NSFW moderation first.

Response — **201**: `{ "imageUrl": "https://storage.googleapis.com/<bucket>/prompts/<uid>/<ts>-<hex>.jpg" }`

Errors: `400` empty/non-image body; `413` image > 3 MB; `422` moderation rejected
(`{ error: { message: mod.reason, code: "BAD_REQUEST" } }`).

### `GET /prompts` — optionalAuth

Query: `category`, `paid` (`free`|`paid`), `sort` (`trending`|`new`|`recent`),
`q` (text search over title/description/tags), `limit`, `offset`.

Response:
```json
{
  "prompts": [
    {
      "id": "…",
      "title": "…",
      "description": "…",
      "imageUrl": "https://…",
      "images": ["https://…"],
      "category": "portrait",
      "tags": ["…"],
      "isPaid": false,
      "priceInr": null,
      "viewCount": 0,
      "saveCount": 0,
      "createdAt": "…",
      "isTrending": false,
      "isNew": true,
      "author": { "id": "…", "fullName": "…", "avatarUrl": "…", "role": "…" },
      "savedByMe": false
    }
  ],
  "total": 37,
  "limit": 50,
  "offset": 0
}
```

List rows **never** include `promptText` (whitelist), regardless of payment state.
`savedByMe` is `false` for anonymous callers. `author` is `null` if unset.

Errors: `400` invalid `category` or `paid` value.

### `GET /prompts/categories` — optionalAuth

Flipkart-style category rails. Returns every category with its published-count
and the newest `previewLimit` prompts (default 4, max 10).

Query: `previewLimit` (`1`–`10`, default `4`), `paid` (`free`|`paid`).

Response:
```json
{
  "categories": [
    {
      "category": "portrait",
      "count": 12,
      "previews": [
        {
          "id": "…",
          "title": "…",
          "description": "…",
          "imageUrl": "https://…",
          "images": ["https://…"],
          "category": "portrait",
          "tags": ["…"],
          "isPaid": false,
          "priceInr": null,
          "viewCount": 0,
          "saveCount": 0,
          "createdAt": "…",
          "isTrending": false,
          "isNew": true,
          "author": { "id": "…", "fullName": "…", "avatarUrl": "…", "role": "…" },
          "savedByMe": false
        }
      ]
    }
  ],
  "total": 37
}
```

Categories appear in the canonical `PROMPT_CATEGORIES` order; zero-count rails
are still returned (`previews: []`) so clients can build the full nav.

### `GET /prompts/new` — optionalAuth

"Just added" feed: prompts published within the last `days` (default 7, max 90),
newest first. Same row shape and paging as `GET /prompts`.

Query: `days` (`1`–`90`, default `7`), `limit`, `offset`.

Response:
```json
{
  "prompts": [ "…same rows as GET /prompts…" ],
  "total": 12,
  "limit": 50,
  "offset": 0,
  "days": 7,
  "since": "2026-09-09T00:00:00.000Z"
}
```

### `GET /prompts/month` — optionalAuth

Month-wise feed: prompts published within a calendar month, newest first. Same
row shape and paging as `GET /prompts`.

Query: `month` (**required**, `YYYY-MM`), `limit`, `offset`.

Response:
```json
{
  "prompts": [ "…same rows as GET /prompts…" ],
  "total": 5,
  "limit": 50,
  "offset": 0,
  "month": "2026-09"
}
```

Errors: `400` missing/malformed `month` (expected `YYYY-MM`).

### `GET /prompts/:id` — optionalAuth

Response:
```json
{
  "prompt": {
    "id": "…",
    "authorId": "uid",
    "title": "…",
    "description": "…",
    "promptText": "…",            // PRESENT ONLY when unlocked (see below)
    "imageUrl": "https://…",
    "images": ["https://…"],
    "category": "portrait",
    "tags": ["…"],
    "isPaid": true,
    "priceInr": 99,
    "status": "published",
    "viewCount": 5,
    "saveCount": 2,
    "likeCount": 3,
    "createdAt": "…",
    "updatedAt": "…",
    "isTrending": false,
    "isNew": false,
    "author": { "id": "…", "fullName": "…", "avatarUrl": "…", "role": "…" },
    "savedByMe": false,
    "unlocked": false
  }
}
```

**`promptText` gating** — returned verbatim only when `unlocked` is true:
the prompt is free, the viewer is the author, the viewer has a completed
`prompt_purchases` row for it, or the viewer is an admin. Otherwise the key is
deleted from the response (absent, not null). Hidden rows also disable it when
`status` is `reported`/`appealed` (they're not returned at all — 404).

Errors: `404` not found or not published. Bumps `viewCount` fire-and-forget.

### `GET /prompts/:id/image` — optionalAuth

- Free prompts and admins: **301 redirect** to the original public URL.
- Paid prompts: returns a watermarked `image/webp` rendered with a diagonal
  title watermark, headers `Cache-Control: private, max-age=3600`,
  `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`.

Errors: `404` no prompt or no image.

### `DELETE /prompts/:id` — auth (author or admin)

Response: `{ "success": true, "id": "…" }`

Removes the prompt + its save joins; purchase/ledger rows are kept for audit.

Errors: `403` not the author and not admin; `404` missing.

### `POST /prompts/:id/save` — auth

Response: `{ "saved": true, "saveCount": 4 }` (idempotent).

Errors: `404` via `notFound` → `{ error: { message: "Prompt not found" } }`.

### `POST /prompts/:id/unsave` — auth

Response: `{ "saved": false, "saveCount": 3 }` (idempotent).

### `POST /prompts/:id/report` — auth, 5/hour

Body: `{ "reason": "spam", "description": "optional ≤ 500 chars" }`
`reason` enum: `spam | inappropriate | copyright | misleading | other`.

Response — **201**:
```json
{ "success": true, "reportCount": 1, "softDeleted": false }
```
`softDeleted` is `true` when the count reaches the threshold (5) — the prompt
flips to `status: "reported"` with a 7-day appeal window.

Errors: `400` bad reason; `404` missing prompt; `403` reporting your own prompt;
`409` already reported or prompt not `published` or soft-deleted.

### `POST /prompts/:id/appeal` — auth (author only)

Body: `{ "reason": "…" }` (10–500 chars).

Response: `{ "success": true, "status": "appealed" }`

Errors: `403` not the author; `409` prompt not in `reported` state;
`400` appeal window (7 days) closed.

### `POST /prompts/:id/like` — auth

Toggle (idempotent).

Response: `{ "liked": false, "likeCount": 2 }` — or `{ "liked": true, "likeCount": 3 }`

Errors: `404` missing or not published.

### `POST /prompts/:id/share` — auth

Response: `{ "shared": true, "shareCount": 1 }`

Errors: `404` missing or not published.

---

## 5. Admin — prompts & moderation

All endpoints: `requireAuth` + admin email check. `403` if not admin.

### `POST /admin/prompts/bulk-upload/validate` — admin

Dry run. Multipart/form-data: field `csv` (prompts.csv) + repeated field
`images`, **or** a single field `bundle` (ZIP containing `prompts.csv` + images).
Limits: 30 MB/file, 501 files.

Response:
```json
{
  "success": true,
  "total": 120,
  "valid": 118,
  "failed": 2,
  "errors": [
    { "row": 5, "title": "Bad prompt", "reason": "Missing priceInr for paid prompt" }
  ]
}
```
`errors` rows are `{ row: number, title: string | null, reason: string }`.

Errors: `400` missing/empty CSV, missing prompts.csv in ZIP, invalid ZIP; `413`
file too large; multer errors mapped to 400.

### `POST /admin/prompts/bulk-upload` — admin

Same payload shapes as validate. Imports: uploads images once per filename,
creates prompt docs in batches, tags `importedBy: <adminEmail>`,
`importBatch: <ISO>`.

Response — **201**:
```json
{
  "success": true,
  "total": 120,
  "created": 118,
  "failed": 2,
  "errors": [
    { "row": 5, "title": "Bad prompt", "reason": "Missing priceInr for paid prompt" }
  ],
  "createdIds": ["…", "…"]
}
```

### `GET /admin/prompts/reports?status=reported|appealed` — admin

Query: `status`, `limit`, `offset`.

Response:
```json
{
  "prompts": [
    {
      "prompt": {
        "id": "…",
        "title": "…",
        "authorId": "uid",
        "status": "reported",
        "reportCount": 5,
        "reportedAt": "…",
        "appealStatus": "addressed",
        "appealReason": "…",
        "appealDeadline": "…",
        "appealedAt": "…"
      },
      "reports": [
        {
          "id": "…",
          "userId": "uid",
          "promptId": "…",
          "reason": "spam",
          "description": "…",
          "status": "pending",
          "createdAt": "…",
          "updatedAt": "…"
        }
      ]
    }
  ],
  "total": 3,
  "limit": 50,
  "offset": 0
}
```

### `POST /admin/prompts/:id/approve` — admin

Approve appeal → restore to published.

Response: `{ "success": true, "status": "published" }`

Errors: `404` missing; `409` no pending appeal (`"No pending appeal to approve"`).

### `POST /admin/prompts/:id/reject` — admin

Reject appeal → hard delete.

Response: `{ "success": true, "status": "deleted" }`

Errors: `404` / `409` (same pattern).

### `POST /admin/prompts/:id/dismiss-report` — admin

Dismiss pending reports → restore to published.

Response: `{ "success": true, "status": "published", "dismissedReports": 3 }`

Errors: `404` / `409` prompt not in reported/appealed state.

---

## 6. Me (profile & personal data)

All routes under `/me` — `requireAuth`.

> **User serialization** — every response's `user` object is `serializeUser()`
> output: `{ id, fullName, bio, avatarUrl, email, role, adFree }`. Bank/PAN/KYC
> fields are reachable **only** via `GET /me/bank`; subscriptions return a
> trimmed shape (no `gatewaySubscriptionId` — the raw Play purchase token never
> leaves the backend).

### `GET /me/profile`

Response:
```json
{
  "user": { "id": "uid", "fullName": "Jane Doe", "bio": "…", "avatarUrl": "…", "email": "jane@example.com", "role": "viewer", "adFree": false },
  "isAdmin": false,
  "subscription": {
    "planId": "pro",
    "planName": "Pro",
    "status": "active",
    "billingCycle": "monthly",
    "currentPeriodStart": "…",
    "currentPeriodEnd": "…",
    "perks": ["ad_free"],
    "platformFeePercent": 15,
    "canPostPaid": true,
    "adminPerk": false
  },
  "kycStatus": "not_submitted",
  "adFree": false
}
```
- `subscription` is `null` when the user has none. Admins always see the
  synthetic Creator subscription (`planId: "creator"`, `adminPerk: true`).
- `kycStatus` is `kyc.status ?? "not_submitted"`.
- The raw `user_subscriptions` doc id (`sub_<purchaseToken>`) and
  `gatewaySubscriptionId` are never returned.

### `PATCH /me/profile` — auth

Body (partial): `{ "fullName": "≤120", "bio": "≤300", "avatarUrl": "https://… ≤1000" }`

Response: `{ "user": { "…": "serializeUser shape (id, fullName, bio, avatarUrl, email, role, adFree)" } }`

### `GET /me/prompts` — auth

Query: `limit`, `offset`. **Your** prompts, newest first. Cards carry the full
body (they're yours) + your own moderation state (`status`, `reportCount`) —
never the reporters' identities.

Response: `{ "prompts": [ { "…": "public prompt fields (§10.3) + promptText, status, reportCount, isTrending, isNew" } ], "total": 12 }`

### `GET /me/saved` — auth

Your saved prompts, newest saved first. Body of paid prompts is gated like the
feed (author/buyer/admin/unpaid → unlocked).

Response:
```json
{
  "saved": [
    {
      "savedAt": "…",
      "prompt": {
        "…": "public prompt fields (§10.3)",
        "promptText": "…",           // only when unlocked
        "savedByMe": true,
        "unlocked": true
      }
    }
  ],
  "total": 3
}
```
Each entry is `{ savedAt, prompt }` — the raw savedPrompts join row (`id`,
`userId`, `promptId`) is not echoed.

### `GET /me/purchases` — auth

Paid prompts you own (completed purchases; deposit top-up and ad-free rows are
excluded). Body always unlocked.

Response:
```json
{
  "purchases": [
    {
      "purchaseId": "<buyerId>_<promptId>",
      "purchasedAt": "…",
      "priceInr": 99,
      "prompt": { "…": "public prompt fields + promptText (§10.3)", "unlocked": true, "savedByMe": false }
    }
  ],
  "total": 2
}
```

### `GET /me/transactions` — auth

Your ledger, newest first. Returns a **trimmed history row** (the internal
`refId`, gateway/fee settlement fields and `userId` are never exposed):
`{ id, type, direction, amountInr, balanceType, balanceAfterInr, note,
createdAt }`. `type` is one of `paid_prompt_sale`, `subscription_payment`,
`payout`, `purchase_void`, `purchase_void_shortfall`, deposit/referral/bonus
types, … (see §10.4 for the full ledger doc).

Response: `{ "transactions": [ { "id", "type", "direction", "amountInr", "balanceType", "balanceAfterInr", "note", "createdAt" } ], "total": 40 }`

### `GET /me/topups` — auth

Deposit-pack top-up history.

Response:
```json
{
  "topups": [
    {
      "id": "<buyerId>_deposit_m_<tokenSuffix>",   // per-purchase id (audit §1.3)
      "productId": "deposit_m",
      "priceInr": 100,
      "gatewayFeeInr": 15,
      "netDepositInr": 85,
      "bonusCreditInr": 15,
      "status": "completed",
      "createdAt": "…"
    }
  ],
  "total": 6
}
```

### `GET /me/notifications?unreadOnly=true&limit=&offset=` — auth

Inbox, newest first.

Response: `{ "notifications": [ "… §10.5" ], "total": 8 }`

### `POST /me/notifications/read` — auth

Body: `{ "ids": ["<notificationId>", "…"] }` (≤ 500). Only the caller's own rows
are touched (silently skip others').

Response: `{ "updated": 2 }`

### `GET /me/earnings` — auth

Creator earnings summary.

Response:
```json
{
  "earnings": {
    "totalEarnings": 4500,
    "salesCount": 32,
    "withdrawnInr": 2000,
    "pendingPayouts": 500,
    "balanceInr": 2000,
    "withdrawableBalance": 2000,
    "minWithdrawalInr": 60,
    "withdrawalEligible": true,
    "withdrawalBlockers": [],
    "currency": "INR"
  }
}
```

### `GET /me/earnings/prompts` — auth

Earnings per prompt (gross).

Response:
```json
{
  "prompts": [
    { "promptId": "…", "title": "…", "totalInr": 1200, "salesCount": 8 }
  ]
}
```

### `POST /me/upi` — auth

Body: `{ "upiId": "name@upi" }` (4–80 chars, `name@upi` shape).

Response: `{ "user": { "…": "serializeUser shape" } }`

### `POST /me/fcm-token` — auth

Register/refresh the caller's FCM push token (for device notifications — wallet
events, prompt sales, bonus expiry).

Body: `{ "token": "fcm-registration-token" }` (1–2048 chars; idempotent — the
latest token wins).

Response: `{ "success": true }`

Errors: `400` invalid body (expected `{ token: string }`); `401` signed out.

The token is stored on the `users` doc (`fcmToken` / `fcmTokenUpdatedAt`) but is
**never** returned in any `serializeUser()` response, and it is cleared on
`DELETE /me/account`.

### `GET /me/bank` — auth

Saved bank-transfer details for the withdrawal screen.

Response:
```json
{
  "bankDetails": {
    "panNumber": "ABCDE1234F",
    "panImageUrl": "https://…",
    "bankHolderName": "Jane Doe",
    "bankAccountNumber": "123456789012",
    "bankIfsc": "HDFC0001234",
    "bankBranch": "MG Road",
    "bankAccountImageUrl": "https://…",
    "complete": true
  }
}
```
`complete` is true only when all 7 fields are present. `bankDetails` is `null`
for a user with no saved data.

### `POST /me/bank` — auth

Body:
```json
{
  "panNumber": "ABCDE1234F",
  "bankHolderName": "Jane Doe",
  "bankAccountNumber": "123456789012",
  "bankIfsc": "HDFC0001234",
  "bankBranch": "MG Road"
}
```
Validation: PAN `[A-Z]{5}[0-9]{4}[A-Z]`, account `^\d{9,18}$`, IFSC
`[A-Z]{4}0[A-Z0-9]{6}`.

Response: `{ "user": { "…": "serializeUser shape" } }`

### `DELETE /me/bank` — auth

Clears PAN, account, branch and both KYC image URLs.

Response: `{ "user": { "…": "serializeUser shape" } }`

### `POST /me/bank/pan-image` — auth, raw image ≤ 3 MB

Response: `{ "user": { "…": "serializeUser shape" }, "panImageUrl": "https://…" }`

### `POST /me/bank/account-image` — auth, raw image ≤ 3 MB

Response: `{ "user": { "…": "serializeUser shape" }, "bankAccountImageUrl": "https://…" }`

### `POST /me/avatar` — auth, raw image ≤ 3 MB

Response: `{ "user": { "…": "serializeUser shape" }, "avatarUrl": "https://…" }`

### `DELETE /me/account` — auth

Soft-deletes the profile (PII redacted, financial rows kept), cancels the active
subscription, removes saved prompts and the Firebase Auth account (best-effort).

Response: `{ "success": true }`

Errors: `400` empty image on the upload routes; `413` > 3 MB;
`401` when signed out.

---

## 7. Payments

All routes under `/payments` — `requireAuth`. Money-mutating routes additionally
use the 60 req/min limiter (marked **⧗**).

### Product catalog (server side)

**Subscriptions** (`PLANS` / `PRODUCT_TO_PLAN`):

| productId | plan | priceInr | billingCycle | platformFee% | perks |
|---|---|---|---|---|---|
| `pro` | Pro | 99 | monthly | 15 | `ad_free` |
| `pro_annual` | Pro (Annual) | 999 | annual | 15 | `ad_free` |
| `creator` | Creator | 199 | monthly | 5 | `ad_free` |
| `creator_annual` | Creator (Annual) | 1999 | annual | 5 | `ad_free` |

**One-time products**:

| productId | name | priceInr | type |
|---|---|---|---|
| `ad_free` | Remove Ads (lifetime) | 149 | non_consumable |
| `deposit_s` | Deposit Pack S | 10 | consumable |
| `deposit_m` | Deposit Pack M | 100 | consumable |
| `deposit_l` | Deposit Pack L | 500 | consumable |
| `deposit_xl` | Deposit Pack XL | 1000 | consumable |

> Paid prompt unlocks do **not** use a Play Billing SKU — they're wallet-only.
> The app calls `POST /payments/wallet/buy` with `refId = prompt_<promptId>`
> (buyer pays `price × 1.05`, wallet covers the full total).

> The real Play Console product ids may differ; the route maps externals via
> `internalProductId()`/`playConsoleProductId()`. Dispatch in the app/backend is
> by the **internal** id listed here.

### `POST /payments/playbilling/verify`** ⧗** — auth

Verifies the token with Google and grants the entitlement. **503 when Play
Billing isn't configured** (`PLAY_BILLING_PACKAGE_NAME`) — a clean "not
configured" instead of a raw Google 400. **Paid prompt unlocks are wallet-only**
(`POST /payments/wallet/buy`) — a `prompt_*` productId here is rejected with
`400`.

Body:
```json
{
  "productId": "creator",
  "purchaseToken": "<play-billing-token>",
  "isSubscription": true
}
```
`isSubscription` optional (default `false`; also `"true"`/`"false"` accepted).

Dispatch by `productId`:

**a) Subscription** (`isSubscription` true, or a `PRODUCT_TO_PLAN` id):
```json
{
  "verified": true,
  "subscription": {
    "success": true,
    "planId": "creator",
    "planName": "Creator",
    "priceInr": 199,
    "billingCycle": "monthly",
    "perks": ["ad_free"],
    "subscriptionId": "sub_<purchaseToken>",
    "currentPeriodEnd": "…"
  }
}
```
Renewal/retry of the same token rolls the period forward (`status: "active"`).
The `ad_free` perk is granted via `users.adFree = true`, and a
`subscription_payment` debit ledger row is written.

**b) Ad-free** (`ad_free`):
```json
{ "verified": true, "success": true, "adFree": true, "priceInr": 149 }
```

**d) Deposit top-up** (`deposit_*`):
```json
{
  "verified": true,
  "success": true,
  "productId": "deposit_m",
  "priceInr": 100,
  "gatewayFeeInr": 15,
  "netDeposit": 85
}
```
The deposit is consumed (so the SKU can be re-purchased), net goes to `deposits`,
and the gateway fee is recycled into a 90-day `bonus` vintage keyed to the
per-purchase row id. On an idempotent replay a `note: "Already processed"` field
is added. Known to also swallow already-owned consume errors (doesn't block a
verified top-up).

Errors: `400` missing body / unknown product / purchase not active /
`prompt_*` not supported here (wallet-only); `401` (auth); `403`/`409` (admin or
already ad-free); `503` on config as above.

### `POST /payments/playbilling/void`** ⧗** — auth

Reverses a grant after a Play refund/void.

Body:
```json
{
  "productId": "deposit_m",
  "purchaseToken": "<token>",
  "isSubscription": false,
  "reason": "customer refund"
}
```
`reason` optional; `isSubscription` optional.

Responses by grant type:

Prompt:
```json
{ "success": true, "type": "prompt", "promptId": "…", "voided": true, "refundedInr": 103.95 }
```
Creator earnings are debited back, capped at their un-withdrawn balance (any
shortfall becomes a negative float tracked as a ledger note).

Deposit:
```json
{ "success": true, "type": "deposit", "productId": "deposit_m", "refundedNetInr": 85, "depositsNegative": false }
```
`depositsNegative: true` if the user already spent the net (owed balance).

Ad-free:
```json
{ "success": true, "type": "ad_free", "adFreeRevoked": true, "perkRetained": false }
```
`adFreeRevoked` is false when a subscription perk keeps ad-free.

Subscription (`isSubscription: true`):
```json
{ "success": true, "type": "subscription", "subscriptionId": "sub_<token>", "voided": true }
```

Errors: `404` no grant found; `409` already voided / token mismatch; `400`
unknown product.

### `DELETE /payments/subscriptions`** ⧗** — auth

Cancels the caller's active subscription locally (marked `cancelled`; paid
current period keeps benefits). Play-side cancellation is user-initiated.

Response:
```json
{
  "success": true,
  "subscriptionId": "sub_<purchaseToken>",
  "planId": "creator",
  "cancelledAt": "…",
  "note": "Also cancel in the Play Store (Subscriptions) to stop renewals"
}
```

Errors: `409` admins (`"Admins always have Creator access — there is no
subscription to cancel"`); `404` no active subscription.

### `GET /payments/wallet` — auth

Multi-balance wallet. See §10.2 for the exact shape.

```json
{
  "userId": "uid",
  "balances": {
    "deposits": { "amountInr": 85, "id": "deposits", "withdrawable": false, "maxUsePercent": 100, "expires": null, "notifyBeforeExpiry": null, "priority": 1, "description": "Credits from top-ups" },
    "earnings": { "amountInr": 2000, "id": "earnings", "withdrawable": true, "maxUsePercent": 100, "expires": null, "notifyBeforeExpiry": null, "priority": 2, "description": "Earnings from prompt sales" },
    "bonus": { "amountInr": 30, "id": "bonus", "withdrawable": false, "maxUsePercent": 10, "expires": 90, "notifyBeforeExpiry": 7, "priority": 3, "description": "Bonus credits from deposit fee-recycle, referrals, rewards, promos" }
  },
  "totalBalanceInr": 2115,
  "bonusCredits": [
    { "id": "<opaqueHash>", "amountInr": 30, "expiresAt": "2026-12-15T…" }
  ]
}
```
`bonusCredits` is the **sanitized** per-credit bonus breakdown — internal
vintage ids (purchase-row ids / Play-token derivations) are hashed to opaque
ids; the raw map keys are never exposed.

### `GET /payments/wallet/allocate?itemPriceInr=99` — auth

Read-only preview: how an item price would split across wallet buckets. For
paid prompts this mirrors the buy flow **bonus FIRST** (capped at 10% of
`itemPriceInr`), then **deposits → earnings**.

Response:
```json
{
  "itemPriceInr": 99,
  "bonus": 9.9,
  "deposits": 49.5,
  "earnings": 39.6,
  "totalCovered": 99,
  "remaining": 0,
  "split": [
    { "balanceType": "bonus", "amountToUse": 9.9 },
    { "balanceType": "deposits", "amountToUse": 49.5 },
    { "balanceType": "earnings", "amountToUse": 39.6 }
  ],
  "wallet": { "earnings": { "amountInr": 60 }, "deposits": { "amountInr": 50 }, "bonus": { "amountInr": 40 } }
}
```
`bonus` / `deposits` / `earnings` are the named per-bucket amounts to use (0 when
a bucket contributes nothing) — the app's purchase sheet renders these directly.
`wallet` is the user's available balances (so the UI can show "X of Y").
`split` is the raw per-bucket list (kept for back-compat). `split: []` with
`remaining` = price when nothing is covered.

Errors: `400` `itemPriceInr` must be a positive number.

### `POST /payments/wallet/spend`** ⧗** — auth

Debit wallet balances toward an item; the residual `remaining` is paid via Play
Billing. Idempotent by `refId` (a replay returns the same result).

Body: `{ "itemPriceInr": 99, "refId": "unique-client-op-id", "note": "optional" }`

Response:
```json
{
  "success": true,
  "split": [
    { "balanceType": "deposits", "debited": 85, "newBalance": 0 },
    { "balanceType": "bonus", "debited": 4.1, "newBalance": 25.9, "consumed": [ { "id": "a1b2c3d4e5f60718", "amount": 4.1 } ] }
  ],
  "totalCovered": 89.1,
  "remaining": 9.9,
  "wallet": { "…": "balances map §10.2 (post-debit)" }
}
```
No-funds variant: `{ success: true, totalCovered: 0, remaining: 99, wallet, note: "No wallet funds to spend" }`.
Replay variants add `reused: true`.

Errors: `400` `itemPriceInr` not positive / `refId` missing; `401` unauthenticated.

### `POST /payments/wallet/buy`** ⧗** — auth

**The only way to purchase a paid prompt** — paid prompt unlocks no longer go
through Play Billing (`playbilling/verify` rejects `prompt_*`). Buyer pays
`price × 1.05` (5% tx fee); the wallet covers the **full** total — **bonus up
to 10% of the raw price is consumed FIRST, then deposits → earnings cover the
balance** (the 5% transaction fee is always paid from deposits/earnings, never
bonus). Author credited the gross. In one transaction: debit the split, write
the completed `prompt_purchases` row (`gateway: "wallet"`), credit author
earnings, append sale ledger. Idempotent by `refId = prompt_<id>`.

Body: `{ "itemPriceInr": 99, "refId": "prompt_<promptId>" }`

Response:
```json
{
  "success": true,
  "unlocked": true,
  "promptId": "…",
  "purchaseId": "<buyerId>_<promptId>",
  "buyerPaysInr": 103.95,
  "transactionFeeInr": 4.95,
  "split": [
    { "balanceType": "bonus", "debited": 9.9, "newBalance": 15.6, "consumed": [ { "id": "a1b2c3d4e5f60718", "amount": 9.9 } ] },
    { "balanceType": "deposits", "debited": 91.05, "newBalance": 10.9 },
    { "balanceType": "earnings", "debited": 3, "newBalance": 27 }
  ],
  "wallet": { "…": "balances map §10.2 (post-debit)" }
}
```

`split` is the per-bucket debit breakdown in the buy spend order — **bonus →
deposits → earnings** (bonus first, capped at 10% of the raw price). Bonus
entries include `consumed` with the **hashed** vintage id (`id`) so the client
can show exactly how much bonus was used on a purchase without exposing
internal refIds.

Errors: `400` refId must be `prompt_<id>` / prompt free / price mismatch;
`401`; `404` prompt missing or unpublished; `409` already owns / admin;
**`402`** insufficient funds:
```json
{ "error": { "message": "Insufficient wallet balance — add ₹X to continue", "code": "BAD_REQUEST" }, "shortfall": 14.85 }
```
(the client routes to Top-up).

### `GET /payments/payouts/eligibility` — auth

Creator withdrawal eligibility + fee estimate.

```json
{
  "withdrawableBalance": 2000,
  "minWithdrawalInr": 60,
  "eligible": true,
  "blockers": [],
  "hasBankDetails": true,
  "hasUpi": false,
  "hasPaidPlan": true,
  "meetsMinimum": true,
  "currency": "INR",
  "platformFeePercent": 5,
  "estimatedFeeInr": 20,
  "estimatedPlatformFeeInr": 100,
  "estimatedNetInr": 1880,
  "netIfWithdrawNow": 1880
}
```
`blockers` is an array of human-readable strings when ineligible.

### `GET /payments/payouts` — auth

Your payout history.

Response:
```json
{
  "payouts": [ "… §10.8" ],
  "total": 2
}
```

### `POST /payments/payouts`** ⧗** — auth

Request a withdrawal (manual settle; account must have a paid plan + complete
bank details).

Body: `{ "amountInr": 1000 }` (positive integer).

Response — **201**:
```json
{
  "payout": {
    "id": "…",
    "amountInr": 1000,
    "status": "pending",
    "upiId": "name@upi",
    "panNumber": "ABCDE1234F",
    "bankHolderName": "Jane Doe",
    "bankAccountNumber": "123456789012",
    "bankIfsc": "HDFC0001234",
    "bankBranch": "MG Road",
    "platformFeeInr": 50,
    "feeInr": 60,
    "netInr": 890,
    "createdAt": "…"
  },
  "balanceInr": 1000,
  "minWithdrawalInr": 60,
  "currency": "INR"
}
```

Errors: `400` amount not a positive whole number / below minimum / missing bank
details / insufficient earnings; `403` no paid plan; `404` user missing;
`409` withdrawal already in flight.

### `GET /payments/admin/payouts?status=pending` — admin

Back-office payout list with transfer details.

Query: `status` (any of `pending | processing | paid | failed`), `limit`, `offset`.

Response:
```json
{
  "payouts": [
    {
      "…": "payout row §10.8",
      "user": {
        "id": "uid",
        "fullName": "…",
        "email": "…",
        "upiId": "…",
        "panNumber": "…",
        "bankHolderName": "…",
        "bankAccountNumber": "…",
        "bankIfsc": "…",
        "bankBranch": "…",
        "panImageUrl": "…",
        "bankAccountImageUrl": "…"
      }
    }
  ],
  "total": 5
}
```
`user` is `null` when the requesting user doc is gone.

### `POST /payments/admin/payouts/:id/mark-paid`** ⧗** — admin

Response: `{ "payout": "… payout row with status 'paid', processedAt set …" }`

Errors: `404` not found; `409` already paid / no longer pending.

### `POST /payments/admin/payouts/:id/mark-failed`** ⧗** — admin

Body: `{ "reason": "optional" }`.

Response: `{ "payout": "… status 'failed', failureReason, processedAt …" }`
(The reserved earnings debit is reversed and a credit ledger row written.)

Errors: `404` / `409` (same pattern).

### `PATCH /payments/admin/wallets/:id`** ⧗** — admin

Manual wallet adjustment (support/refund tooling).

Body:
```json
{
  "balanceType": "bonus",
  "deltaInr": 50,
  "note": "Goodwill credit"
}
```
`deltaInr` must be non-zero; positive credits, negative debits.

Response:
```json
{
  "success": true,
  "action": "credit",
  "balanceType": "bonus",
  "amountInr": 50,
  "wallet": { "…": "balances map §10.2 (post-change)" }
}
```

Errors: `400` unknown balance type / zero delta; `404` user missing;
`409` insufficient balance for a debit.

---

## 8. Referrals

Routes: `POST /code`, `GET /code`, `GET /:code/validate`, `POST /apply`,
`GET /stats`, `GET /list` — under `/referrals`. `requireAuth` on all except
`/:code/validate` (public). 30 req/min on `POST /code`, `/:code/validate`,
`POST /apply`.

### `POST /referrals/code` — auth, 30/min

Generate (or return existing) my code.

Response:
```json
{ "code": "AB3D9K2M", "alreadyExists": false }
```

### `GET /referrals/code` — auth

Returns my code, creating one if absent.

Response: `{ "code": "AB3D9K2M", "alreadyExists": true }`

### `GET /referrals/:code/validate` — public, 30/min

Response:
```json
{
  "valid": true,
  "code": "AB3D9K2M",
  "referrerName": "Jane Doe",
  "referrerId": "uid"
}
```
Invalid code → HTTP **400** `{ "error": { "message": "Invalid referral code", "code": "BAD_REQUEST" } }`.

### `POST /referrals/apply` — auth, oAuth-only, 30/min

Body: `{ "code": "AB3D9K2M", "playAccountId": "optional" }`

Applies the code at signup; credits both parties a **bonus** (defaults: referrer
₹50, referee ₹25 — `REFERRAL_BONUS_INR` / `REFERRAL_WELCOME_BONUS_INR`).

Response:
```json
{
  "success": true,
  "referrerBonus": 50,
  "refereeBonus": 25,
  "balanceType": "bonus"
}
```

Errors: `400` non-oAuth sign-in / own code / code limit reached / Google account
already bonused; `404` invalid code; `409` already referred;
`429` too many referrals from this network/IP.

### `GET /referrals/stats` — auth

Response:
```json
{
  "totalReferrals": 3,
  "totalBonusEarned": 150,
  "maxReferrals": 100,
  "remainingReferrals": 97,
  "bonusExpiryDays": 90,
  "referralCode": "AB3D9K2M"
}
```

### `GET /referrals/list` — auth

Query: `limit`, `offset`.

Response:
```json
{
  "referrals": [
    {
      "id": "<referrerId>_<refereeId>",
      "refereeId": "uid",
      "refereeName": "John Smith",
      "status": "completed",
      "completedAt": "…",
      "createdAt": "…"
    }
  ],
  "total": 3
}
```

---

## 9. Webhooks

### `POST /webhooks/google/rtdn` — public (origin-verified)

Google Play RTDN push. JSON body with Pub/Sub message shape. Mounted **before**
`express.json`'s 1 MB limit and the auth limiter (per `src/app.js`).

- No `message`/`data` → `200 { "received": true }`.
- Wrong push subscription (when `RTDN_SUBSCRIPTION` is set) →
  `403 { "error": "Invalid subscription" }`.
- Otherwise:

```json
{ "received": true, "status": "processed" }
```
`status` ∈ `processed | replay | error`. Errors always return **200** so Pub/Sub
doesn't retry-storm.

Handled events:
- Subscription lifecycle (from `subscriptionNotification.notificationType`):
  `SUBSCRIPTION_RENEWED` / `RESTARTED` (roll period, notify), `EXPIRED`
  (status → expired, notify), `CANCELED` (status → cancelled, notify).
  Unknown tokens are no-ops.
- One-time purchase void/refund (`inappProductId` present): looks up the
  `prompt_purchases` row by `gatewayOrderToken` and sends a `deposit_refund`
  inbox notification (the confirm endpoint already reversed the money).

---

## 10. Shared models

### 10.1 User (`users/{uid}`)

Internal doc fields (what a `users` doc *stores* — **not** what APIs return):

```json
{
  "id": "uid",
  "authProviderId": "uid",
  "email": "jane@example.com",
  "fullName": "Jane Doe",
  "bio": "…",
  "avatarUrl": "https://…",
  "signInProvider": "google.com",
  "role": "viewer",
  "upiId": "jane@okhdfcbank",
  "adFree": false,
  "adFreePurchasedAt": null,
  "adFreeSku": null,
  "panNumber": null,
  "panImageUrl": null,
  "bankHolderName": null,
  "bankAccountNumber": null,
  "bankIfsc": null,
  "bankBranch": null,
  "bankAccountImageUrl": null,
  "fcmToken": null,
  "fcmTokenUpdatedAt": null,
  "deleted": false,
  "createdAt": "…",
  "updatedAt": "…"
}
```
> **API contract:** responses expose `serializeUser(user)` =
> `{ id, fullName, bio, avatarUrl, email, role, adFree }` **only**. Bank/PAN/KYC
> fields (including image URLs) are reachable solely via `GET /me/bank`.
> Deleted accounts have `deleted: true`, `fullName: "Deleted User"`, and PII
> nulled (email, bio, avatar, upi, bank, authProviderId).

### 10.2 Wallet (`user_wallets/{userId}`)

Internal doc:

```json
{
  "earnings": 2000,
  "deposits": 85,
  "bonus": 30,
  "bonusVintages": {
    "<creditId>": { "remaining": 30, "expiresAt": "2026-12-15T…" }
  },
  "updatedAt": "…",
  "id": "uid"
}
```
- `earnings` — withdrawable sales income (fee applied at payout).
- `deposits` — the user's own top-up money (not withdrawable).
- `bonus` — expiring credit (90-day vintages, FEFO spend, ≤ 10% of a purchase).
- Balance-type metadata (as embedded in each `balances` entry) is defined in
  `src/services/../balance-types.js`; per-entry shape shown in §7.
- **API contract:** `GET /payments/wallet` returns `bonusCredits`
  (`[{ id: <opaqueHash>, amountInr, expiresAt }]`) — the internal
  `<creditId>` keys, which are purchase-row ids / refIds / Play-token
  derivations, are hashed and never sent to clients.

### 10.3 Prompt (public feed row / detail)

See §4 for serialization rules (whitelist on lists, `promptText` gating on
detail). The detail response is `toPromptDetail()` =
`toPublicPrompt` (`id, title, description, imageUrl, images, category, tags,
isPaid, priceInr, viewCount, saveCount, createdAt`) **plus** `authorId`,
`likeCount`, `shareCount`, `updatedAt`, and `promptText` (only when unlocked),
plus `author`, `savedByMe`, `unlocked`, `isTrending`, `isNew`.

Moderation internals (`status`, `reportCount`, `reportedBy`, `reportedAt`,
`appealStatus`, `appealReason`, `appealDeadline`, `appealedAt`) are **never**
returned by the public detail/feed endpoints — they exist only in the admin
moderation queue model (`GET /admin/prompts/reports`). The author sees their
own `reportCount`/`status` on `GET /me/prompts`.

### 10.4 Transaction (`transactions` doc)

Internal ledger doc (union of row fields):

```json
{
  "id": "…",
  "userId": "uid",
  "type": "paid_prompt_sale",
  "direction": "credit",
  "amountInr": 99,
  "balanceType": "earnings",
  "balanceAfterInr": 100,
  "refId": "<buyerId>_<promptId>",
  "note": "Sale of \"Prompt title\" — gross 99 (withdrawal fee at payout)",
  "gateway": "play_billing",
  "gatewayFeeInr": 15,
  "platformFeeInr": 0,
  "createdAt": "…",
  "updatedAt": "…"
}
```
`balanceType`, `gateway`, `gatewayFeeInr`, `platformFeeInr` are absent on legacy
rows written via `writeLedger` for some event types (e.g. `payout`).

**API contract:** `GET /me/transactions` returns only `{ id, type, direction,
amountInr, balanceType, balanceAfterInr, note, createdAt }` — the internal
`refId`, `gateway*`, `userId` and `updatedAt` are never emitted.

### 10.5 Notification (`notifications` doc)

```json
{
  "id": "uid_bonus_expiry_<vintageId>",
  "userId": "uid",
  "type": "bonus_expiry",
  "title": "Bonus expiring soon",
  "body": "🎁 Your ₹30 bonus expires in 3 days. Use it before it's gone!",
  "refId": "<vintageId>",
  "data": { "amountInr": 30, "expiresAt": "…" },
  "status": "unread",
  "readAt": null,
  "createdAt": "…",
  "updatedAt": "…"
}
```
Types emitted: `subscription_payment`, `subscription_renewed`,
`subscription_expired`, `subscription_cancelled`, `subscription_void`,
`prompt_unlocked`, `paid_prompt_sale`, `deposit_credit`, `deposit_refund`,
`ad_free`, `ad_free_void`, `purchase_void`, `purchase_void_author`,
`bonus_expiry`.

### 10.6 Plan + Subscription

`plan` object (as embedded in `/me/profile` → `subscription.plan`):

```json
{
  "id": "pro",
  "name": "Pro",
  "priceInr": 99,
  "billingCycle": "monthly",
  "dailyPostLimit": null,
  "canPostPaid": true,
  "platformFeePercent": 15,
  "perks": ["ad_free"],
  "isActive": true
}
```

`user_subscriptions` doc (internal — never returned verbatim):

```json
{
  "id": "sub_<purchaseToken>",
  "userId": "uid",
  "planId": "creator",
  "gateway": "play_billing",
  "gatewaySubscriptionId": "<purchaseToken>",
  "status": "active",
  "currentPeriodStart": "…",
  "currentPeriodEnd": "…",
  "cancelledAt": null,
  "createdAt": "…",
  "updatedAt": "…"
}
```
**API contract:** the profile `subscription` is trimmed by
`serializeSubscription()` — `{ planId, planName, status, billingCycle,
currentPeriodStart, currentPeriodEnd, perks, platformFeePercent, canPostPaid,
adminPerk }`. The doc id and `gatewaySubscriptionId` (the raw Play purchase
token, used by the void/refund flow) are never returned.

### 10.7 Purchase (`prompt_purchases` doc)

Written for prompt unlocks (id `{buyerId}_{promptId}`), ad-free
(`{userId}_ad_free`), and per-purchase deposits (`{userId}_{productId}_<tokenSuffix>`):

```json
{
  "id": "<buyerId>_<promptId>",
  "buyerId": "uid",
  "promptId": "…",
  "authorId": "author-uid",
  "priceInr": 99,
  "buyerPaysInr": 103.95,
  "transactionFeeInr": 4.95,
  "platformFeePercent": 5,
  "netInr": 94.05,
  "gateway": "play_billing",
  "gatewayOrderToken": "<purchaseToken>",
  "gatewayFeeInr": 15,
  "gatewayFeePercent": 14.5,
  "gatewayFeeSource": "calculated",
  "status": "completed",
  "createdAt": "…",
  "updatedAt": "…"
}
```
Wallet-bought prompts are identical except `gateway: "wallet"`, `gatewayFeeInr: 0`,
`gatewayFeePercent: 0`, `gatewayFeeSource: "wallet"`. Voided rows add `voidedAt`
and `voidReason`. Deposit rows: `promptId` = the pack id, `authorId: null`,
`buyerPaysInr == priceInr`, `transactionFeeInr: 0`.

### 10.8 Payout (`payouts` doc)

```json
{
  "id": "…",
  "userId": "uid",
  "amountInr": 1000,
  "status": "pending",
  "upiId": "name@upi",
  "panNumber": "ABCDE1234F",
  "bankHolderName": "Jane Doe",
  "bankAccountNumber": "123456789012",
  "bankIfsc": "HDFC0001234",
  "bankBranch": "MG Road",
  "platformFeeInr": 50,
  "feeInr": 60,
  "netInr": 890,
  "processedAt": null,
  "failureReason": null,
  "createdAt": "…",
  "updatedAt": "…"
}
```
`status` ∈ `pending | processing | paid | failed`.

### 10.9 Balance maintainer note

`user_balances/{userId}` (`{ balanceInr, updatedAt }`) is a legacy mirror kept in
sync by `writeLedger` and still read as the pre-write balance source in some
paths; the wallet (`user_wallets`) is the balance source of truth.

---

## 11. Quick endpoint checklist

| Method | Path | Auth | Public |
|---|---|---|---|
| GET | /health | — | ✅ |
| POST | /auth/login | — | ✅ |
| POST | /auth/dev/login | — | ✅ (dev only) |
| POST | /prompts | ✅ | |
| POST | /prompts/image | ✅ | |
| GET | /prompts | optional | ✅ |
| GET | /prompts/:id | optional | ✅ |
| GET | /prompts/:id/image | optional | ✅ |
| DELETE | /prompts/:id | ✅ | |
| POST | /prompts/:id/save | ✅ | |
| POST | /prompts/:id/unsave | ✅ | |
| POST | /prompts/:id/report | ✅ (5/h) | |
| POST | /prompts/:id/appeal | ✅ | |
| POST | /prompts/:id/like | ✅ | |
| POST | /prompts/:id/share | ✅ | |
| POST | /admin/prompts/bulk-upload | admin | |
| POST | /admin/prompts/bulk-upload/validate | admin | |
| GET | /admin/prompts/reports | admin | |
| POST | /admin/prompts/:id/approve | admin | |
| POST | /admin/prompts/:id/reject | admin | |
| POST | /admin/prompts/:id/dismiss-report | admin | |
| GET | /me/profile | ✅ | |
| PATCH | /me/profile | ✅ | |
| GET | /me/prompts | ✅ | |
| GET | /me/saved | ✅ | |
| GET | /me/purchases | ✅ | |
| GET | /me/transactions | ✅ | |
| GET | /me/topups | ✅ | |
| GET | /me/notifications | ✅ | |
| POST | /me/notifications/read | ✅ | |
| GET | /me/earnings | ✅ | |
| GET | /me/earnings/prompts | ✅ | |
| POST | /me/upi | ✅ | |
| POST | /me/fcm-token | ✅ | |
| GET | /me/bank | ✅ | |
| POST | /me/bank | ✅ | |
| DELETE | /me/bank | ✅ | |
| POST | /me/bank/pan-image | ✅ | |
| POST | /me/bank/account-image | ✅ | |
| POST | /me/avatar | ✅ | |
| DELETE | /me/account | ✅ | |
| POST | /payments/playbilling/verify | ✅ | |
| POST | /payments/playbilling/void | ✅ | |
| DELETE | /payments/subscriptions | ✅ | |
| GET | /payments/wallet | ✅ | |
| GET | /payments/wallet/allocate | ✅ | |
| POST | /payments/wallet/spend | ✅ | |
| POST | /payments/wallet/buy | ✅ | |
| GET | /payments/payouts/eligibility | ✅ | |
| GET | /payments/payouts | ✅ | |
| POST | /payments/payouts | ✅ | |
| GET | /payments/admin/payouts | admin | |
| POST | /payments/admin/payouts/:id/mark-paid | admin | |
| POST | /payments/admin/payouts/:id/mark-failed | admin | |
| PATCH | /payments/admin/wallets/:id | admin | |
| POST | /referrals/code | ✅ | |
| GET | /referrals/code | ✅ | |
| GET | /referrals/:code/validate | — | ✅ |
| POST | /referrals/apply | ✅ | |
| GET | /referrals/stats | ✅ | |
| GET | /referrals/list | ✅ | |
| POST | /webhooks/google/rtdn | — | ✅ (origin-verified) |