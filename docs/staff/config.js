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
  APPS_SCRIPT_URL: "REPLACE_WITH_YOUR_APPS_SCRIPT_WEB_APP_URL",
  GOOGLE_CLIENT_ID: "REPLACE_WITH_YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com"
};
