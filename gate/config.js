// Two values, both filled in after the one-time setup:
//   1. APPS_SCRIPT_URL — the CUSTOMER deployment's /exec URL (the one with
//      "Anyone" access). staffCall requests go here too now, authenticated
//      by a verified Google ID token instead of Apps Script's own session —
//      see backend/README.md. Do NOT point this at the old "Anyone with a
//      Google account" staff deployment; that one still exists only to serve
//      Badge.html (see printUrl() in staff.js).
//   2. GOOGLE_CLIENT_ID — from Google Cloud Console → APIs & Services →
//      Credentials → OAuth client ID (Web application). Must match the
//      GOOGLE_CLIENT_ID constant in backend/Code.gs exactly.
window.APP_CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbyY8ZP9wDvr1m7ru5GpAMobmBsyHQH-A3AfjVP2aaRR23LZVS6AzPPMsKwX_FpMluE1/exec",
  GOOGLE_CLIENT_ID: "202833902564-rdob60vtlpt2bo9nvf0tdm7dmvaaqjvp.apps.googleusercontent.com"
};
