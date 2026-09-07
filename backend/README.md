# Backend — Google Sheet + Apps Script

Four files go into one Apps Script project:

| File | What it is |
|---|---|
| `Code.gs` | All server code — the public JSON API **and** the staff `svc()` API |
| `Staff.html` | Legacy Apps-Script-hosted console shell — kept working, but the Vercel-hosted `staff/index.html` is the one staff actually use now |
| `Badge.html` | The A6 badge print page — still Apps-Script-hosted, see below |

**Public API** (no login): `listEvents`, `getEventForm`, `register`, `getMyPass`,
and now **`staffCall`** too — served from `doGet`/`doPost` as JSON on the
**customer ("Anyone")** deployment.

**Staff API** (`bootstrap`, `dashboard`, `checkin`, `attendees`, `fields`,
`setCheckedIn`, `addWalkin`, `deleteAttendee`, `history`, `csv`, `saveFields`,
`saveBadgeConfig`, `createEvent`, `setEventProp`, `team`, `setRole`,
`addTeamMember`, `badgeData`) all live behind one `svc()` entry point. There
are two ways in:
- **`staffCall`** (current) — the Vercel-hosted console calls this over plain
  HTTP with a Google ID token in the body. `verifyIdToken_()` checks it
  against Google directly; the verified email is what `svc()`'s calls
  authorize against, never anything the client claims.
- **`google.script.run`** (legacy) — only works from `Staff.html` itself,
  same-origin inside Apps Script's HtmlService, riding on
  `Session.getActiveUser()`. Still there as a fallback; not what's deployed
  to staff day to day.

## Why identity moved to an OAuth ID token

The original design served `Staff.html` from Apps Script specifically so
`Session.getActiveUser()` would work — same-origin, no CORS. That produced a
real problem: the only URL staff had was the long
`script.google.com/macros/s/.../exec` one, painful to type or share with a
whole team, and `Session.getActiveUser()` doesn't always come back populated
even when signed in (see the `no_identity` message in the console — this
still exists as a fallback path).

The fix is to host the console UI wherever's convenient (Vercel, short URL)
and stop depending on same-origin session tricks for identity. Google
Identity Services gives the page a **signed ID token** after sign-in; the
backend verifies that token itself via Google's `tokeninfo` endpoint
(checking `aud` matches our OAuth client and `email_verified`) rather than
trusting a session that cookies can't carry cross-origin anyway.

## Deploy

1. Create a new Google Sheet.
2. **Extensions → Apps Script**, delete the boilerplate `Code.gs` content, paste in
   this folder's `Code.gs`. Then add two HTML files — click **+ → HTML** twice and
   name them exactly **`Staff`** and **`Badge`** (Apps Script appends `.html`
   itself), pasting in `Staff.html` and `Badge.html`.
3. In the Apps Script editor, select `setupSheets` from the function dropdown and
   click **Run** (once). This creates the `Events`, `Fields`, and `Registrations`
   sheets with headers, seeds 4 sample events (matching the design's prototype
   data), and generates a random `QR_SECRET` in Script Properties. Safe to re-run —
   it skips sheets/rows that already exist.
4. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Copy the resulting `/exec` URL.
5. Paste that URL into the **events-checkin** repo's `customer/config.js` as
   `API_URL` (that repo is the public registration site; this repo doesn't hold it).
6. Optional but recommended — in **Project Settings → Script properties**, add
   `CUSTOMER_SITE_URL` pointing at the deployed customer site, so the confirmation
   email's reopen link actually works.
7. Also run `setupTeamAccessSheet` (once) from the same function dropdown. This
   creates a **second, separate** Google Sheet file — "Event Check-in — Team
   Access" — holding just the `Staff` allowlist (email, name, role, event
   scope, gate), and stores its ID in Script Properties as `STAFF_SHEET_ID`.
   It's deliberately not a tab in the customer-data sheet from step 3 — see
   "Team access is a separate file" below.

Redeploy (**Deploy → Manage deployments → Edit → New version**) after any code change —
editing `Code.gs` alone doesn't update the live `/exec` URL's behavior. **`staffCall`
runs on this deployment** (the "Anyone" one), so a `Code.gs` change that touches any
staff-side function needs this one redeployed too, not just deploy #2 below.

## Enabling the Vercel-hosted console (Google Sign-In)

This is what makes staff.js's sign-in screen actually work — without it, every
sign-in attempt fails with `google_client_id_not_configured`.

