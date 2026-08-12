# Promptly AI — Backend

Backend for **Promptly AI**, an AI-prompt marketplace. **Node.js + Express + Sequelize +
PostgreSQL** (plain JavaScript, ESM). Supports free/pro/creator subscriptions, paid prompt
unlocks, and creator payouts — all money routed through **Razorpay** in the live app.

> The mobile/UI app is **UI-only today** (in-memory mocks). This backend is designed so
> the UI can swap its mock repository for this live API without visual changes. The data
> model lives in `src/db/models/*.js`.

## Stack

- **Node.js ≥ 20** + **Express 4** (ESM, no build step)
- **Sequelize 6** ORM + **PostgreSQL** (hosted: Neon / Supabase / Railway / RDS), `pg` driver
- **zod** for env + input validation
- `helmet`, `cors`, `morgan` middleware

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Create your environment file
copy .env.example .env     # Windows
# cp .env.example .env     # macOS/Linux

# 3. Paste your PostgreSQL connection string into .env as DATABASE_URL
#    (e.g. from a free Neon or Supabase project). `sslmode=require` is pre-set.

# 3b. (Payments) Put your Razorpay keys in .env, plus the Subscription Plan IDs:
#    create two plans in dashboard.razorpay.com → Settings → Plans ("Pro" ₹49/mo,
#    "Creator" ₹99/mo), then set RAZORPAY_PLAN_PRO_ID / RAZORPAY_PLAN_CREATOR_ID.
#    Set RAZORPAY_WEBHOOK_SECRET to the secret from Settings → Webhooks and point the
#    webhook URL at your server's POST /webhooks/razorpay.

# 4. Create/update the tables from the models
npm run db:sync

# 5. Seed starter data (plans, demo creator, sample prompts, a ledger row)
npm run db:seed

# 6. Start the dev server (auto-restarts on file changes)
npm run dev                # http://localhost:3000
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Run with hot reload (`node --watch`) |
| `npm start` | Run without watch |
| `npm run db:sync` | Create/update tables from models (`sequelize.sync({ alter })`) |
| `npm run db:seed` | Seed starter data (idempotent) |
| `npm run db:reset` | **Destructive** — drop + recreate tables, then seed (dev only) |

> ⚠️ `db:sync` is a dev convenience. Before production, adopt real migrations
> (`sequelize-cli`) so schema changes are versioned and safe on a live database.

## Deploy on Render

This repo ships a `render.yaml` blueprint — one-click deploy:

1. **Push this repo to GitHub** (done — `origin` is set).
2. Render dashboard → **New → Blueprint** → connect the repo → **Apply**.
   (`render blueprint launch` works too if you use the Render CLI.)
3. In the new service → **Environment**, set the secrets (marked `sync: false` in
   the blueprint so they never live in the repo):
   - `DATABASE_URL` — the same Neon connection string as local
   - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`
   - `RAZORPAY_WEBHOOK_SECRET` — **use a real secret**, not the dev placeholder
   - `RAZORPAY_PLAN_PRO_ID`, `RAZORPAY_PLAN_CREATOR_ID`
   - `PUBLIC_BASE_URL` is pre-set to `https://promptly-ai-backend.onrender.com`
   - Do **not** set `PORT` — Render injects its own.
4. Deploy. The health check (`/health`) runs automatically.

**One-time DB setup:** your Neon DB is already synced + seeded from local dev, so
nothing to do. If you ever point this at a fresh database, run once from the
Render **Shell** tab (or locally against the same DB):

```bash
npm run db:sync
npm run db:seed
```

**After deploy:** point Razorpay's webhook at `https://<service>.onrender.com/webhooks/razorpay`.
In **test mode** you can use a tunnel (ngrok / cloudflared) to forward to your
local server, which is handy for debugging webhooks against your dev environment.

**Notes for Render**
- Free tier spins down after ~15 min idle; the first hit after idle is a cold
  start. Webhooks stay safe because the handler is idempotent (Razorpay retries,
  and a duplicate delivery is a no-op).
- Swap `rzp_test_*` → `rzp_live_*` and set a real webhook secret before real money.

