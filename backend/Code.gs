/**
 * Event Check-in — Apps Script backend for the customer-facing site.
 *
 * Implements the public endpoints from "Handoff - Google Sheet และ Apps Script":
 *   listEvents, getEventForm, register, getMyPass
 *
 * The Staff Console lives in the same project but does NOT go through this
 * JSON API: it is a Vercel-hosted page calling the svc() entry point via the
 * 'staffCall' action (Google ID token auth) — see the "STAFF CONSOLE API"
 * section at the bottom. A legacy same-origin Apps-Script-hosted path
 * (Staff.html + google.script.run) still works as a fallback.
 *
 * DATA TOPOLOGY — one file per event, plus two shared files:
 *   - THIS file (whatever Code.gs is bound to) is the "Overview" file: a
 *     central Events registry (event_id -> which file holds that event's
 *     detail data, plus display metadata), BadgeConfig, AuditLog, and a
 *     live-mirrored AllRegistrations table (written by register(), read by
 *     getMyPass() for the cross-event "find my pass by email" lookup — that
 *     lookup has to stay fast, so it reads this mirror instead of opening
 *     every event's file).
 *   - Each EVENT gets its own spreadsheet file (created by createEventFile_),
 *     holding just that event's Fields, Registrations, and Checkins — see
 *     eventFileId_()/openEventFile_(). This is what makes per-event access
 *     control possible (Drive sharing is per-file); see backend/README.md
 *     for what that does and doesn't automate.
 *   - Team access (Staff allowlist) lives in its own separate file — see the
 *     "Team access" section below and setupTeamAccessSheet().
 *
 * requireStaff_() is the single gate every staff call passes through.
 *
 * Deploy: see README.md in this folder.
 */

var SHEETS = {
  EVENTS: 'Events',
  FIELDS: 'Fields',
  REGISTRATIONS: 'Registrations',
  CHECKINS: 'Checkins',
  BADGE: 'BadgeConfig',
  AUDIT: 'AuditLog',
  ALL_REG: 'AllRegistrations'
};

// spreadsheet_id: which per-event file holds this event's Fields/
// Registrations/Checkins — see eventFileId_()/openEventFile_()/createEventFile_().
// hidden: an "archived" event — its own Registrations/Checkins/Fields file
// and all data stay exactly as they are, it just stops appearing in the
// PUBLIC listEvents() (the customer picker). Staff still see it (and can
// un-hide it) via allEventsRows_() in svcBootstrap_.
// image_url: a public https image for the customer picker card / form banner
// (falls back to the striped placeholder client-side when blank).
var EVENTS_HEADERS = ['event_id', 'name', 'date_display', 'place', 'status_label', 'seats_label', 'price_label', 'accent', 'theme', 'open', 'short_label', 'spreadsheet_id', 'hidden', 'image_url', 'pdpa', 'doors_at'];
var FIELDS_HEADERS = ['event_id', 'key', 'label', 'type', 'required', 'sort_order'];
var REG_HEADERS = ['reg_id', 'event_id', 'badge_code', 'qr_token', 'full_name', 'email', 'phone', 'org', 'type', 'answers_json', 'source', 'status', 'registered_at', 'consent_at', 'checked_in_at', 'checked_in_by', 'gate', 'device_id', 'scan_count', 'updated_at', 'updated_by'];
// Append-only scan history — one row per scan attempt, never overwritten, so
// "who scanned whom, when, at which gate" is always answerable after the fact.
var CHECKIN_HEADERS = ['scan_id', 'event_id', 'reg_id', 'badge_code', 'name', 'scanned_at', 'scanned_by', 'gate', 'device_id', 'result', 'client_scan_id'];
var BADGE_HEADERS = ['event_id', 'size', 'show_logo', 'show_org', 'show_type', 'show_qr', 'show_bar'];
var AUDIT_HEADERS = ['log_id', 'at', 'actor', 'action', 'event_id', 'target_id', 'detail'];

// ---------------------------------------------------------------------------
// One-time setup — run this once from the Apps Script editor (select
// `setupSheets` in the function dropdown, then Run) before deploying.
// Safe to re-run: it only creates sheets/seed rows that don't exist yet.
// This sets up CUSTOMER data only — see setupTeamAccessSheet() below for the
// separate team/roles spreadsheet.
// ---------------------------------------------------------------------------
function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEETS.EVENTS, EVENTS_HEADERS);
  migrateHeaders_(ss.getSheetByName(SHEETS.EVENTS), EVENTS_HEADERS);
  ensureSheet_(ss, SHEETS.BADGE, BADGE_HEADERS);
  ensureSheet_(ss, SHEETS.AUDIT, AUDIT_HEADERS);
  ensureSheet_(ss, SHEETS.ALL_REG, REG_HEADERS);
  seedDemoEvents_();
  seedBadgeConfig_();
  ensureQrSecret_();
  // Fields/Registrations/Checkins used to live in this (bound) file; they now
  // live per-event (see createEventFile_). Drop the old shared tabs now that
  // seedDemoEvents_ has moved every event onto its own file — pre-launch,
  // there's no live data in them worth preserving.
  ['Fields', 'Registrations', 'Checkins'].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) ss.deleteSheet(sh);
  });
  Logger.log('Setup complete. Sheets ready, QR secret ' + (PropertiesService.getScriptProperties().getProperty('QR_SECRET') ? 'present' : 'MISSING'));
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.appendRow(headers);
  return sh;
}

// Appends any headers a pre-existing sheet is missing (e.g. spreadsheet_id,
// added to Events by the per-event-file migration) as new trailing columns,
// leaving existing columns and data untouched. No-op if already current.
function migrateHeaders_(sh, headers) {
  var existing = sh.getLastRow() > 0 ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
  var missing = headers.filter(function (h) { return existing.indexOf(h) < 0; });
  if (missing.length) sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
}

// Demo data — 4 events, each getting its OWN spreadsheet file (via
// createEventFile_). Idempotent two ways, so setupSheets() is safe to re-run
// AND safe to run against a pre-existing (pre-per-event-files) sheet:
//   - event_id already has a non-empty spreadsheet_id -> fully set up, skip.
//   - event_id row exists (old schema, e.g. from before this migration) but
//     spreadsheet_id is blank -> create its file and fill in that one cell,
//     rather than appending a duplicate row.
//   - event_id doesn't exist at all -> append a brand-new row.
function seedDemoEvents_() {
  var demo = [
    { id: 'tt', name: 'ThinkTech Summit 2026', date: '18–19 ธ.ค. 2569', place: 'ไบเทค บางนา · ฮอลล์ 2', status: 'เปิดรับ', seats: 'เหลือ 240 ที่', price: 'ไม่มีค่าใช้จ่าย', accent: '#d8482b', theme: 'editorial', open: true, short: 'THINKTECH SUMMIT · 2026', extra: [['org', 'บริษัท / องค์กร', 'TEXT', false, 4]] },
    { id: 'gala', name: 'Annual Partner Gala', date: '24 ธ.ค. 2569', place: 'ดุสิตธานี · แกรนด์บอลรูม', status: 'เชิญเท่านั้น', seats: 'เหลือ 32 ที่', price: 'ตามบัตรเชิญ', accent: '#a8874f', theme: 'brass', open: true, short: 'PARTNER GALA · 2026', extra: [['diet', 'ข้อจำกัดด้านอาหาร', 'SELECT', false, 4]] },
    { id: 'lab', name: 'Founder Lab · รุ่น 4', date: '9 ม.ค. 2570', place: 'ทองหล่อ · ชั้น 6', status: 'เปิดรับ', seats: 'เหลือ 18 ที่', price: '2,500 บาท', accent: '#2f6b4f', theme: 'forest', open: true, short: 'FOUNDER LAB · 04', extra: [['role', 'ตำแหน่งงาน', 'TEXT', true, 4]] },
    { id: 'roadshow', name: 'Regional Roadshow', date: '22 ก.พ. 2570', place: 'เชียงใหม่ · เซ็นทรัลเฟส', status: 'เร็ว ๆ นี้', seats: 'ยังไม่เปิดรับ', price: 'ไม่มีค่าใช้จ่าย', accent: '#2f4d8c', theme: 'ink', open: false, short: 'REGIONAL ROADSHOW', extra: [] }
  ];
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.EVENTS);
  var t = readSheet_(SHEETS.EVENTS);
  var col = {}; t.headers.forEach(function (h, i) { col[h] = i + 1; });
  demo.forEach(function (e) {
    var rowIdx = -1;
    for (var i = 0; i < t.rows.length; i++) { if (t.rows[i][0] === e.id) { rowIdx = i; break; } }
    if (rowIdx >= 0 && t.rows[rowIdx][col.spreadsheet_id - 1]) return; // already set up
    var fileId = createEventFile_(e.id, e.name, e.extra);
    if (rowIdx >= 0) {
      sh.getRange(rowIdx + 2, col.spreadsheet_id).setValue(fileId);
    } else {
      sh.appendRow([e.id, e.name, e.date, e.place, e.status, e.seats, e.price, e.accent, e.theme, e.open, e.short, fileId]);
    }
  });
}

// Creates a brand-new spreadsheet file for one event — Fields, Registrations,
// Checkins tabs with headers, default Fields seeded (name/email/phone plus
// any extraFields). Returns the new file's ID. Used by both svcCreateEvent_
// and seedDemoEvents_, so this creation logic exists in exactly one place.
function createEventFile_(eventId, name, extraFields) {
  var ss = SpreadsheetApp.create(name + ' — Event Check-in');
  ensureSheet_(ss, SHEETS.FIELDS, FIELDS_HEADERS);
  ensureSheet_(ss, SHEETS.REGISTRATIONS, REG_HEADERS);
  ensureSheet_(ss, SHEETS.CHECKINS, CHECKIN_HEADERS);

  var rows = [
    [eventId, 'name', 'ชื่อ–นามสกุล', 'TEXT', true, 1],
    [eventId, 'email', 'อีเมล', 'EMAIL', true, 2],
    [eventId, 'phone', 'เบอร์โทรศัพท์', 'PHONE', true, 3]
  ].concat((extraFields || []).map(function (f) { return [eventId].concat(f); }));
  ss.getSheetByName(SHEETS.FIELDS).getRange(2, 1, rows.length, FIELDS_HEADERS.length).setValues(rows);

  var defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) ss.deleteSheet(defaultSheet);

  return ss.getId();
}