1. **Google Cloud Console → APIs & Services → Credentials.**
2. If prompted, configure the OAuth consent screen first: User type **External**,
   fill in an app name + support email, save. Testing mode is fine — add each
   staff member's email under **Test users**, or publish the app if you'd rather
   skip that list.
3. **+ Create Credentials → OAuth client ID** → Application type **Web application**.
4. **Authorized JavaScript origins** → add the Vercel URL this repo deploys to
   (e.g. `https://staff-console-teal.vercel.app`). No redirect URI needed — the
   sign-in button flow doesn't use one.
5. Copy the resulting Client ID (`xxxx.apps.googleusercontent.com` — not a secret,
   safe to commit in frontend code) into **two places**, exactly matching:
   - `GOOGLE_CLIENT_ID` in `Code.gs`
   - `GOOGLE_CLIENT_ID` in `staff/config.js`
6. Also fill `APPS_SCRIPT_URL` in `staff/config.js` with the **customer/"Anyone"**
   `/exec` URL from step 4 above (not the deploy-#2 URL below).
7. Push `Code.gs` (re-paste + redeploy deploy #1, the "Anyone" one — see above) and
   `staff/config.js` (`git push`, Vercel picks it up automatically).

## Deploy #2 — legacy Apps-Script-hosted console (Badge.html needs this)

Staff no longer use this URL day to day — the Vercel-hosted `staff/index.html` is
the real console now. This deployment stays for two things: `Badge.html` (the A6
print page, still session-based — see `printUrl()` in `staff.js`) and as a fallback
if you ever need the old same-origin path.

1. **Deploy → New deployment → Web app** again:
   - Execute as: **Me**
   - Who has access: **Anyone with a Google account** ← different from deploy #1
2. Open that `/exec` URL while signed in with a Google account that is listed in the
   **Team Access** sheet. You should land on the legacy console (or, for Badge.html,
   a printable badge).

**If it says Google didn't send your email:** the deployment can't identify the
visitor. Edit it to `Execute as: User accessing the web app` and share the Google
Sheet with each staff member (Viewer is enough).

**Gate names** come from the `gate` column of the Team Access sheet — that's what gets
written on every check-in, so set it per person before the event.

## Team access is a separate file

Who can see/edit customer `Registrations` and who can see/edit staff `role`s
are two different access decisions. Keeping `Staff` in the same file as
customer data means anyone with edit rights on one has a path to the other —
so it lives in its own spreadsheet ("Event Check-in — Team Access"),
referenced by ID (`STAFF_SHEET_ID` in Script Properties) via
`SpreadsheetApp.openById()`, rather than as a tab in the file this script is
bound to. Share the two files with different people/groups in Google Drive as
your access rules require.

`findStaffByEmail_()` looks a person up by email and returns their
`role`/`event_scope`/`gate`. Every staff-side call goes through
`currentStaff_()` -> `findStaffByEmail_()` (see `requireStaff_()`), whether the
email came from a verified OAuth ID token (`staffCall`) or
`Session.getActiveUser()` (legacy `google.script.run` path) — per the handoff
doc's rule that role must never be trusted from the client.

## Notes / deliberate scope trims

- **CORS**: the frontend POSTs with `Content-Type: text/plain;charset=utf-8` (JSON
  in the body) instead of `application/json`, and reads with plain query-string
  GETs. Both are browser "simple requests" that skip the CORS preflight — Apps
  Script has no `doOptions`, so a real preflight would fail.
- **Reopen link**: the handoff doc calls for a separate reopen token (distinct
  from the QR's HMAC signature) that expires 7 days after the event. This build
  instead reopens by email via `getMyPass`, same as the design's own "Open my QR"
  screen — simpler, and it's what the shipped design actually does. Add the
  expiring-token scheme later if cross-device reopen-by-link (not just by typing
  an email) becomes a requirement.
- **Custom per-event fields**: `Fields`/`getEventForm` exist per the handoff
  doc's endpoint table, but the shipped Customer design has a fixed 4-question
  flow (name -> email -> phone -> org, PDPA consent folded into the last step
  — pass type is no longer asked there at all; staff assign it from the
  console) — it doesn't render fields
  dynamically. The customer frontend doesn't call `getEventForm` for that
  reason; it's here for the Staff Console (or a future dynamic-fields version
  of this page) to use.
- **No duplicate-registration guard**: matches the prototype, which always
  creates a new row. Add an idempotency check if re-submits become a problem.
