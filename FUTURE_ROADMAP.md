# Roadmap — Flipkart-style prompt marketplace + Dream11/Vision11-style engagement

Status: **proposal**, nothing implemented yet. Every endpoint below is designed to
reuse the existing wallet/ledger/claim invariants (single Firestore transaction,
`refId` idempotency, FEFO bonus, `wallet_spend:` claim seam) so no new financial
infrastructure is needed.

## Phase 1 — Discovery & conversion (Flipkart-style)

| Method | Path | Why |
|---|---|---|
| `GET` | `/search/suggest?q=` | Typeahead over titles + tags (≤10, sorted by saves). Reuses the in-memory browse set. |
| `GET` | `/prompts/:id/related` | Same category + overlapping tags, excluding the viewed prompt. Flipkart "you may also like" cross-sell. |
| `GET` | `/me/recently-viewed` | Deduped, time-bounded history (writes ride the existing `recordPromptView`). |
| `GET` | `/deals` | Flash-sale rail: `salePriceInr` + `dealEndsAt`, admin-curated. Scarcity for an otherwise flat-price catalog. |
| `GET` | `/creators/:id/storefront` | Public creator page: profile, follower count, stats, top prompts. Seller-storefront parity. |
| `POST` | `/prompts/:id/reviews` | Purchaser-only star rating + text review (gated via `prompt_purchases`); review list embeds in `GET /prompts/:id`. The missing trust signal for paid prompts. |

## Phase 2 — Social engagement + creator tools

| Method | Path | Why |
|---|---|---|
| `POST` | `/users/:id/follow` | Idempotent follow join row — the wedge for feeds + creator-nudge notifications. |
| `GET` | `/me/feed` | New prompts from followed creators (+ purchased creators). Dream11 "Groups" analog. |
| `POST` | `/collections`, `GET` `/me/collections`, `GET` `/me/collections/:id` | Named boards for saved prompts (Flipkart wishlist folders). |
| `PATCH` | `/prompts/:id` | Edit title/desc/text/price/tags + schedule (`publishAt`, optional `status: 'scheduled'`). Gumroad draft→live. |
| `GET` | `/me/analytics` | KPI dashboard (`?window=7d\|30d\|all`): views, saves, likes, shares, purchases, revenue, conversion. |
| `GET` | `/me/analytics/prompts/:id` | Per-prompt views→saves→purchases funnel. |

## Phase 3 — Fantasy + wallet monetization (Dream11 / Vision11)

| Method | Path | Why |
|---|---|---|
| `POST` | `/challenges` | Create themed challenge: window, entry fee, max entrants, prize tiers + platform cut. |
| `GET` | `/challenges` (+ `?feeRange=`) | Contest lobby — pool size + spots left, urgency. |
| `GET` | `/challenges/:id` | Detail incl. my rank + top-N. |
| `POST` | `/challenges/:id/join` | Pay entry fee from wallet (idempotent claim, reuses `debitBalances`); submit the entry prompt. |
| `GET` | `/challenges/:id/leaderboard` | Live ranked board with prize-tier columns. |
| `POST` | `/prompts/:id/tips` | Tip a creator from deposits/bonus → author earnings (capped, ledgered). |
| `POST` | `/bundles`, `GET` `/bundles/:id`, `POST` `/payments/bundles/:id/buy` | Buy 2–10 prompts in one wallet payment (same `price × 1.05` + split/FEFO seam as `wallet/buy`). |
| `POST` | `/requests`, `GET` `/requests`, `POST` `/requests/:id/claims` | Request-a-prompt: buyers post demand, creators claim, price rides the audited `wallet/buy` path. |

**Intentional exclusions:** price-drop push alerts and achievement/streak badges
(gamified but no new business transaction; derive server-side later), delivery
tracking (N/A for digital goods).

---

## API hygiene — done alongside this (Sept 2026)

Exploratory audit found several endpoints returning unwanted/leaky data. Fixed:

- **`GET /prompts/:id`** (and saved/purchased lists): moderation internals
  (`reportedBy` — reporter identities, `reportCount`, appeal fields, `status`)
  are removed from public detail. Whitelisted via `toPromptDetail()`. These
  fields now exist only in the admin moderation queue.
- **`GET /me/profile`** + auth + all `/me` mutation responses: full user doc →
  `serializeUser()` (`id, fullName, bio, avatarUrl, email, role, adFree`).
  Bank/PAN/KYC only via `GET /me/bank`.
- **Subscription in profile:** trimmed — the raw Google Play purchase token
  (`gatewaySubscriptionId`, `sub_<token>` doc id) is no longer serialized.
- **`GET /payments/wallet`:** raw `bonusVintages` keys (purchase-row ids /
  Play-token suffixes / refIds) → sanitized `bonusCredits: [{ id, amountInr,
  expiresAt }]` with hashed ids. Same for top-up history ids.
- **`GET /me/transactions`:** trimmed history row (dropped `refId`,
  `gateway*`, `userId`, `updatedAt`).
- **`GET /me/earnings`:** dropped the duplicated `wallet.balances` (already at
  `GET /payments/wallet`).
- **`GET /payments/payouts` + admin list:** bank snapshot no longer echoed on
  every history row; admin list dedupes the PII (single copy from the embedded
  live user).

Contract = `API_REFERENCE.md` (updated in lockstep).