// Registry lookup: event_id -> the ID of the spreadsheet file holding that
// event's Fields/Registrations/Checkins. Cached — this mapping never changes
// after an event is created — so the check-in hot path doesn't re-read the
// Events registry on every scan.
function eventFileId_(eventId) {
  var cache = CacheService.getScriptCache();
  var key = 'eventFile:' + eventId;
  var cached = cache.get(key);
  if (cached) return cached;
  var ev = eventById_(eventId);
  if (!ev || !ev.spreadsheet_id) throw new Error('event_not_found');
  cache.put(key, ev.spreadsheet_id, 21600); // 6h
  return ev.spreadsheet_id;
}

function openEventFile_(eventId) {
  return SpreadsheetApp.openById(eventFileId_(eventId));
}

function seedBadgeConfig_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.BADGE);
  if (sh.getLastRow() > 1) return; // already seeded
  var rows = ['tt', 'gala', 'lab', 'roadshow'].map(function (id) {
    return [id, 'A6', true, true, true, true, true];
  });
  sh.getRange(2, 1, rows.length, BADGE_HEADERS.length).setValues(rows);
}

function ensureQrSecret_() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('QR_SECRET')) {
    props.setProperty('QR_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
}

// ---------------------------------------------------------------------------
// Team access — kept in a SEPARATE spreadsheet file from customer data, on
// purpose: who can see/edit customer Registrations and who can see/edit staff
// roles are two different access decisions, and putting them in one file
// means anyone with edit rights on one has a path to the other. This script
// project still owns both files; it just opens the team-access one by ID
// (stored in Script Properties) instead of by getActiveSpreadsheet().
//
// Run setupTeamAccessSheet() once, alongside setupSheets(). Nothing calls
// findStaffByEmail_() yet — no staff endpoint exists in this file — but the
// Staff Console backend should call it from its own requireStaff()-style
// check rather than re-deriving role/scope logic.
// ---------------------------------------------------------------------------
var TEAM_SHEETS = { STAFF: 'Staff', SESSIONS: 'Sessions' };
var STAFF_HEADERS = ['email', 'name', 'role', 'event_scope', 'gate', 'pw_hash', 'pw_set_at'];
var SESSION_HEADERS = ['token_hash', 'email', 'created_at', 'expires_at', 'revoked'];

// ---------------------------------------------------------------------------
// TEMPORARY — a throwaway account for load testing, and nothing else.
//
// Run it once from the Apps Script editor, where Session.getActiveUser()
// identifies the owner, because there is no way in from outside without a
// credential and no way to a credential without being in. It is the only
// bootstrap in the file and it exists to be deleted.
//
// Deliberately narrow: STAFF, not ADMIN, and scoped to the tt event alone. A
// STAFF caller never receives an attendee's email or phone (svcAttendees_
// withholds them below ADMIN), so the worst this account can do is check
// people in and out of one test event.
//
// The password is written in plain sight in version control, which is exactly
// why the account must not outlive the test. removeLoadTestAccount() deletes
// it; delete both functions afterwards.
// ---------------------------------------------------------------------------
var LOADTEST_EMAIL = 'claude-loadtest@thinktech.co.th';
var LOADTEST_PASSWORD = 'OtzsbksnBpnwvrAw6GZOZk';

function createLoadTestAccount() {
  var sh = getStaffSheet_();
  var values = sh.getDataRange().getValues();
  var headers = values[0];
  var col = {};
  headers.forEach(function (h, i) { col[h] = i + 1; });
  ['pw_hash', 'pw_set_at'].forEach(function (name) {
    if (!col[name]) {
      headers.push(name);
      sh.getRange(1, headers.length).setValue(name);
      col[name] = headers.length;
    }
  });

  var rowNum = -1;
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim().toLowerCase() === LOADTEST_EMAIL) { rowNum = i + 1; break; }
  }
  if (rowNum < 0) {
    sh.appendRow([LOADTEST_EMAIL, 'Claude (load test)', 'STAFF', 'tt', 'ประตูทดสอบ']);
    rowNum = sh.getLastRow();
  }
  sh.getRange(rowNum, col.pw_hash).setValue(hashPassword_(LOADTEST_PASSWORD));
  sh.getRange(rowNum, col.pw_set_at).setValue(new Date().toISOString());
  Logger.log('พร้อมแล้ว: ' + LOADTEST_EMAIL + ' (STAFF, งาน tt เท่านั้น)');
  return 'ok';
}

function removeLoadTestAccount() {
  var sh = getStaffSheet_();
  var values = sh.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]).trim().toLowerCase() === LOADTEST_EMAIL) sh.deleteRow(i + 1);
  }
  // Any session it opened dies with it.
  try {
    var ses = sessionSheet_();
    var rows = ses.getDataRange().getValues();
    var col = {};
    rows[0].forEach(function (h, i) { col[h] = i; });
    for (var j = rows.length - 1; j >= 1; j--) {
      if (String(rows[j][col.email]).trim().toLowerCase() === LOADTEST_EMAIL) ses.deleteRow(j + 1);
    }
  } catch (err) { Logger.log('session cleanup: ' + err); }
  Logger.log('ลบบัญชีทดสอบและเซสชันของมันแล้ว');
  return 'ok';
}

// วัดว่าการแฮชรหัสผ่านหนึ่งครั้งใช้เวลาเท่าไร เพื่อตั้งจำนวนรอบให้สูงที่สุด
// เท่าที่การล็อกอินยังเร็วพอ
function timePasswordHash() {
  var t = Date.now();
  hashPassword_('measure-me-please');
  var ms = Date.now() - t;
  Logger.log(PW_ITERATIONS + ' รอบ ใช้เวลา ' + ms + ' ms  ·  ถ้าอยากได้ 1 วินาที ตั้งได้ราว ' +
             Math.round(PW_ITERATIONS * 1000 / Math.max(ms, 1)) + ' รอบ');
  return ms;
}

function setupTeamAccessSheet() {
  var props = PropertiesService.getScriptProperties();
  var existingId = props.getProperty('STAFF_SHEET_ID');
  var ss = null;
  if (existingId) {
    try { ss = SpreadsheetApp.openById(existingId); } catch (err) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Event Check-in — Team Access');
    props.setProperty('STAFF_SHEET_ID', ss.getId());
  }
  var sh = ensureSheet_(ss, TEAM_SHEETS.STAFF, STAFF_HEADERS);
  migrateHeaders_(sh, STAFF_HEADERS);
  ensureSheet_(ss, TEAM_SHEETS.SESSIONS, SESSION_HEADERS);
  seedStaff_(sh);

  // Drop the blank default tab Spreadsheet.create() adds, once Staff exists.
  var defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) ss.deleteSheet(defaultSheet);

  Logger.log('Team access spreadsheet ready: ' + ss.getUrl());
  return ss.getUrl();
}

function seedStaff_(sh) {
  if (sh.getLastRow() > 1) return; // already seeded
  var rows = [
    // event_scope is 'ALL' or a comma-separated list of event_id values.
    ['pimchanok@thinktech.co.th', 'พิมพ์ชนก ว.', 'ADMIN', 'ALL', 'ประตู A'],
    ['thanakrit@thinktech.co.th', 'ธนกฤต อ.', 'STAFF', 'tt', 'ประตู B'],
    ['yanisa@thinktech.co.th', 'ญาณิศา ร.', 'STAFF', 'tt', 'ประตู A'],
    ['warintorn@partner.co', 'วรินทร ท.', 'STAFF', 'lab', '—']
  ];
  sh.getRange(2, 1, rows.length, STAFF_HEADERS.length).setValues(rows);
}

function getStaffSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('STAFF_SHEET_ID');
  if (!id) throw new Error('team_access_not_configured — run setupTeamAccessSheet() first');
  return SpreadsheetApp.openById(id).getSheetByName(TEAM_SHEETS.STAFF);
}

// ---------------------------------------------------------------------------
// Passwords and sessions
//
// A password sits in a spreadsheet an admin can open, so it is never stored —
// only PBKDF2-HMAC-SHA256 over a per-row random salt. The iteration count
// travels inside the stored string, so it can be raised later without
// invalidating the hashes already written.
//
// Signing in exchanges the password for a session token. The password itself
// is then never sent again: every later call carries the token, which is
// stored hashed, expires on its own, and can be revoked one row at a time
// without touching the password.
// ---------------------------------------------------------------------------
var PW_ITERATIONS = 4096;
var SESSION_HOURS = 12;
var MAX_PW_ATTEMPTS = 8;
var PW_LOCKOUT_SECONDS = 900;

// Math.random() is not a source anybody should build a credential on.
// Apps Script offers no CSPRNG, and getUuid() is the closest thing it has —
// a v4 UUID carries 122 bits of randomness from the platform rather than from
// a seeded PRNG an attacker could reason about.
function randomBytes_(n) {
  var hex = '';
  while (hex.length < n * 2) hex += Utilities.getUuid().replace(/-/g, '');
  var out = [];
  for (var i = 0; i < n; i++) {
    var b = parseInt(hex.substr(i * 2, 2), 16);
    out.push(b > 127 ? b - 256 : b);   // Apps Script bytes are signed
  }
  return out;
}

function pbkdf2Sha256_(password, saltBytes, iterations) {
  var pw = Utilities.newBlob(password).getBytes();
  var block = saltBytes.concat([0, 0, 0, 1]);
  var u = Utilities.computeHmacSha256Signature(block, pw);
  var out = u.slice(0);
  for (var i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, pw);
    for (var j = 0; j < out.length; j++) out[j] = out[j] ^ u[j];
  }
  return out;
}

