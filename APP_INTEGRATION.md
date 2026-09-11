# APP_INTEGRATION.md — What the backend needs from the Android app

> **Contract for app-side integration.** The backend is being built ahead of the
> app. This file records — for each feature — exactly *what data the app must
> send*, *the shape*, and *where it goes*, so the app team can implement against
> it without the backend having to wait. Anything here is a **known app-side
> dependency**; it is deliberately scoped so the backend never blocks on it.
>
> Legend: ✅ = backend already accepts this shape → app can send it anytime.
> ◐ = backend stored, but has no consumer yet. ⛔ = not built yet.

---

## 1. Auth — `POST /auth/login`

Already built. The app sends a Firebase ID token; the backend verifies it and
upserts the `users/{uid}` doc from the token claims.

```jsonc
POST /auth/login
{
  "idToken": "<firebase-auth-id-token>",
  // Referral Phase 3 (see §2): optional — only needed at signup
  "referralCode": "WORTHY-TIGER-1",      // ✅ processed server-side (Phase 3)
  "playAccountId": "<1.2.9408901...>",   // ✅ stored + used for anti-abuse (Phase 3)
}
```

Backend stores `signInProvider` from the decoded token
(`decoded.firebase.sign_in_provider`) for the oAuth-only referral gate. **Nothing
to do app-side to send it** — it's already derived server-side.

When `referralCode` is present at signup, the backend applies it
(`applyReferralCode`, oAuth-only gate + Play Account ID + IP anti-abuse) and
returns `{ referral: { applied: true|false, ... } }` in the login response. It
never blocks login — a failed apply is returned as info, not an error.

---

## 2. Referral signup (Phase 3) — app-side TODO

When the plans/referrals phase builds, the app must pass the signup-time fields
below. Backend will validate oAuth-only + rate-limit on them. **Not active yet.**

| Field | Shape | Where the app gets it | Required? |
|---|---|---|---|
| `referralCode` | string, in the login body | The code the user typed/shared | at signup |
| `playAccountId` | string (Play Account ID, e.g. `1.2.9408901...`) | `PlayCore` / Google Play services | at signup (anti-fraud) |
| `ipAddress` | auto from request | backend derives from `req.ip` | backend-side |

---

## 3. Bonus-expiry push reminder (Phase 2) — app-side TODO

`getBonusExpiringSoon(userId)` already computes which bonus vintages expire
within 7 days. To actually **deliver** a push, the app must register an **FCM
device token**:

| Field | Shape | Where the app gets it | Status |
|---|---|---|---|
| `deviceToken` | string (FCM registration token) | `firebase.messaging().getToken()` | ◐ backend will store; **no endpoint yet** |
| `platform` | `'android'` | constant | ◐ |
| `appVersion` | string | `BuildConfig.VERSION_NAME` | ◐ |

Backend will expose `POST /me/device-token { token, platform?, appVersion? }`
(auth'd) to register. The app calls it at login/launch (and on token refresh).
See `src/services/wallet.service.js` → `getBonusExpiringSoon`.

> **Alternative (no app change):** an in-app **inbox/notification** — the backend
> writes a `notifications` doc and the app polls `GET /me/notifications` at
> launch. Works with zero native-push setup, shows on next open. Decide A (FCM
> push) vs B (inbox) when the reminder is wired.

---

## 4. Play Console side (not code) — for Phase 1 testing

These are **Google Play Console** owner tasks, not backend code. The backend is
waiting for a real Android build + tester list before it can be end-tested
against Play Billing's sandbox (`plans/play-billing.md` §10 "Test with Play
Console internal track").

| Item | What it is | Needs |
|---|---|---|
| Android package name | `com.promptlyai.app` (env `PLAY_BILLING_PACKAGE_NAME`) | the app's real `applicationId` |
| Products (one-time) | `ad_free`, `prompt_<id>`, `deposit_s/m/l/xl` | created in Play Console, prices set |
| Subscriptions SKUs | `pro`, `pro_annual`, `creator`, `creator_annual` | created in Play Console, prices set |
| Test licensees | a Google account in the internal track | so the app can buy without charging |
| RTDN Pub/Sub | topic + push subscription → `POST /webhooks/google/rtdn` | Cloud Console setup (owner) |

---

## 5. Enterprise / future — nothing needed yet

Nothing else. Keep this file updated as new app-side data requirements appear.

---

## 6. Bonus-expiry inbox (Phase 2, built) — app-side TODO (optional)

The bonus-expiry reminder (wallet.md §5.4) is delivered as an **in-app inbox** —
zero native-push setup. The backend writes a `notifications` row when a bonus
vintage is within 7 days of expiry; the app **polls at launch** (and can poll on
foreground) instead of registering FCM tokens. This is the plan-sanctioned
alternative to §3's push route and works with no app change at all.

| Endpoint | Shape | Notes |
|---|---|---|
| `GET /me/notifications?unreadOnly=true&limit=&offset=` | 🔐 auth | Newest-first inbox. `rows: [{ id, userId, type, title, body, refId, data, status:'unread'\|'read', createdAt, updatedAt }]`, `total` |
| `POST /me/notifications/read` | 🔐 auth, `{ ids: string[] }` | Mark mine as read. Only the caller's own rows are touched. Returns `{ updated }` |

The daily sweep (`npm run wallet:expire`) fills the inboxes. **App-side:** call
`GET /me/notifications?unreadOnly=true` at launch; show unread count as a badge
and the list in a notifications screen; call `POST /me/notifications/read` when
the user opens one. Nothing blocks if the app ignores it — inboxes just build up
until the vintages expire.