## API surface (current)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | – | App status + DB ping (`SELECT 1`) |
| POST | `/auth/dev/login` | – | **Dev only.** `{ email }` → upserts user, returns `{ token, user }`. Swap point for Firebase/Supabase. |
| GET | `/prompts` | optional | List published prompts. `?category=`, `?paid=free|paid`, `?sort=trending|new|recent`, `?q=` |
| GET | `/prompts/:id` | optional | Prompt detail. Paid prompt text unlocked only for owner/unlockers. |
| POST | `/prompts/:id/save` | ✅ | Save a prompt (idempotent). Returns `{ saved, saveCount }`. |
| POST | `/prompts/:id/unsave` | ✅ | Remove a save (idempotent). Returns `{ saved, saveCount }`. |
| GET | `/me/profile` | ✅ | Signed-in user profile + current subscription + KYC state |
| GET | `/me/prompts` | ✅ | Prompts the user has published |
| GET | `/me/saved` | ✅ | Saved prompts (join table) |
| GET | `/me/transactions` | ✅ | **My Account** ledger (from `transactions`) |
| GET | `/me/earnings` | ✅ | Creator earnings summary (lifetime, withdrawn, pending, balance) |
| GET | `/me/earnings/prompts` | ✅ | Per-prompt earnings breakdown |
| POST | `/payments/checkout/order` | ✅ | Create a Razorpay order for a paid prompt. Body `{ promptId }` → `{ orderId, amountInr, currency, feePercent, feeInr, netInr }`. |
| POST | `/payments/checkout/verify` | ✅ | Verify the payment + unlock. Body = Razorpay Checkout success payload `{ promptId, orderId, paymentId, signature }`. Writes the purchase + ledger. |
| POST | `/payments/subscriptions` | ✅ | Create a Razorpay subscription. Body `{ planId: "pro" | "creator" }` → `{ subscription: { razorpaySubId, shortUrl, … } }`. The app opens `shortUrl` to collect the first payment. |
| POST | `/payments/payouts` | ✅ | Request a withdrawal (**manual settle**, min ₹60). Body `{ amountInr }`. Requires verified KYC + bank account; reserves the balance as `pending`. |
| GET | `/payments/admin/payouts` | ✅ | **Admin (solo dev).** List payout requests with full bank details. `?status=pending`. ⚠️ not role-gated — dev only. |
| POST | `/payments/admin/payouts/:id/mark-paid` | ✅ | **Admin.** Mark a pending payout `paid` after you've transferred the money. |
| POST | `/payments/admin/payouts/:id/mark-failed` | ✅ | **Admin.** Mark a payout `failed`; the reserved balance is returned to the creator. |
| POST | `/webhooks/razorpay` | signature | Verify `X-Razorpay-Signature` (HMAC), log idempotently to `webhook_events` (unique `dedupe_key`), dispatch `subscription.charged` / `.cancelled` / `.expired`. |

Auth uses a **Bearer token** where the token *is* the user id in dev
(`Authorization: Bearer <user-id>`), issued by `/auth/dev/login`. Replace
`src/middleware/auth.js` + `src/routes/auth.js` with real JWT verification
(Firebase/Supabase) before launch.

Example:

```bash
curl -s http://localhost:3000/health
curl -s -X POST http://localhost:3000/auth/dev/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@promptly.app"}'
# → { "token": "<uuid>", "user": { ... } }

curl -s http://localhost:3000/prompts?paid=free
curl -s http://localhost:3000/prompts?sort=trending
curl -s http://localhost:3000/me/transactions \
  -H 'Authorization: Bearer <token>'
```

## Local vs live base URL

The backend has **two** base URLs — local for testing, live for production — and
both are defined in **one place**, `src/config/urls.js`:

| URL | Value | When |
|---|---|---|
| `BASE_URLS.local` | `http://localhost:3000` | `NODE_ENV` = development |
| `BASE_URLS.live` | `PUBLIC_BASE_URL` env (default `https://promptly-ai-backend.onrender.com`) | `NODE_ENV` = production |

`getApiBaseUrl()` picks the right one automatically. CORS always allows both
(local + live), plus anything in `CORS_ORIGINS` — so a browser frontend on
`:8081` or `:5173` can call the local API during dev.