function hashPassword_(password) {
  var salt = randomBytes_(16);
  var dk = pbkdf2Sha256_(password, salt, PW_ITERATIONS);
  return 'pbkdf2$' + PW_ITERATIONS + '$' + Utilities.base64Encode(salt) + '$' + Utilities.base64Encode(dk);
}

// Compares every byte whichever way it goes, so how long the check takes says
// nothing about how much of the password was right.
function sameBytes_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= (a[i] ^ b[i]);
  return diff === 0;
}

function verifyPassword_(password, stored) {
  var parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  var iterations = Number(parts[1]);
  if (!(iterations > 0)) return false;
  var salt = Utilities.base64Decode(parts[2]);
  var want = Utilities.base64Decode(parts[3]);
  return sameBytes_(pbkdf2Sha256_(password, salt, iterations), want);
}

function sessionSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('STAFF_SHEET_ID');
  if (!id) throw new Error('team_access_not_configured');
  var ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName(TEAM_SHEETS.SESSIONS);
  if (!sh) sh = ensureSheet_(ss, TEAM_SHEETS.SESSIONS, SESSION_HEADERS);
  return sh;
}

function tokenHash_(token) {
  return Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token)));
}

function login_(email, password) {
  var em = String(email || '').trim().toLowerCase();
  var pw = String(password || '');
  if (!em || !pw) throw new Error('missing_credentials');

  // Counted before the password is checked, so guessing costs the guesser
  // whether or not the address exists.
  var cache = CacheService.getScriptCache();
  var key = 'pwfail:' + em;
  var fails = Number(cache.get(key) || 0);
  if (fails >= MAX_PW_ATTEMPTS) throw new Error('too_many_attempts');

  var row = findStaffByEmail_(em);
  var ok = !!(row && row.pw_hash) && verifyPassword_(pw, row.pw_hash);
  if (!ok) {
    cache.put(key, String(fails + 1), PW_LOCKOUT_SECONDS);
    // One message for an unknown address and for a wrong password alike, or
    // the failure itself tells an attacker which addresses are worth guessing.
    throw new Error('invalid_credentials');
  }
  cache.remove(key);

  if (String(row.pw_hash || '').indexOf('pbkdf2$' + PW_ITERATIONS + '$') !== 0) {
    try {
      var ssh = getStaffSheet_();
      var vals = ssh.getDataRange().getValues();
      var hcol = {};
      vals[0].forEach(function (h, i) { hcol[h] = i + 1; });
      for (var ri = 1; ri < vals.length; ri++) {
        if (String(vals[ri][0]).trim().toLowerCase() !== em) continue;
        ssh.getRange(ri + 1, hcol.pw_hash).setValue(hashPassword_(pw));
        ssh.getRange(ri + 1, hcol.pw_set_at).setValue(new Date().toISOString());
        break;
      }
    } catch (err) {
      // Never block a sign-in that has already succeeded.
      Logger.log('rehash failed for ' + em + ': ' + err);
    }
  }

  // Every sign-in used to append a row that nothing ever removed, and
  // sessionEmail_ reads the whole sheet on every authenticated call — so the
  // cost of being signed in grew with every sign-in anybody had ever made.
  // Sweeping here keeps it bounded and costs nothing on the hot path: signing
  // in is rare, and the sheet is open anyway.
  pruneSessions_();

  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var now = new Date();
  var exp = new Date(now.getTime() + SESSION_HOURS * 3600 * 1000);
  sessionSheet_().appendRow([tokenHash_(token), em, now.toISOString(), exp.toISOString(), false]);
  // The very first password sign-in creates the Sessions sheet and writes to it
  // in one execution; without this the next request read a view that did not
  // have the row yet and answered invalid_session to a token issued seconds
  // earlier. Seen once, on the first login this system ever had.
  SpreadsheetApp.flush();
  return {
    sessionToken: token,
    exp: Math.floor(exp.getTime() / 1000),
    me: { email: em, name: row.name || em, role: String(row.role || 'STAFF').toUpperCase() }
  };
}

// Drops rows that can never authenticate again — expired, or revoked. Bottom
// up, so removing one row does not shift the index of the next one to check.
function pruneSessions_() {
  try {
    var sh = sessionSheet_();
    var values = sh.getDataRange().getValues();
    if (values.length < 2) return;
    var headers = values[0];
    var col = {};
    headers.forEach(function (h, i) { col[h] = i; });
    var now = Date.now();
    for (var i = values.length - 1; i >= 1; i--) {
      var dead = isTrue_(values[i][col.revoked]) ||
                 new Date(values[i][col.expires_at]).getTime() < now;
      if (dead) sh.deleteRow(i + 1);
    }
  } catch (err) {
    // Housekeeping must never stop somebody signing in.
    Logger.log('pruneSessions_ failed: ' + err);
  }
}

function sessionEmail_(token) {
  if (!token) throw new Error('not_signed_in');
  var want = tokenHash_(token);
  var t = sessionSheet_().getDataRange().getValues();
  var headers = t.shift();
  var col = {};
  headers.forEach(function (h, i) { col[h] = i; });
  for (var i = 0; i < t.length; i++) {
    if (String(t[i][col.token_hash]) !== want) continue;
    if (isTrue_(t[i][col.revoked])) throw new Error('session_revoked');
    if (new Date(t[i][col.expires_at]).getTime() < Date.now()) throw new Error('session_expired');
    return String(t[i][col.email]).trim().toLowerCase();
  }
  throw new Error('invalid_session');
}

function logout_(token) {
  if (!token) return { ok: true };
  var sh = sessionSheet_();
  var t = sh.getDataRange().getValues();
  var headers = t.shift();
  var col = {};
  headers.forEach(function (h, i) { col[h] = i; });
  var want = tokenHash_(token);
  for (var i = 0; i < t.length; i++) {
    if (String(t[i][col.token_hash]) === want) {
      sh.getRange(i + 2, col.revoked + 1).setValue(true);
      break;
    }
  }
  return { ok: true };
}

// Setting a password is done signed in: an ADMIN may set one for anybody on
// the team, and anybody may set their own. Nobody can set one for an address
// that is not already on the team — the password is a second key to an
// existing door, never a way to open a new one.
function svcSetPassword_(p) {
  var staff = requireStaff_(p.eventId || '', 'STAFF');
  var target = String(p.email || staff.email).trim().toLowerCase();
  if (target !== staff.email && staff.role !== 'ADMIN') throw new Error('forbidden_role');

  var pw = String(p.password || '');
  var clearing = p.clear === true || p.clear === 'true';
  if (!clearing && pw.length < 8) throw new Error('password_too_short');

  var sh = getStaffSheet_();
  var rows = sh.getDataRange().getValues();
  var headers = rows[0];
  var col = {};
  headers.forEach(function (h, i) { col[h] = i + 1; });
  // The columns post-date most Team Access sheets; add them on first use
  // rather than making setupTeamAccessSheet() a prerequisite.
  ['pw_hash', 'pw_set_at'].forEach(function (name) {
    if (!col[name]) {
      headers.push(name);
      sh.getRange(1, headers.length).setValue(name);
      col[name] = headers.length;
    }
  });

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() !== target) continue;
    sh.getRange(i + 1, col.pw_hash).setValue(clearing ? '' : hashPassword_(pw));
    sh.getRange(i + 1, col.pw_set_at).setValue(clearing ? '' : new Date().toISOString());
    audit_(staff, clearing ? 'clearPassword' : 'setPassword', '', '', target);
    return { ok: true, email: target, hasPassword: !clearing };
  }
  throw new Error('staff_not_found');
}

// Looks up one person's role/scope from the team-access allowlist by email.
// Returns null if they're not on it. Scope check (does role cover eventId) is
// left to the caller, since "ALL" vs a specific list is a caller-side decision.
function findStaffByEmail_(email) {
  var em = String(email || '').trim().toLowerCase();
  var sh = getStaffSheet_();
  var rows = sh.getDataRange().getValues();
  var headers = rows.shift();
  var row = rows.find(function (r) { return String(r[0]).toLowerCase() === em; });
  return row ? rowToObj_(headers, row) : null;
}

// ---------------------------------------------------------------------------
// HTTP entry points
// ---------------------------------------------------------------------------
// One doGet serves two very different things, chosen by whether an `action`
// was passed:
//   ?action=...  → the JSON API (used by the public customer site)
//   no action    → the Staff Console HTML page
// The same script is deployed twice with different access settings: a public
// deployment for customers, and a "Anyone with a Google Account" deployment
// staff open in a browser. Serving the console from Apps Script itself (rather
// than GitHub Pages) is what makes Google sign-in work at all — same origin,
// so `google.script.run` needs no CORS and Session.getActiveUser() is populated.
function doGet(e) {
  if (e && e.parameter && e.parameter.action) return handle_(e);
  if (e && e.parameter && e.parameter.page === 'badge') return serveMoved_('badge', e);
  return serveMoved_('console', e);
}
function doPost(e) { return handle_(e); }

// Both of these used to be served from here and are not any more.
//
// The console shell (Staff.html) loaded its JS cross-origin from Vercel, so
// anything the page computed relative to itself resolved against
// googleusercontent.com — that is how the print button broke. The badge page
// identified its caller with Session.getActiveUser(), which under
// executeAs: USER_DEPLOYING is blank for everyone except the script owner, so
// it answered no_identity to every staff member who opened it.
//
// Both now live on the Vercel app, where the signed-in ID token is available.
// A second door into the same app that only half works is worse than no door,
// so what is left here is a sign pointing at the one that does.
var CONSOLE_URL = 'https://1neve-console.vercel.app';

