# Staff Console — Event Check-in

The staff half of the Event Check-in system, split out of the `events-checkin`
repo into its own repo so the two can be worked on and deployed independently.

**They still share one Google Sheet.** The "database" was never tied to a repo
in the first place — it's a Google Sheet + Apps Script project, reached only
through the Apps Script backend in `backend/`. Splitting repos just moves
where the *source code* is tracked; the running Apps Script deployment, the
Spreadsheet, and its data are untouched by this split.

## What's here

- **`staff/`** — the Staff Console UI (dashboard, QR scanning, attendee
  management, badge config, team roles). Hosted on GitHub Pages, but *loaded
  by* the Apps Script page (`Staff.html`'s `ASSET_BASE`) rather than visited
  directly — that's what makes Google sign-in work. See
  `../events-checkin`'s original README for why.
- **`backend/`** — `Code.gs` (the full API: public customer endpoints *and*
  the staff `svc()` API), `Staff.html`, `Badge.html`. This is the single
  Apps Script project both the customer site and this console call.
- **`docs/`** — build output, don't edit. Mirrors `staff/` for GitHub Pages.
  Regenerate with `./sync-docs.sh` after any change under `staff/`.

## How the split works day to day

- Edit `staff/` → `./sync-docs.sh` → commit + push. Pages picks it up in a
  minute; nothing to redeploy in Apps Script.
- Edit `backend/Code.gs` → paste into the Apps Script project → redeploy both
  Web App deployments (customer + staff — see deploy notes below).
- The customer site (`events-checkin` repo) never needs to change for
  anything here — it only knows the deployed `/exec` URL.

## Deploy

Same Apps Script project as before — this repo didn't create a new one, it
just now tracks that project's source instead of `events-checkin` doing so.
If you're setting this up for the first time, see the deploy steps this
repo's `backend/` used to live under in `events-checkin`'s history, or ask
for them again.

**One thing that changed:** `Staff.html` and `Badge.html` now load their
assets from `https://pmbenz01-wq.github.io/staff-console/staff` instead of
the old `.../Events-checkin/staff`. If you're migrating an existing
deployment, re-paste both files and redeploy the staff Web App once — Code.gs
itself is unchanged.