**How the frontend switches:** the real toggle is an `API_BASE_URL` constant in
your app (there's no frontend in this repo yet). The universal pattern is:

```js
const API_BASE_URL = __DEV__ ? 'http://localhost:3000' : 'https://promptly-ai-backend.onrender.com';
```

Per stack: Expo → `EXPO_PUBLIC_API_URL` in `.env.development`/`.env.production`;
Vite/web → `VITE_API_URL`; Flutter → `--dart-define=API_BASE_URL=...`. Mobile
apps don't need CORS at all.

⚠️ **Android emulator** can't reach your machine via `localhost` — use
`http://10.0.2.2:3000`. **Physical phone** → use your computer's LAN IP on the
same Wi-Fi.

## Money model (Razorpay, live app)

```
Subscriptions  Buyer ──(₹/mo, Razorpay Subscriptions)──► Platform (recurring)
Paid prompts   Buyer ──(₹, Razorpay Checkout)──────────► Platform pool
                                                         │  net = price × (100 − fee%) / 100  (Pro=5%, Creator=0%)
                                                         ▼
                                                  Creator balance
                                                         │  withdraw (min ₹60) → request
                                                         │  admin transfers via OWN bank app
                                                         ▼
                                                  Creator's bank account
```

**Why "manual settle"?** RazorpayX Payouts (automatic bank transfer to a third party) is
**business-only** — a solo individual can't create a payout route. So the payout flow here
is: the creator requests a withdrawal → a `payouts` row is created (`pending`) and the
balance is **reserved** (ledger debit) → the developer (you) transfers the money from your
own bank app → `POST /payments/admin/payouts/:id/mark-paid` flips it to `paid`. No
RazorpayX involved. `mark-failed` reverses the reservation.

- All money is stored as **integer rupees** (never floats).
- `prompt_purchases` freezes `price_inr / platform_fee_inr / net_inr` at sale time.
- Every credit/debit writes one row to `transactions` (the My Account ledger).
- Payouts reserve the balance *at request time* — `pending` money can't be double-withdrawn.
- Webhooks are idempotent: a unique `dedupe_key` (hash of event + payload) makes replays
  no-ops, so a doubled delivery can't double-charge a subscription.
- ⚠️ `bank_accounts.account_number_full` stores the full account number in **plaintext** for
  the manual transfer. **Encrypt it before real money** (see "Before launch").

## Data model

12 tables (see `src/db/models/*.js`): `users`, `subscription_plans`, `user_subscriptions`,
`prompts`, `user_posts`, `prompt_purchases`, `transactions`, `payouts`, `bank_accounts`,
`kyc_verifications`, `saved_prompts`, plus `webhook_events` for idempotent Razorpay webhook
replay.

Key invariants baked into the models:
- One unlock per buyer per prompt → unique index `(buyer_id, prompt_id)`
- Saved prompts → composite primary key `(user_id, prompt_id)`
- KYC is 1:1 with users → unique `user_id`
- Hot queries indexed: `prompts(category, is_paid)`, `prompts(created_at)`,
  `user_posts(user_id, posted_on)`, `transactions(user_id, created_at)`,
  `prompt_purchases(author_id)`
- Daily post limit derives from `COUNT(user_posts WHERE posted_on = today)` — no counter
  column to drift.

### Metrics & how they're computed

| Metric | Where it lives | How it's computed |
|---|---|---|
| `view_count` | `prompts` column | `recordPromptView()` bumps it by 1 on `GET /prompts/:id` (fire-and-forget) |
| `save_count` | `prompts` column | `POST /prompts/:id/save` / `/unsave` increment/decrement it (floor 0) as they maintain the `saved_prompts` join table |
| `savedByMe` | response annotation | Set-membership from `saved_prompts` for the signed-in viewer (list + detail) |
| `is_trending` | **derived, not stored** | `view_count + save_count >= 100` (see `src/services/prompt-metrics.js`); also the `sort=trending` ordering |
| `is_new` | **derived, not stored** | `created_at` within 7 days |
| Earnings | derived from `prompt_purchases` | `net_inr = price_inr × (100 − fee%) / 100` frozen at sale; summary + per-prompt in `/me/earnings*` |
| Author name | `prompt.author` object | Every prompt list/detail response includes `author: { id, fullName, avatarUrl, role }` |

## Project structure

```
src/
  server.js              # entrypoint: listens on PORT, graceful shutdown
  app.js                 # Express app assembly (raw body for webhooks, JSON elsewhere)
  config/env.js          # zod-validated environment
  db/
    config.js            # Sequelize instance + pingDb()
    models.js            # imports + associates all models (relationship map)
    models/              # one file per table
    sync.js              # npm run db:sync
    seed.js              # idempotent seed
    reset.js             # npm run db:reset (destructive)
  middleware/            # auth (dev), error handler, 404
  routes/                # HTTP layer — thin, delegates to services
  services/              # business logic + all Sequelize queries
    ledger.js            # shared running-balance + writeLedger() helpers
    prompt-metrics.js    # derived isTrending / isNew from counts + age
    earnings.service.js  # creator earnings aggregation from prompt_purchases
    webhooks.service.js  # verify → idempotent log → dispatch by event
    payments/            # Razorpay: checkout, subscriptions, manual-settle payouts
```

## Roadmap / not yet built

- Real Firebase/Supabase auth (`src/middleware/auth.js` + `src/routes/auth.js` are the swap points)
- **Admin role gating** — the `/payments/admin/*` endpoints currently trust any signed-in
  user. Add a real admin check before launch.
- Refund flow (`prompt_purchases.status = 'refunded'` → reverse ledger rows)
- **Encrypt** `bank_accounts.account_number_full` (and the KYC `pan`) — plaintext today, test-mode only
- RazorpayX Payouts — only if/when you register a **business** account; the manual-settle
  flow is the solo-individual path
- Real migrations (`sequelize-cli`) to replace `db:sync` for production
- Rate limiting, request logging to a service, tests