function serveMoved_(what, e) {
  var target = CONSOLE_URL;
  var lead = 'Staff Console ย้ายที่อยู่แล้ว';
  if (what === 'badge') {
    var evId = (e && e.parameter && e.parameter.eventId) || '';
    var regId = (e && e.parameter && e.parameter.regId) || '';
    target = CONSOLE_URL + '/badge.html?eventId=' + encodeURIComponent(evId) +
             '&regId=' + encodeURIComponent(regId);
    lead = 'หน้าพิมพ์บัตรย้ายที่อยู่แล้ว';
  }
  var html =
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + lead + '</title>' +
    '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f4ee;' +
    'color:#211d17;font-family:Prompt,system-ui,sans-serif;text-align:center;padding:32px}' +
    'h1{font-size:22px;font-weight:600;margin:0 0 10px}' +
    'p{font-size:14px;color:#5c564a;margin:0 0 24px;line-height:1.7}' +
    'a{display:inline-block;background:#9c7a2e;color:#fff;text-decoration:none;' +
    'padding:14px 26px;border-radius:99px;font-weight:600;font-size:14px}</style>' +
    '<div><h1>' + lead + '</h1>' +
    '<p>ที่อยู่เดิมนี้ไม่ได้ใช้งานแล้ว<br>กดปุ่มด้านล่างเพื่อไปยังที่อยู่ใหม่ แล้วบันทึกไว้แทน</p>' +
    '<a href="' + target + '">ไปยังที่อยู่ใหม่</a></div>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(lead)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function handle_(e) {
  var action = '';
  try {
    var params = parseParams_(e);
    action = params.action;

    // The Vercel-hosted Staff Console calls in through here — a verified
    // Google ID token stands in for the same-origin session the old
    // Apps-Script-hosted page relied on. See verifyIdToken_() and
    // currentStaff_(). svc() already returns {ok,data,error}, so this
    // short-circuits the switch below instead of re-wrapping it.
    if (action === 'staffCall') {
      // Two ways in, one identity out. Whichever credential arrives, what the
      // rest of the script sees is an email that has been proven to belong to
      // the caller — requireStaff_ and the audit log never learn which door
      // was used, so no permission depends on it.
      var email = params.sessionToken
        ? sessionEmail_(params.sessionToken)
        : verifyIdToken_(params.idToken);
      VERIFIED_EMAIL_ = email;
      try {
        return json_(svc(params.staffAction, params.payload || {}));
      } finally {
        VERIFIED_EMAIL_ = null;
      }
    }

    var data;
    switch (action) {
      case 'listEvents': data = listEvents(); break;
      case 'getEventForm': data = getEventForm(params.eventId); break;
      case 'register': data = register(params); break;
      case 'getMyPass': data = getMyPass(params.q || params.email || params.phone); break;
      // Public by necessity — it is the door you knock on before you have a
      // key. Everything that protects it is inside: the stretched hash, the
      // attempt limit, and the fact that it says the same thing whether the
      // address is unknown or the password is wrong.
      case 'login': data = login_(params.email, params.password); break;
      case 'logout': data = logout_(params.sessionToken); break;
      default: return json_({ ok: false, error: 'unknown_action' });
    }
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

// Reads either query-string params (GET) or a JSON body sent as text/plain
// (POST — text/plain avoids the CORS preflight that Apps Script can't answer).
function parseParams_(e) {
  if (e && e.postData && e.postData.contents) {
    try { return JSON.parse(e.postData.contents); } catch (err) { /* fall through to query params */ }
  }
  return (e && e.parameter) || {};
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function rowToObj_(headers, row) {
  var o = {};
  for (var i = 0; i < headers.length; i++) o[headers[i]] = row[i];
  return o;
}

// ss defaults to the bound (Overview) file; pass an event file's
// Spreadsheet object (openEventFile_) to read a per-event tab instead.
function readSheet_(name, ss) {
  var sh = (ss || SpreadsheetApp.getActiveSpreadsheet()).getSheetByName(name);
  var rows = sh.getDataRange().getValues();
  var headers = rows.shift();
  return { sheet: sh, headers: headers, rows: rows };
}

function isTrue_(v) { return v === true || v === 'TRUE' || v === 'true'; }

// ---------------------------------------------------------------------------
// listEvents — public. Feeds the event picker (arc carousel).
// ---------------------------------------------------------------------------
// Every event row, mapped to the shared shape — hidden ones included. Used
// by svcBootstrap_ (staff need to see and un-hide archived events) and as
// the base for the public listEvents() below.
function allEventsRows_() {
  var t = readSheet_(SHEETS.EVENTS);
  return t.rows.filter(function (r) { return r[0]; }).map(function (r) {
    var o = rowToObj_(t.headers, r);
    return {
      id: o.event_id, name: o.name, date: o.date_display, place: o.place,
      status: o.status_label, seats: o.seats_label, price: o.price_label,
      accent: o.accent, theme: o.theme, open: isTrue_(o.open), short: o.short_label,
      hidden: isTrue_(o.hidden), image: o.image_url || '', pdpa: isTrue_(o.pdpa),
      // Free text, not a time value: "08:15", "เปิดประตู 08:15 น." and
      // "gates 8am" all print fine on a pass. Blank means the pass leaves the
      // line out rather than inventing a time.
      doors: o.doors_at || ''
    };
  });
}

function listEvents() {
  return allEventsRows_().filter(function (e) { return !e.hidden; });
}

// ---------------------------------------------------------------------------
// getEventForm — public. Field list for a given event (Staff Console territory
// mostly, but kept here per the handoff doc's endpoint table).
// ---------------------------------------------------------------------------
function getEventForm(eventId) {
  if (!eventId) throw new Error('missing_event_id');
  var t = readSheet_(SHEETS.FIELDS, openEventFile_(eventId));
  return t.rows.map(function (r) {
    var o = rowToObj_(t.headers, r);
    return { key: o.key, label: o.label, type: o.type, required: isTrue_(o.required), order: o.sort_order };
  }).sort(function (a, b) { return a.order - b.order; });
}

// ---------------------------------------------------------------------------
// register — public. Creates a Registrations row, signs a QR token, emails
// the attendee a reopen link, and returns everything the pass screen needs.
// ---------------------------------------------------------------------------
function register(p) {
  var eventId = String(p.eventId || '').trim();
  var name = String(p.name || '').trim();
  var email = String(p.email || '').trim().toLowerCase();
  var phone = String(p.phone || '').trim();
  var org = String(p.org || '').trim();
  // Everyone registers as a general attendee. VIP / press is a decision the
  // organiser makes, not the attendee — staff set it from the console.
  var type = 'ทั่วไป';
  var consent = p.consent === true || p.consent === 'true';
  // Answers to whatever extra questions this event defines in its Fields
  // sheet. The four keys that have columns of their own are ignored here so a
  // caller cannot use answers to overwrite them — org in particular is read
  // back out of answers_json by older code.
  var answers = {};
  if (p.answers && typeof p.answers === 'object' && !Array.isArray(p.answers)) {
    Object.keys(p.answers).forEach(function (k) {
      if (k === 'name' || k === 'email' || k === 'phone' || k === 'org') return;
      answers[k] = String(p.answers[k] == null ? '' : p.answers[k]).trim().slice(0, 500);
    });
  }
  answers.org = org;

  if (!eventId) throw new Error('missing_event');

  // Name and email stay required whatever the Fields sheet says: a returning
  // attendee finds their pass by phone or email (getMyPass), the organiser
  // needs a way to reach someone, and the badge has to print a name.
  // Everything else — phone included — is required only if staff ticked it, so
  // the form the customer sees and the rules the server enforces cannot
  // disagree. Note that an event whose Fields sheet leaves phone un-ticked
  // leaves its guests only the email route back to their pass.
  if (!name) throw new Error('invalid_name');
  if (!/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(email)) throw new Error('invalid_email');

  var fieldDefs = [];
  try { fieldDefs = getEventForm(eventId); } catch (formErr) { fieldDefs = []; }
  var supplied = { name: name, email: email, phone: phone, org: org };
  for (var fi = 0; fi < fieldDefs.length; fi++) {
    var fd = fieldDefs[fi];
    if (fd.key === 'name' || fd.key === 'email') continue;   // already settled above
    var val = supplied.hasOwnProperty(fd.key)
      ? supplied[fd.key]
      : String(answers[fd.key] == null ? '' : answers[fd.key]);
    if (!val) {
      if (fd.required) throw new Error('missing_' + fd.key);
      continue;                                              // blank and optional is fine
    }
    if (fd.type === 'PHONE' && val.replace(/\D/g, '').length < 9) throw new Error('invalid_phone');
    if (fd.type === 'EMAIL' && !/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(val)) throw new Error('invalid_email');
  }

  var ev = eventById_(eventId);
  if (!ev) throw new Error('event_not_found');
  if (!isTrue_(ev.open)) throw new Error('event_closed');
  // Consent is demanded only where the event actually shows the PDPA notice.
  // With the switch off nothing is asked, so nothing is recorded — an empty
  // consent_at beats a stamp for something the attendee never saw.
  var wantsConsent = isTrue_(ev.pdpa);
  if (wantsConsent && !consent) throw new Error('consent_required');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('busy');
  var regId, badgeCode, qrToken, nowIso;
  try {
    // One open, used for both the duplicate check and the write. It used to be
    // opened twice in the same call, which is a round trip to Drive for nothing.
    var file = openEventFile_(eventId);
    var sh = file.getSheetByName(SHEETS.REGISTRATIONS);

    // Read after taking the lock, or two people pressing ยืนยัน at the same
    // moment both read "not registered" and both get a badge.
    //
    // A phone reaches exactly one person, because a pass is reopened by it
    // (getMyPass) and two rows sharing a number leave the earlier one with no
    // way back to their own QR. The same address twice is almost always the
    // same person pressing the button twice — a refresh, a slow connection, an
    // impatient second tap — and every such row is a badge that will never be
    // scanned sitting in the organiser's count.
    //
    // Neither case hands the existing pass back here. Registration is a public
    // endpoint; returning somebody's QR to whoever types their phone number
    // into it would make the form a second, easier way to harvest passes. The
    // error says to use เปิดดูบัตรของฉัน instead, and that screen is the one
    // place that lookup lives.
    var existing = readSheet_(SHEETS.REGISTRATIONS, file);
    var eCol = {};
    existing.headers.forEach(function (h, i) { eCol[h] = i; });
    var wantTail = phoneTail_(phone);
    for (var dx = 0; dx < existing.rows.length; dx++) {
      var er = existing.rows[dx];
      if (String(er[eCol.status]) === 'deleted') continue;
      if (String(er[eCol.email] || '').trim().toLowerCase() === email) {
        throw new Error('email_already_registered');
      }
      if (wantTail && phoneTail_(er[eCol.phone]) === wantTail) {
        throw new Error('phone_already_registered');
      }
    }

    regId = 'r' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    badgeCode = eventId.toUpperCase().slice(0, 4) + '-' + randomHex_(4) + '-' + (900 + Math.floor(Math.random() * 99));
    qrToken = signQr_(eventId, badgeCode);
    nowIso = new Date().toISOString();
    var row = [
      regId, eventId, badgeCode, qrToken, name, email, phone, org, type,
      JSON.stringify(answers), 'online', 'registered', nowIso,
      (wantsConsent && consent) ? nowIso : '', '', '', '', '', 0, nowIso, 'customer'
    ];
    sh.appendRow(row);
    forcePhoneText_(sh, phone);
    // Mirror into the Overview file's AllRegistrations tab, under the SAME
    // lock — this shared tab is where concurrent appends across different
    // events converge, and appendRow isn't safe against concurrent callers.
    // Best-effort: a mirror failure must not fail a registration that
    // already succeeded above (see getMyPass()'s known limitation on a miss).
    try {
      var mirror = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ALL_REG);
      mirror.appendRow(row);
      forcePhoneText_(mirror, phone);
    } catch (mirrorErr) {
      Logger.log('AllRegistrations mirror failed for ' + regId + ': ' + mirrorErr);
    }
  } finally {
    lock.releaseLock();
  }

  return {
    regId: regId, badgeCode: badgeCode,
    qrPayload: eventId + '|' + badgeCode + '|' + qrToken,
    name: name, email: email, phone: phone, org: org, type: type,
    eventId: eventId, eventName: ev.name,
    eventDate: ev.date_display || '', eventPlace: ev.place || '',
    eventDoors: ev.doors_at || ''
  };
}

function randomHex_(n) {
  var chars = '0123456789ABCDEF', s = '';
  for (var i = 0; i < n; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

// QR content is `EVENT|BADGE_CODE|SIG` — SIG is the first 10 hex chars of
// HMAC-SHA256(EVENT|BADGE_CODE) signed with a secret kept in Script
// Properties, so a badge can't be forged without the secret (per handoff §6).
function signQr_(eventId, badgeCode) {
  var secret = PropertiesService.getScriptProperties().getProperty('QR_SECRET');
  if (!secret) throw new Error('qr_secret_not_configured');
  var raw = eventId + '|' + badgeCode;
  var sigBytes = Utilities.computeHmacSha256Signature(raw, secret);
  var hex = sigBytes.map(function (b) { return ((b < 0 ? b + 256 : b).toString(16)).padStart(2, '0'); }).join('');
  return hex.slice(0, 10).toUpperCase();
}

// appendRow lets the sheet guess the type of every cell, and for a phone
// number it guesses wrong. The cell is re-set as plain text right after the
// row lands, while the write lock is still held.
function forcePhoneText_(sh, phone) {
  try {
    var col = REG_HEADERS.indexOf('phone') + 1;
    if (!col || !phone) return;
    sh.getRange(sh.getLastRow(), col).setNumberFormat('@').setValue(String(phone));
  } catch (err) {
    Logger.log('forcePhoneText_ failed: ' + err);
  }
}

function eventById_(id) {
  var t = readSheet_(SHEETS.EVENTS);
  var row = t.rows.find(function (r) { return r[0] === id; });
  return row ? rowToObj_(t.headers, row) : null;
}

// No pass email is sent. A consumer Google account can send about a hundred
// a day, which one full event exhausts, and the failure was invisible: the
// send sat inside a try/catch (correctly — a mail hiccup must not fail a
// registration), so the customer saw "เรียบร้อยแล้ว" either way and nobody
// learned that the hundred-and-first guest got nothing. Rather than a channel
// that works until it quietly doesn't, the QR is shown on screen the moment
// registration finishes and can be reopened at any time from the site by
// typing the phone number or email that was registered — see getMyPass.

// ---------------------------------------------------------------------------
// getMyPass — public. Reopens a badge across all events for a customer who
// closed the page, by whichever of their phone number or email they still
// remember. Returns the most recently registered match.
//
// Phones are compared on their last nine digits. A Thai mobile is ten digits
// beginning with a zero, and rows written before the phone column was forced
// to text are stored as numbers with that zero gone — comparing the tail
// matches both without having to guess which kind a row is.
// ---------------------------------------------------------------------------
function phoneTail_(v) {
  var d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : '';
}

function getMyPass(term) {
  var q = String(term || '').trim();
  var em = q.toLowerCase();
  var isEmail = /^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(em);
  var tail = phoneTail_(q);
  // Anything shorter than a whole phone number is not a lookup, it is a guess.
  if (!isEmail && !tail) throw new Error('invalid_lookup');

  var t = readSheet_(SHEETS.ALL_REG);
  var matches = t.rows.map(function (r) { return rowToObj_(t.headers, r); })
    .filter(function (o) {
      return isEmail
        ? (o.email && String(o.email).toLowerCase() === em)
        : (tail && phoneTail_(o.phone) === tail);
    }).filter(function (o) { return o.status !== 'deleted'; });
  if (!matches.length) throw new Error('not_found');

  matches.sort(function (a, b) { return new Date(b.registered_at) - new Date(a.registered_at); });
  var o = matches[0];
  var ev = eventById_(o.event_id);
  return {
    regId: o.reg_id, badgeCode: o.badge_code,
    qrPayload: o.event_id + '|' + o.badge_code + '|' + o.qr_token,
    name: o.full_name, email: o.email, phone: o.phone, org: o.org, type: o.type,
    eventId: o.event_id, eventName: ev ? ev.name : o.event_id,
    eventDate: ev ? (ev.date_display || '') : '', eventPlace: ev ? (ev.place || '') : '',
    eventDoors: ev ? (ev.doors_at || '') : ''
  };
}

// ===========================================================================
// STAFF CONSOLE API
//
// Called from Staff.html via google.script.run — NOT through doGet/doPost, so
// these run same-origin under the signed-in staff member's Google session and
// never touch CORS. Every one of them starts with requireStaff_(), which is
// the only place a role is decided: the client never sends its own role.
// ===========================================================================

// Fill in after creating the OAuth client (Google Cloud Console → Credentials).
var GOOGLE_CLIENT_ID = '202833902564-rdob60vtlpt2bo9nvf0tdm7dmvaaqjvp.apps.googleusercontent.com';

// Two tiers only — no read-only "VIEWER" role. Anyone on the team either
// works the door (STAFF) or manages the event (ADMIN); there was no case for
// giving someone the attendee list without also giving them a job to do
// with it. A leftover 'VIEWER' (or any other unrecognized) role value in the
// Team Access sheet ranks as 0 here, i.e. locked out of every action.
var ROLE_RANK = { STAFF: 1, ADMIN: 2 };

// Set for the duration of one staffCall_ request (see handle_ below), after
// the caller's Google ID token has been verified. Apps Script executions are
// single-threaded per request, so this can't leak between requests.
var VERIFIED_EMAIL_ = null;

// Identity comes from Google, never from the page. Two paths, in order:
//   1. A verified OAuth ID token (Vercel-hosted console, cross-origin) — see
//      verifyIdToken_() and the 'staffCall' action in handle_().
//   2. Session.getActiveUser() (legacy same-origin Apps Script HtmlService
//      page, Staff.html) — kept as a fallback so that page still works.
// If both come back blank, the deployment/config is wrong — see the error
// text surfaced in the console UI.
function currentStaff_() {
  var email = VERIFIED_EMAIL_ || '';
  if (!email) {
    try { email = (Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (err) { email = ''; }
  }
  if (!email) throw new Error('no_identity');
  var row = findStaffByEmail_(email);
  if (!row) throw new Error('not_authorized:' + email);
  return {
    email: email,
    name: row.name || email,
    role: String(row.role || 'STAFF').toUpperCase(),
    scope: String(row.event_scope || ''),
    gate: row.gate || '—'
  };
}

// Verifies a Google Identity Services ID token against Google's own tokeninfo
// endpoint — no local JWT library needed. Checks the token was actually
// issued to OUR OAuth client (aud) and that Google verified the email itself
// (email_verified), then returns the email. Throws on anything else: expired,
// wrong audience, or malformed.
function verifyIdToken_(idToken) {
  if (!idToken) throw new Error('missing_id_token');
  var clientId = GOOGLE_CLIENT_ID;
  if (!clientId || clientId.indexOf('REPLACE_WITH') === 0) throw new Error('google_client_id_not_configured');
  var resp;
  try {
    resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  } catch (err) {
    throw new Error('token_verify_failed');
  }
  if (resp.getResponseCode() !== 200) throw new Error('invalid_id_token');
  var info = JSON.parse(resp.getContentText());
  if (info.aud !== clientId) throw new Error('wrong_audience');
  if (info.email_verified !== 'true' && info.email_verified !== true) throw new Error('email_not_verified');
  if (!info.email) throw new Error('no_email_in_token');
  return String(info.email).trim().toLowerCase();
}

function requireStaff_(eventId, minRole) {
  var s = currentStaff_();
  if ((ROLE_RANK[s.role] || 0) < (ROLE_RANK[minRole] || 0)) throw new Error('forbidden_role');
  if (eventId && s.scope.toUpperCase() !== 'ALL') {
    var allowed = s.scope.split(',').map(function (x) { return x.trim(); }).filter(String);
    if (allowed.indexOf(eventId) < 0) throw new Error('forbidden_event');
  }
  return s;
}

// Single entry point for the console. Returns {ok, data, error} so the client
// has one shape to handle, and one place catches every thrown auth error.
function svc(action, p) {
  p = p || {};
  try {
    var data;
    switch (action) {
      case 'whoAmI': data = svcWhoAmI_(); break;
      case 'bootstrap': data = svcBootstrap_(); break;
      case 'dashboard': data = svcDashboard_(p.eventId); break;
      case 'checkin': data = svcCheckin_(p); break;
      case 'attendees': data = svcAttendees_(p.eventId, p.query); break;
      case 'fields': requireStaff_(p.eventId, 'STAFF'); data = getEventForm(p.eventId); break;
      case 'setCheckedIn': data = svcSetCheckedIn_(p); break;
      case 'setType': data = svcSetType_(p); break;
      case 'addWalkin': data = svcAddWalkin_(p); break;
      case 'deleteAttendee': data = svcDeleteAttendee_(p); break;
      case 'history': data = svcHistory_(p.eventId, p.filter); break;
      case 'csv': data = svcCsv_(p.eventId); break;
      case 'saveFields': data = svcSaveFields_(p); break;
      case 'saveBadgeConfig': data = svcSaveBadgeConfig_(p); break;
      case 'createEvent': data = svcCreateEvent_(p); break;
      case 'setEventProp': data = svcSetEventProp_(p); break;
      case 'team': data = svcTeam_(); break;
      case 'setRole': data = svcSetRole_(p); break;
      case 'setPassword': data = svcSetPassword_(p); break;
      case 'addTeamMember': data = svcAddTeamMember_(p); break;
      case 'badgeData': data = svcBadgeData_(p); break;
      default: return { ok: false, error: 'unknown_action:' + action };
    }
    return { ok: true, data: data };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function svcWhoAmI_() { return currentStaff_(); }

// Everything the console needs on first paint: who you are, which events you
// may touch, and their form fields + badge settings.
function svcBootstrap_() {
  var me = currentStaff_();
  var all = allEventsRows_(); // includes hidden — staff can still see/un-hide them
  var mine = me.scope.toUpperCase() === 'ALL' ? all : all.filter(function (ev) {
    return me.scope.split(',').map(function (x) { return x.trim(); }).indexOf(ev.id) >= 0;
  });
  return { me: me, events: mine, badge: allBadgeConfigs_() };
}

function allBadgeConfigs_() {
  var t = readSheet_(SHEETS.BADGE);
  var out = {};
  t.rows.forEach(function (r) {
    var o = rowToObj_(t.headers, r);
    if (!o.event_id) return;
    out[o.event_id] = {
      size: o.size || 'A6',
      logo: isTrue_(o.show_logo), org: isTrue_(o.show_org), type: isTrue_(o.show_type),
      qr: isTrue_(o.show_qr), bar: isTrue_(o.show_bar)
    };
  });
  return out;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function svcDashboard_(eventId) {
  requireStaff_(eventId, 'STAFF');
  var regs = regRowsFor_(eventId);
  var total = regs.length;
  var checkedIn = regs.filter(function (r) { return r.status === 'checked_in'; }).length;
  var walkins = regs.filter(function (r) { return r.source === 'walkin'; }).length;

  var scans = checkinRowsFor_(eventId);
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var todayScans = scans.filter(function (c) { return c.scanned_at && new Date(c.scanned_at) >= today; });

  // Hourly bars across the 7 hours ending now, so the chart always has a shape.
  var nowHour = new Date().getHours();
  var startHour = Math.max(0, nowHour - 6);
  var bars = [];
  for (var h = startHour; h <= nowHour; h++) {
    var n = todayScans.filter(function (c) {
      return c.result === 'ok' && new Date(c.scanned_at).getHours() === h;
    }).length;
    bars.push({ hour: (h < 10 ? '0' : '') + h, n: n });
  }

  var byStaff = {};
  todayScans.forEach(function (c) {
    if (c.result !== 'ok') return;
    var k = c.scanned_by || '—';
    byStaff[k] = (byStaff[k] || 0) + 1;
  });
  var crew = teamRows_();
  var staffBoard = crew.map(function (m) {
    return { name: m.name, email: m.email, gate: m.gate, role: m.role, scans: byStaff[m.email] || byStaff[m.name] || 0 };
  }).sort(function (a, b) { return b.scans - a.scans; });

  var feed = scans.slice(0, 8).map(function (c) {
    var verb = c.result === 'ok' ? ' เช็คอิน ' : c.result === 'duplicate' ? ' สแกนซ้ำ ' : c.result === 'undo' ? ' ยกเลิกเช็คอิน ' : ' สแกนไม่สำเร็จ ';
    return { time: hhmm_(c.scanned_at), text: (c.scanned_by || '—') + verb + (c.name || c.badge_code) + (c.gate ? ' · ' + c.gate : '') };
  });

  return {
    total: total, checkedIn: checkedIn, walkins: walkins,
    rate: total ? Math.round(checkedIn / total * 100) + '%' : '0%',
    bars: bars, staffBoard: staffBoard, feed: feed, syncedAt: new Date().toISOString()
  };
}

function hhmm_(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}
function ddmmyy_(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear();
}

function regRowsFor_(eventId) {
  var t = readSheet_(SHEETS.REGISTRATIONS, openEventFile_(eventId));
  return t.rows.map(function (r) { return rowToObj_(t.headers, r); })
    .filter(function (o) { return o.reg_id && o.status !== 'deleted'; });
}

// No cross-event "all checkins" mode anymore — each event's Checkins live in
// that event's own file, and (unlike Registrations) they aren't mirrored
// centrally, so an eventId is required.
function checkinRowsFor_(eventId) {
  if (!eventId) throw new Error('missing_event_id');
  var t = readSheet_(SHEETS.CHECKINS, openEventFile_(eventId));
  return t.rows.map(function (r) { return rowToObj_(t.headers, r); })
    .filter(function (o) { return o.scan_id; })
    .sort(function (a, b) { return new Date(b.scanned_at) - new Date(a.scanned_at); });
}

// ---------------------------------------------------------------------------
// Check-in — the heart of it. First scan wins; every attempt is logged.
// ---------------------------------------------------------------------------
function svcCheckin_(p) {
  var staff = requireStaff_(p.eventId, 'STAFF');
  var eventId = String(p.eventId || '');
  var badgeCode = String(p.badgeCode || '').trim().toUpperCase();
  var device = String(p.device || 'WEB').slice(0, 24);

  // A scanned QR carries `event|badge|sig`; a typed code carries just the code.
  // The signature is what proves the badge came from us, so when it's present
  // it must verify — a wrong-event or forged QR is rejected before any write.
  if (p.qr) {
    var parts = String(p.qr).split('|');
    if (parts.length !== 3) return logScan_(eventId, null, String(p.qr).slice(0, 40), '—', staff, device, 'not_found', p.clientScanId);
    if (parts[0] !== eventId) return logScan_(eventId, null, parts[1], '—', staff, device, 'wrong_event', p.clientScanId);
    if (signQr_(parts[0], parts[1]) !== String(parts[2]).toUpperCase()) {
      return logScan_(eventId, null, parts[1], '—', staff, device, 'bad_signature', p.clientScanId);
    }
    badgeCode = String(parts[1]).toUpperCase();
  }
  if (!badgeCode) throw new Error('missing_badge_code');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('busy');
  try {
    // Read AFTER taking the lock — deciding from a value read before the lock
    // is exactly how two gates both think they were first.
    var t = readSheet_(SHEETS.REGISTRATIONS, openEventFile_(eventId));
    var idx = -1, rec = null;
    for (var i = 0; i < t.rows.length; i++) {
      var o = rowToObj_(t.headers, t.rows[i]);
      if (String(o.badge_code).toUpperCase() === badgeCode && o.status !== 'deleted') {
        idx = i; rec = o; break;
      }
    }
    if (!rec) return logScan_(eventId, null, badgeCode, '— ไม่พบรหัสนี้ —', staff, device, 'not_found', p.clientScanId);

    var already = rec.status === 'checked_in';
    var nowIso = new Date().toISOString();
    var col = {};
    t.headers.forEach(function (h, i) { col[h] = i + 1; });
    var rowNum = idx + 2;

    if (already) {
      t.sheet.getRange(rowNum, col.scan_count).setValue(Number(rec.scan_count || 1) + 1);
      // No Checkins row for a repeat (ADR 0014). Every row is an appendRow
      // under the script-wide lock, so a badge waved twice costs the queue as
      // much as a real check-in does, and at a door that queue is people
      // standing still. What the log gets asked afterwards — is this person in,
      // and who let them in — is answered by the registration row, which still
      // carries the first check-in's time, gate and operator next to the count.
      // Rejections keep writing a row: nothing else records them.
      return {
        result: 'duplicate', name: rec.full_name, org: rec.org, type: rec.type,
        badgeCode: badgeCode, regId: rec.reg_id,
        firstBy: rec.checked_in_by, firstAt: rec.checked_in_at, firstGate: rec.gate
      };
    }

    // One range write instead of eight cell writes. This was done believing it
    // would take a chunk out of the five seconds a scan costs; measured before
    // and after, it took none — Apps Script queues writes and flushes them at
    // the end of the execution, so eight setValue calls were never eight round
    // trips. Kept because it is the idiomatic form and does fewer operations,
    // NOT because it made anything faster. The five seconds live elsewhere:
    // about 2.5s of it is Apps Script overhead before any code runs at all,
    // and about 1.4s is opening the per-event spreadsheet.
    //
    // Contiguity is checked rather than assumed. A sheet whose columns have
    // been reordered by hand still works — it just goes back to writing them
    // one at a time instead of writing something into the wrong column.
    var runNames = ['checked_in_at', 'checked_in_by', 'gate', 'device_id', 'scan_count', 'updated_at', 'updated_by'];
    var runValues = [nowIso, staff.email, staff.gate, device, 1, nowIso, staff.email];
    var firstCol = col[runNames[0]];
    var contiguous = runNames.every(function (nm, i) { return col[nm] === firstCol + i; });

    t.sheet.getRange(rowNum, col.status).setValue('checked_in');
    if (contiguous) {
      t.sheet.getRange(rowNum, firstCol, 1, runValues.length).setValues([runValues]);
    } else {
      runNames.forEach(function (nm, i) { t.sheet.getRange(rowNum, col[nm]).setValue(runValues[i]); });
    }

    logScan_(eventId, rec.reg_id, badgeCode, rec.full_name, staff, device, 'ok', p.clientScanId);
    return {
      result: 'ok', name: rec.full_name, org: rec.org, type: rec.type, email: rec.email,
      badgeCode: badgeCode, regId: rec.reg_id, at: nowIso, by: staff.name, gate: staff.gate
    };
  } finally {
    lock.releaseLock();
  }
}

function logScan_(eventId, regId, badgeCode, name, staff, device, result, clientScanId) {
  var sh = openEventFile_(eventId).getSheetByName(SHEETS.CHECKINS);
  sh.appendRow([
    's' + Utilities.getUuid().replace(/-/g, '').slice(0, 10), eventId, regId || '', badgeCode,
    name || '', new Date().toISOString(), staff.email, staff.gate, device, result, clientScanId || ''
  ]);
  return { result: result, name: name, badgeCode: badgeCode };
}

// ---------------------------------------------------------------------------
// Attendees
// ---------------------------------------------------------------------------
function svcAttendees_(eventId, query) {
  var staff = requireStaff_(eventId, 'STAFF');
  // Door/scanning staff (STAFF) can search by email/phone but don't
  // get to see the raw values back — PDPA: minimize PII exposure to people
  // who only need name + badge code + status to do their job. Only ADMIN
  // sees full contact info.
  var isAdmin = staff.role === 'ADMIN';
  var q = String(query || '').trim().toLowerCase();
  var rows = regRowsFor_(eventId);
  if (q) {
    rows = rows.filter(function (r) {
      return [r.full_name, r.email, r.phone, r.badge_code, r.org].some(function (v) {
        return String(v || '').toLowerCase().indexOf(q) >= 0;
      });
    });
  }
  rows.sort(function (a, b) { return new Date(b.registered_at) - new Date(a.registered_at); });
  return rows.slice(0, 300).map(function (r) {
    return {
      regId: r.reg_id, name: r.full_name,
      email: isAdmin ? r.email : '', phone: isAdmin ? r.phone : '',
      org: r.org, type: r.type, code: r.badge_code, status: r.status, source: r.source,
      by: r.checked_in_by || '', at: r.checked_in_at || '', gate: r.gate || ''
    };
  });
}

function svcSetCheckedIn_(p) {
  var staff = requireStaff_(p.eventId, 'STAFF');
  var on = p.on === true || p.on === 'true';
  var t = readSheet_(SHEETS.REGISTRATIONS, openEventFile_(p.eventId));
  var col = {}; t.headers.forEach(function (h, i) { col[h] = i + 1; });
  for (var i = 0; i < t.rows.length; i++) {
    var o = rowToObj_(t.headers, t.rows[i]);
    if (o.reg_id !== p.regId) continue;
    var rowNum = i + 2, nowIso = new Date().toISOString();
    t.sheet.getRange(rowNum, col.status).setValue(on ? 'checked_in' : 'registered');
    t.sheet.getRange(rowNum, col.checked_in_at).setValue(on ? nowIso : '');
    t.sheet.getRange(rowNum, col.checked_in_by).setValue(on ? staff.email : '');
    t.sheet.getRange(rowNum, col.gate).setValue(on ? staff.gate : '');
    t.sheet.getRange(rowNum, col.updated_at).setValue(nowIso);
    t.sheet.getRange(rowNum, col.updated_by).setValue(staff.email);
    logScan_(p.eventId, o.reg_id, o.badge_code, o.full_name, staff, 'MANUAL', on ? 'ok' : 'undo', '');
    return { ok: true };
  }
  throw new Error('not_found');
}

// Pass type is set here, not at registration — the organiser decides who is
// VIP or press. Written straight to the Registrations row so the badge and
// the attendee's own pass screen both pick it up on next read.
var PASS_TYPES = ['ทั่วไป', 'VIP', 'สื่อ'];

// Pass-type changes (ทั่วไป -> VIP/สื่อ) are an organiser decision, not
// something door staff should be able to grant themselves — ADMIN only.
function svcSetType_(p) {
  var staff = requireStaff_(p.eventId, 'ADMIN');
  var type = String(p.type || '').trim();
  if (PASS_TYPES.indexOf(type) < 0) throw new Error('bad_type');

  var t = readSheet_(SHEETS.REGISTRATIONS, openEventFile_(p.eventId));
  var col = {}; t.headers.forEach(function (h, i) { col[h] = i + 1; });
  for (var i = 0; i < t.rows.length; i++) {
    var o = rowToObj_(t.headers, t.rows[i]);
    if (o.reg_id !== p.regId) continue;
    t.sheet.getRange(i + 2, col.type).setValue(type);
    t.sheet.getRange(i + 2, col.updated_at).setValue(new Date().toISOString());
    t.sheet.getRange(i + 2, col.updated_by).setValue(staff.email);
    audit_(staff, 'setType', p.eventId, p.regId, o.full_name + ' → ' + type);
    return { ok: true, type: type };
  }
  throw new Error('not_found');
}

function svcAddWalkin_(p) {
  var staff = requireStaff_(p.eventId, 'STAFF');
  var name = String(p.name || '').trim();
  var email = String(p.email || '').trim().toLowerCase();
  var phone = String(p.phone || '').trim();
  if (!name) throw new Error('invalid_name');

  var ev = eventById_(p.eventId);
  if (!ev) throw new Error('event_not_found');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('busy');
  var regId, badgeCode;
  try {
    var sh = openEventFile_(p.eventId).getSheetByName(SHEETS.REGISTRATIONS);
    regId = 'r' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    badgeCode = p.eventId.toUpperCase().slice(0, 4) + '-' + randomHex_(4) + '-' + (900 + Math.floor(Math.random() * 99));
    var nowIso = new Date().toISOString();
    // Walk-ins are checked in the moment they're created — they're standing
    // at the door.
    var row = [
      regId, p.eventId, badgeCode, signQr_(p.eventId, badgeCode), name, email, phone,
      String(p.org || ''), (PASS_TYPES.indexOf(String(p.type)) >= 0 ? String(p.type) : 'ทั่วไป'), JSON.stringify({}), 'walkin', 'checked_in',
      nowIso, nowIso, nowIso, staff.email, staff.gate, 'MANUAL', 1, nowIso, staff.email
    ];
    sh.appendRow(row);
    forcePhoneText_(sh, phone);
    // Walk-ins are a form of registration too — mirror them the same as
    // register(), same lock, same best-effort try/catch.
    try {
      var walkinMirror = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ALL_REG);
      walkinMirror.appendRow(row);
      forcePhoneText_(walkinMirror, phone);
    } catch (mirrorErr) {
      Logger.log('AllRegistrations mirror failed for ' + regId + ': ' + mirrorErr);
    }
  } finally {
    lock.releaseLock();
  }
  logScan_(p.eventId, regId, badgeCode, name, staff, 'MANUAL', 'ok', '');
  audit_(staff, 'addWalkin', p.eventId, regId, name);
  return { regId: regId, badgeCode: badgeCode, name: name, qrPayload: p.eventId + '|' + badgeCode + '|' + signQr_(p.eventId, badgeCode) };
}

// Soft delete — the row stays so the scan history still resolves, but every
// read filters it out.
function svcDeleteAttendee_(p) {
  var staff = requireStaff_(p.eventId, 'ADMIN');
  var t = readSheet_(SHEETS.REGISTRATIONS, openEventFile_(p.eventId));
  var col = {}; t.headers.forEach(function (h, i) { col[h] = i + 1; });
  for (var i = 0; i < t.rows.length; i++) {
    var o = rowToObj_(t.headers, t.rows[i]);
    if (o.reg_id !== p.regId) continue;
    t.sheet.getRange(i + 2, col.status).setValue('deleted');
    t.sheet.getRange(i + 2, col.updated_at).setValue(new Date().toISOString());
    t.sheet.getRange(i + 2, col.updated_by).setValue(staff.email);
    audit_(staff, 'deleteAttendee', p.eventId, p.regId, o.full_name);
    return { ok: true };
  }
  throw new Error('not_found');
}

function audit_(staff, action, eventId, targetId, detail) {
  try {
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.AUDIT).appendRow([
      'l' + Utilities.getUuid().replace(/-/g, '').slice(0, 10), new Date().toISOString(),
      staff.email, action, eventId || '', targetId || '', String(detail || '')
    ]);
  } catch (err) { Logger.log('audit_ failed: ' + err); }
}

// ---------------------------------------------------------------------------
// History + export
// ---------------------------------------------------------------------------
function svcHistory_(eventId, filter) {
  requireStaff_(eventId, 'STAFF');
  var rows = checkinRowsFor_(eventId);
  if (filter && filter !== 'all') rows = rows.filter(function (c) { return c.result === filter; });
  return rows.slice(0, 300).map(function (c) {
    return {
      date: ddmmyy_(c.scanned_at), time: hhmm_(c.scanned_at), name: c.name || '—',
      code: c.badge_code, by: c.scanned_by, gate: c.gate, device: c.device_id, result: c.result
    };
  });
}

// Full data export (every attendee's email/phone in one file) — ADMIN only,
// same PII reasoning as svcAttendees_'s masking above.
function svcCsv_(eventId) {
  requireStaff_(eventId, 'ADMIN');
  var head = ['reg_id', 'badge_code', 'full_name', 'email', 'phone', 'org', 'type', 'source', 'registered_at', 'status', 'checked_in_at', 'checked_in_by', 'gate'];
  var rows = regRowsFor_(eventId).map(function (r) {
    return [r.reg_id, r.badge_code, r.full_name, r.email, r.phone, r.org, r.type, r.source, r.registered_at, r.status, r.checked_in_at, r.checked_in_by, r.gate];
  });
  return [head].concat(rows).map(function (r) {
    return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Per-event configuration
// ---------------------------------------------------------------------------
function svcSaveFields_(p) {
  var staff = requireStaff_(p.eventId, 'ADMIN');
  var fields = p.fields || [];
  var sh = openEventFile_(p.eventId).getSheetByName(SHEETS.FIELDS);
  var rows = fields.map(function (f, i) {
    var key = f.key || ('f' + i);
    // register() requires these two no matter what, because the QR is emailed
    // and the badge prints a name. Letting them be saved as optional would
    // build a form whose own server rejects it.
    var required = (key === 'name' || key === 'email') ? true : f.required === true;
    return [p.eventId, key, f.label, f.type || 'TEXT', required, i + 1];
  });
  sh.clear();
  sh.appendRow(FIELDS_HEADERS);
  if (rows.length) sh.getRange(2, 1, rows.length, FIELDS_HEADERS.length).setValues(rows);
  audit_(staff, 'saveFields', p.eventId, '', fields.length + ' fields');
  return { ok: true };
}

function svcSaveBadgeConfig_(p) {
  var staff = requireStaff_(p.eventId, 'ADMIN');
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.BADGE);
  var t = readSheet_(SHEETS.BADGE);
  var row = [p.eventId, p.size || 'A6', p.logo !== false, p.org !== false, p.type !== false, p.qr !== false, p.bar !== false];
  for (var i = 0; i < t.rows.length; i++) {
    if (t.rows[i][0] === p.eventId) {
      sh.getRange(i + 2, 1, 1, BADGE_HEADERS.length).setValues([row]);
      audit_(staff, 'saveBadgeConfig', p.eventId, '', p.size);
      return { ok: true };
    }
  }
  sh.appendRow(row);
  audit_(staff, 'saveBadgeConfig', p.eventId, '', p.size);
  return { ok: true };
}

function svcCreateEvent_(p) {
  var staff = requireStaff_(null, 'ADMIN');
  var name = String(p.name || '').trim();
  if (!name) throw new Error('invalid_name');
  var id = String(p.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8) || ('ev' + Date.now().toString(36).slice(-4)));
  if (eventById_(id)) id = id + Math.floor(Math.random() * 90 + 10);

  var themes = {
    editorial: '#d8482b', brass: '#a8874f', onyx: '#c9ac74', forest: '#2f6b4f', ink: '#2f4d8c'
  };
  var theme = themes[p.theme] ? p.theme : 'editorial';

  var fileId = createEventFile_(id, name);
  try {
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.EVENTS).appendRow([
      id, name, String(p.date || 'ยังไม่กำหนดวัน'), String(p.place || ''), 'เปิดรับ',
      'เปิดรับแล้ว', String(p.price || 'ไม่มีค่าใช้จ่าย'), themes[theme], theme, true, name.toUpperCase(), fileId
    ]);
  } catch (err) {
    // The Drive file above already exists but the registry never learned its
    // ID — best-effort clean it up so a retry doesn't leave an orphan behind.
    try { DriveApp.getFileById(fileId).setTrashed(true); } catch (cleanupErr) {
      Logger.log('svcCreateEvent_ orphan cleanup failed for ' + fileId + ': ' + cleanupErr);
    }
    throw err;
  }
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.BADGE).appendRow([id, 'A6', true, true, true, true, true]);
  audit_(staff, 'createEvent', id, '', name);
  return { id: id, name: name };
}

function svcSetEventProp_(p) {
  var staff = requireStaff_(p.eventId, 'ADMIN');
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.EVENTS);
  var t = readSheet_(SHEETS.EVENTS);
  var col = {}; t.headers.forEach(function (h, i) { col[h] = i + 1; });
  for (var i = 0; i < t.rows.length; i++) {
    if (t.rows[i][0] !== p.eventId) continue;
    if (p.theme) {
      var accents = { editorial: '#d8482b', brass: '#a8874f', onyx: '#c9ac74', forest: '#2f6b4f', ink: '#2f4d8c' };
      sh.getRange(i + 2, col.theme).setValue(p.theme);
      if (accents[p.theme]) sh.getRange(i + 2, col.accent).setValue(accents[p.theme]);
    }
    if (p.open !== undefined) sh.getRange(i + 2, col.open).setValue(p.open === true || p.open === 'true');
    if (p.hidden !== undefined) sh.getRange(i + 2, col.hidden).setValue(p.hidden === true || p.hidden === 'true');
    if (p.pdpa !== undefined) {
      // The column post-dates most sheets. Add it on first write rather than
      // making a one-off setupSheets() run a prerequisite for the switch.
      if (!col.pdpa) {
        sh.getRange(1, t.headers.length + 1).setValue('pdpa');
        col.pdpa = t.headers.length + 1;
      }
      sh.getRange(i + 2, col.pdpa).setValue(p.pdpa === true || p.pdpa === 'true');
    }
    if (p.doors !== undefined) {
      // Same lazy add as pdpa: the column post-dates existing sheets, and a
      // switch that needs setupSheets() run first is a switch that looks broken.
      if (!col.doors_at) {
        sh.getRange(1, t.headers.length + 1).setValue('doors_at');
        col.doors_at = t.headers.length + 1;
        t.headers.push('doors_at');
      }
      sh.getRange(i + 2, col.doors_at).setValue(String(p.doors || ''));
    }
    if (p.image !== undefined) sh.getRange(i + 2, col.image_url).setValue(String(p.image || ''));
    if (p.name) sh.getRange(i + 2, col.name).setValue(p.name);
    if (p.date) sh.getRange(i + 2, col.date_display).setValue(p.date);
    if (p.place) sh.getRange(i + 2, col.place).setValue(p.place);
    audit_(staff, 'setEventProp', p.eventId, '', JSON.stringify(p));
    return { ok: true };
  }
  throw new Error('event_not_found');
}

// ---------------------------------------------------------------------------
// Team (reads/writes the SEPARATE team-access spreadsheet)
// ---------------------------------------------------------------------------
function teamRows_() {
  var sh = getStaffSheet_();
  var rows = sh.getDataRange().getValues();
  var headers = rows.shift();
  return rows.filter(function (r) { return r[0]; }).map(function (r) {
    var o = rowToObj_(headers, r);
    // hasPassword, never the hash itself — the console only needs to know
    // whether the button should read 'set' or 'change'.
    return { email: o.email, name: o.name, role: String(o.role || 'STAFF').toUpperCase(),
             scope: o.event_scope, gate: o.gate, hasPassword: !!o.pw_hash };
  });
}

// ADMIN-only — the team roster (everyone's email, role, gate) is sensitive
// enough that even read access shouldn't be STAFF-wide. This is the
// real boundary; the "team" nav item is also hidden from non-admins in
// staff.js, but that's UX only — this is what actually blocks it.
function svcTeam_() {
  requireStaff_(null, 'ADMIN');
  return teamRows_();
}

function svcSetRole_(p) {
  var staff = requireStaff_(null, 'ADMIN');
  var role = String(p.role || '').toUpperCase();
  if (!ROLE_RANK[role]) throw new Error('bad_role');
  if (p.email === staff.email) throw new Error('cannot_change_own_role');
  var sh = getStaffSheet_();
  var rows = sh.getDataRange().getValues();
  var headers = rows.shift();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase() === String(p.email).toLowerCase()) {
      sh.getRange(i + 2, headers.indexOf('role') + 1).setValue(role);
      audit_(staff, 'setRole', '', p.email, role);
      return { ok: true };
    }
  }
  throw new Error('not_found');
}

// Adds a brand-new row to the Team Access allowlist. The person still has to
// sign in with that exact Google account themselves — this only pre-approves
// the email; it can't create or verify a Google identity on its own.
function svcAddTeamMember_(p) {
  var staff = requireStaff_(null, 'ADMIN');
  var email = String(p.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(email)) throw new Error('invalid_email');
  var role = String(p.role || 'STAFF').toUpperCase();
  if (!ROLE_RANK[role]) throw new Error('bad_role');
  var name = String(p.name || '').trim() || email.split('@')[0];
  var scope = String(p.scope || 'ALL').trim() || 'ALL';
  var gate = String(p.gate || '—').trim() || '—';

  var sh = getStaffSheet_();
  var rows = sh.getDataRange().getValues();
  var headers = rows.shift();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase() === email) throw new Error('already_exists');
  }
  var pw = String(p.password || '');
  if (pw && pw.length < 8) throw new Error('password_too_short');

  var row = [email, name, role, scope, gate];
  if (pw) {
    // Line the row up with the header, whatever order the columns are in, so
    // the hash lands in pw_hash rather than wherever it happens to fall.
    var col = {};
    headers.forEach(function (h, i) { col[h] = i; });
    ['pw_hash', 'pw_set_at'].forEach(function (nm) {
      if (col[nm] === undefined) {
        headers.push(nm);
        sh.getRange(1, headers.length).setValue(nm);
        col[nm] = headers.length - 1;
      }
    });
    while (row.length < headers.length) row.push('');
    row[col.pw_hash] = hashPassword_(pw);
    row[col.pw_set_at] = new Date().toISOString();
  }
  sh.appendRow(row);
  audit_(staff, 'addTeamMember', '', email, role + ' · ' + scope + (pw ? ' · with password' : ''));
  return { ok: true, email: email, name: name, role: role, scope: scope, gate: gate, hasPassword: !!pw };
}

// Everything the A6 print page needs for one attendee.
function svcBadgeData_(p) {
  requireStaff_(p.eventId, 'STAFF');
  var rows = regRowsFor_(p.eventId).filter(function (r) { return r.reg_id === p.regId; });
  if (!rows.length) throw new Error('not_found');
  var r = rows[0];
  var ev = eventById_(p.eventId);
  var cfg = allBadgeConfigs_()[p.eventId] || { size: 'A6', logo: true, org: true, type: true, qr: true, bar: true };
  return {
    name: r.full_name, org: r.org, type: r.type, code: r.badge_code,
    qrPayload: p.eventId + '|' + r.badge_code + '|' + r.qr_token,
    eventName: ev ? ev.name : p.eventId, eventShort: ev ? ev.short_label : '',
    accent: ev ? ev.accent : '#d8482b', theme: ev ? ev.theme : 'editorial',
    date: ev ? ev.date_display : '', place: ev ? ev.place : '', config: cfg
  };
}
