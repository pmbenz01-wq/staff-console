# Backend — Google Sheet + Apps Script

Three files go into one Apps Script project:

| File | What it is |
|---|---|
| `Code.gs` | All server code — the public JSON API **and** the staff `svc()` API |
| `Staff.html` | The Staff Console page (a thin shell; the UI loads from GitHub Pages) |
| `Badge.html` | The A6 badge print page |

**Public API** (customer site, no login): `listEvents`, `getEventForm`, `register`,
`getMyPass` — served from `doGet`/`doPost` as JSON.

**Staff API** (Google login required): `bootstrap`, `dashboard`, `checkin`,
`attendees`, `fields`, `setCheckedIn`, `addWalkin`, `deleteAttendee`, `history`,
`csv`, `saveFields`, `saveBadgeConfig`, `createEvent`, `setEventProp`, `team`,
`setRole`, `badgeData` — all behind the single `svc()` entry point, called from
the console via `google.script.run`, never over HTTP.

## Why the Staff Console is served by Apps Script, not GitHub Pages

Google sign-in is the whole point of the staff side — every check-in has to record
*who* scanned it. That only works if the page runs on the same origin as the script:
`Session.getActiveUser().getEmail()` is populated, and `google.script.run` needs no
CORS. A staff page hosted on GitHub Pages calling a login-required Apps Script URL
would be redirected to Google's login page and blocked by CORS.

So `Staff.html` is served by Apps Script — but it's deliberately a thin shell that
loads `staff.css` / `staff.js` from GitHub Pages. **UI changes are a `git push`;
only `Code.gs` changes need a redeploy.**

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
5. Paste that URL into `../customer/config.js` as `API_URL`.
6. Optional but recommended — in **Project Settings → Script properties**, add
   `CUSTOMER_SITE_URL` pointing at wherever you host the `customer/` folder, so the
   confirmation email's reopen link actually works.
7. Also run `setupTeamAccessSheet` (once) from the same function dropdown. This
   creates a **second, separate** Google Sheet file — "Event Check-in — Team
   Access" — holding just the `Staff` allowlist (email, name, role, event
   scope, gate), and stores its ID in Script Properties as `STAFF_SHEET_ID`.
   It's deliberately not a tab in the customer-data sheet from step 3 — see
   "Team access is a separate file" below.

Redeploy (**Deploy → Manage deployments → Edit → New version**) after any code change —
editing `Code.gs` alone doesn't update the live `/exec` URL's behavior.

## Deploy #2 — the Staff Console

The same project gets a **second** deployment, with different access settings. This
is what staff open in a browser.

1. **Deploy → New deployment → Web app** again:
   - Execute as: **Me**
   - Who has access: **Anyone with a Google account** ← different from deploy #1
2. Open that `/exec` URL while signed in with a Google account that is listed in the
   **Team Access** sheet. You should land on the console.
3. Give the URL to your staff. Anyone not on the allowlist gets a clear "you're not
   on the team list" screen naming the exact row they need added.

**If the console says Google didn't send your email:** the deployment can't identify
the visitor. Edit that deployment to `Execute as: User accessing the web app` and
share the Google Sheet with each staff member (Viewer is enough). The console's error
screen spells this out too.

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

This is scaffolding, not a finished feature: `findStaffByEmail_()` looks a
person up by email and returns their `role`/`event_scope`/`gate`, but nothing
calls it yet — no staff-only endpoint exists in this file. When the Staff
Console backend is built, its `checkin`/`searchAttendees`/etc. handlers should
call `findStaffByEmail_(Session.getActiveUser().getEmail())` to authorize,
per the handoff doc's rule that role must never be trusted from the client.

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
  doc's endpoint table, but the shipped Customer design has a fixed 5-question
  flow (name → email → phone → org → type) — it doesn't render fields
  dynamically. The customer frontend doesn't call `getEventForm` for that
  reason; it's here for the Staff Console (or a future dynamic-fields version
  of this page) to use.
- **No duplicate-registration guard**: matches the prototype, which always
  creates a new row. Add an idempotency check if re-submits become a problem.
