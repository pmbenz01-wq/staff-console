# Backend — Google Sheet + Apps Script

## Data topology — one file per event

Customer data is **not** one shared spreadsheet anymore. Three kinds of file:

- **Overview** — whatever spreadsheet `Code.gs` is bound to
  (`SpreadsheetApp.getActiveSpreadsheet()`). Holds:
  - `Events` — event display metadata, same as before, plus a
    `spreadsheet_id` column: the ID of that event's own file (see below).
    This makes it the central registry.
  - `BadgeConfig`, `AuditLog` — unchanged, still centralized here.
  - `AllRegistrations` — a live mirror of every `Registrations` row across
    all events, written by `register()` (and `svcAddWalkin_`) only. It
    exists so `getMyPass()` (cross-event "find my pass by email") stays fast
    without opening every event's file on each search.
- **One file per event** — created by `createEventFile_(eventId, name, extraFields)`,
  the same `SpreadsheetApp.create()` pattern `setupTeamAccessSheet()` already
  used. Holds exactly `Fields`, `Registrations` (source of truth), and
  `Checkins` for that one event only. `eventFileId_()` (cached ~6h via
  `CacheService`) and `openEventFile_()` resolve which file to open for a
  given `eventId`.
- **Team Access** — unchanged, still its own separate file (see below).

Run `setupSheets()` once to seed the 4 demo events, each into its own new
file. It's safe to re-run: an event already holding a non-empty
`spreadsheet_id` in the registry is left alone rather than getting a
duplicate Drive file. `svcCreateEvent_` (the console's "new event" action)
uses the same `createEventFile_()` helper, and rolls back (trashes) the
Drive file it just created if writing the registry row afterward fails.

**Known limitations, not bugs:**
- **No Drive-ACL automation.** Creating a per-event file does not share it
  with anyone but the script owner — handing an organizer their own file is
  a manual **File → Share** step. This also means Team-Access roles and
  actual Drive file permissions are two unsynced systems: revoking someone's
  STAFF role does **not** revoke direct Sheets access if they were ever
  shared a file directly.
- **`AllRegistrations` is lookup-only, not reporting-ready.** It's written
  once, on registration. Check-in status, soft-deletes, and pass-type
  changes made afterward are **not** propagated to it. Fine for `getMyPass`
  ("does this email have a badge"); a future cross-event CRM/reporting
  screen would need to either read it more carefully or read from each
  event's own file instead.
- **No fallback on a mirror-write miss.** The mirror write is
  lock-protected and best-effort (try/catch), same pattern as the
  confirmation email — but if it silently fails anyway, `getMyPass` reports
  `not_found` with no recovery path.
- **Direct file edits during a live event are a real risk.** `svcCheckin_`
  and similar snapshot rows via `getDataRange().getValues()`, then write
  back by absolute row number. Someone with direct file access
  inserting/sorting/deleting a row mid-event can make a later write land on
  the wrong row, silently. Recommend sharing a per-event file as **Viewer**
  during the event and **Editor** only before/after, rather than relying on
  a code fix.

## Files

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
   click **Run** (once). This sets up the Overview file's `Events`/`BadgeConfig`/
   `AuditLog`/`AllRegistrations` tabs, creates 4 **new spreadsheet files** (one per
   demo event, via `createEventFile_`) and registers their IDs into `Events.spreadsheet_id`,
   and generates a random `QR_SECRET` in Script Properties. Safe to re-run — an
   event that already has a file registered is left alone, so this never spawns
   duplicate Drive files.
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
