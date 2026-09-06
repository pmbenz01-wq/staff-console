/**
 * Event Check-in — Apps Script backend for the customer-facing site.
 *
 * Implements the public endpoints from "Handoff - Google Sheet และ Apps Script":
 *   listEvents   (addition — needed by the event picker, not itemised in the handoff
 *                 doc's endpoint table but required by the same "public" architecture)
 *   getEventForm
 *   register
 *   getMyPass
 *
 * The Staff Console lives in the same project but does NOT go through this
 * JSON API: it is served as HTML (Staff.html) and calls the svc() entry point
 * via google.script.run — same origin, so Google sign-in works and there is no
 * CORS. See the "STAFF CONSOLE API" section at the bottom.
 *
 * Team access (Staff allowlist: who, what role, which events) lives in a
 * SEPARATE spreadsheet file from customer data — see the "Team access" section
 * below and setupTeamAccessSheet(). requireStaff_() is the single gate every
 * staff call passes through.
 *
 * Deploy: see README.md in this folder.
 */

var SHEETS = {
  EVENTS: 'Events',
  FIELDS: 'Fields',
  REGISTRATIONS: 'Registrations',
  CHECKINS: 'Checkins',
  BADGE: 'BadgeConfig',
  AUDIT: 'AuditLog'
};

var EVENTS_HEADERS = ['event_id', 'name', 'date_display', 'place', 'status_label', 'seats_label', 'price_label', 'accent', 'theme', 'open', 'short_label'];
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
  ensureSheet_(ss, SHEETS.FIELDS, FIELDS_HEADERS);
  ensureSheet_(ss, SHEETS.REGISTRATIONS, REG_HEADERS);
  ensureSheet_(ss, SHEETS.CHECKINS, CHECKIN_HEADERS);
  ensureSheet_(ss, SHEETS.BADGE, BADGE_HEADERS);
  ensureSheet_(ss, SHEETS.AUDIT, AUDIT_HEADERS);
  seedEvents_();
  seedFields_();
  seedBadgeConfig_();
  ensureQrSecret_();
  Logger.log('Setup complete. Sheets ready, QR secret ' + (PropertiesService.getScriptProperties().getProperty('QR_SECRET') ? 'present' : 'MISSING'));
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.appendRow(headers);
  return sh;
}

function seedEvents_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.EVENTS);
  if (sh.getLastRow() > 1) return; // already seeded
  var rows = [
    ['tt', 'ThinkTech Summit 2026', '18–19 ธ.ค. 2569', 'ไบเทค บางนา · ฮอลล์ 2', 'เปิดรับ', 'เหลือ 240 ที่', 'ไม่มีค่าใช้จ่าย', '#d8482b', 'editorial', true, 'THINKTECH SUMMIT · 2026'],
    ['gala', 'Annual Partner Gala', '24 ธ.ค. 2569', 'ดุสิตธานี · แกรนด์บอลรูม', 'เชิญเท่านั้น', 'เหลือ 32 ที่', 'ตามบัตรเชิญ', '#a8874f', 'brass', true, 'PARTNER GALA · 2026'],
    ['lab', 'Founder Lab · รุ่น 4', '9 ม.ค. 2570', 'ทองหล่อ · ชั้น 6', 'เปิดรับ', 'เหลือ 18 ที่', '2,500 บาท', '#2f6b4f', 'forest', true, 'FOUNDER LAB · 04'],
    ['roadshow', 'Regional Roadshow', '22 ก.พ. 2570', 'เชียงใหม่ · เซ็นทรัลเฟส', 'เร็ว ๆ นี้', 'ยังไม่เปิดรับ', 'ไม่มีค่าใช้จ่าย', '#2f4d8c', 'ink', false, 'REGIONAL ROADSHOW']
  ];
  sh.getRange(2, 1, rows.length, EVENTS_HEADERS.length).setValues(rows);
}

function seedFields_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.FIELDS);
  if (sh.getLastRow() > 1) return; // already seeded
  function base(eventId, extra) {
    return [
      [eventId, 'name', 'ชื่อ–นามสกุล', 'TEXT', true, 1],
      [eventId, 'email', 'อีเมล', 'EMAIL', true, 2],
      [eventId, 'phone', 'เบอร์โทรศัพท์', 'PHONE', true, 3]
    ].concat(extra || []);
  }
  var rows = []
    .concat(base('tt', [['tt', 'org', 'บริษัท / องค์กร', 'TEXT', false, 4]]))
    .concat(base('gala', [['gala', 'diet', 'ข้อจำกัดด้านอาหาร', 'SELECT', false, 4]]))
    .concat(base('lab', [['lab', 'role', 'ตำแหน่งงาน', 'TEXT', true, 4]]))
    .concat(base('roadshow', []));
  sh.getRange(2, 1, rows.length, FIELDS_HEADERS.length).setValues(rows);
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
var TEAM_SHEETS = { STAFF: 'Staff' };
var STAFF_HEADERS = ['email', 'name', 'role', 'event_scope', 'gate'];

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
    ['warintorn@partner.co', 'วรินทร ท.', 'VIEWER', 'lab', '—']
  ];
  sh.getRange(2, 1, rows.length, STAFF_HEADERS.length).setValues(rows);
}

function getStaffSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('STAFF_SHEET_ID');
  if (!id) throw new Error('team_access_not_configured — run setupTeamAccessSheet() first');
  return SpreadsheetApp.openById(id).getSheetByName(TEAM_SHEETS.STAFF);
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
  if (e && e.parameter && e.parameter.page === 'badge') return serveBadgePrint_(e);
  return serveStaffConsole_();
}
function doPost(e) { return handle_(e); }

function serveStaffConsole_() {
  return HtmlService.createHtmlOutputFromFile('Staff')
    .setTitle('Staff Console — Event Check-in')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function serveBadgePrint_(e) {
  return HtmlService.createHtmlOutputFromFile('Badge')
    .setTitle('Badge — Print')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function handle_(e) {
  var action = '';
  try {
    var params = parseParams_(e);
    action = params.action;
    var data;
    switch (action) {
      case 'listEvents': data = listEvents(); break;
      case 'getEventForm': data = getEventForm(params.eventId); break;
      case 'register': data = register(params); break;
      case 'getMyPass': data = getMyPass(params.email); break;
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

function readSheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  var rows = sh.getDataRange().getValues();
  var headers = rows.shift();
  return { sheet: sh, headers: headers, rows: rows };
}

function isTrue_(v) { return v === true || v === 'TRUE' || v === 'true'; }

// ---------------------------------------------------------------------------
// listEvents — public. Feeds the event picker (arc carousel).
// ---------------------------------------------------------------------------
function listEvents() {
  var t = readSheet_(SHEETS.EVENTS);
  return t.rows.filter(function (r) { return r[0]; }).map(function (r) {
    var o = rowToObj_(t.headers, r);
    return {
      id: o.event_id, name: o.name, date: o.date_display, place: o.place,
      status: o.status_label, seats: o.seats_label, price: o.price_label,
      accent: o.accent, theme: o.theme, open: isTrue_(o.open), short: o.short_label
    };
  });
}

// ---------------------------------------------------------------------------
// getEventForm — public. Field list for a given event (Staff Console territory
// mostly, but kept here per the handoff doc's endpoint table).
// ---------------------------------------------------------------------------
function getEventForm(eventId) {
  if (!eventId) throw new Error('missing_event_id');
  var t = readSheet_(SHEETS.FIELDS);
  return t.rows.filter(function (r) { return r[0] === eventId; }).map(function (r) {
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

  if (!eventId) throw new Error('missing_event');
  if (!name) throw new Error('invalid_name');
  if (!/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(email)) throw new Error('invalid_email');
  if (phone.replace(/\D/g, '').length < 9) throw new Error('invalid_phone');
  if (!consent) throw new Error('consent_required');

  var ev = eventById_(eventId);
  if (!ev) throw new Error('event_not_found');
  if (!isTrue_(ev.open)) throw new Error('event_closed');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('busy');
  var regId, badgeCode, qrToken, nowIso;
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.REGISTRATIONS);
    regId = 'r' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    badgeCode = eventId.toUpperCase().slice(0, 4) + '-' + randomHex_(4) + '-' + (900 + Math.floor(Math.random() * 99));
    qrToken = signQr_(eventId, badgeCode);
    nowIso = new Date().toISOString();
    sh.appendRow([
      regId, eventId, badgeCode, qrToken, name, email, phone, org, type,
      JSON.stringify({ org: org }), 'online', 'registered', nowIso,
      consent ? nowIso : '', '', '', '', '', 0, nowIso, 'customer'
    ]);
  } finally {
    lock.releaseLock();
  }

  sendPassEmail_(email, name, ev, badgeCode);

  return {
    regId: regId, badgeCode: badgeCode,
    qrPayload: eventId + '|' + badgeCode + '|' + qrToken,
    name: name, email: email, phone: phone, org: org, type: type,
    eventId: eventId, eventName: ev.name
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

function eventById_(id) {
  var t = readSheet_(SHEETS.EVENTS);
  var row = t.rows.find(function (r) { return r[0] === id; });
  return row ? rowToObj_(t.headers, row) : null;
}

// Best-effort — a mail quota hiccup shouldn't fail the registration itself.
function sendPassEmail_(email, name, ev, badgeCode) {
  try {
    var siteUrl = PropertiesService.getScriptProperties().getProperty('CUSTOMER_SITE_URL') || '';
    var link = siteUrl ? (siteUrl + (siteUrl.indexOf('?') >= 0 ? '&' : '?') + 'lookup=' + encodeURIComponent(email)) : '';
    var subject = '[' + ev.name + '] บัตรเข้างานของคุณ / Your entry pass';
    var body = 'สวัสดีคุณ ' + name + ',\n\n' +
      'ลงทะเบียนเข้างาน "' + ev.name + '" สำเร็จแล้ว\n' +
      'รหัสบัตร: ' + badgeCode + '\n\n' +
      (link ? ('เปิดดู QR เข้างานได้ที่ลิงก์นี้ / Reopen your QR pass:\n' + link + '\n\n') : '') +
      '— ทีมผู้จัดงาน';
    MailApp.sendEmail(email, subject, body);
  } catch (err) {
    Logger.log('sendPassEmail_ failed: ' + err);
  }
}

// ---------------------------------------------------------------------------
// getMyPass — public. Reopens a badge by email, across all events, so a
// customer who lost their pass image can pull it back up. Returns the most
// recently registered match.
// ---------------------------------------------------------------------------
function getMyPass(email) {
  var em = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(em)) throw new Error('invalid_email');

  var t = readSheet_(SHEETS.REGISTRATIONS);
  var matches = t.rows.map(function (r) { return rowToObj_(t.headers, r); })
    .filter(function (o) { return o.email && String(o.email).toLowerCase() === em && o.status !== 'deleted'; });
  if (!matches.length) throw new Error('not_found');

  matches.sort(function (a, b) { return new Date(b.registered_at) - new Date(a.registered_at); });
  var o = matches[0];
  var ev = eventById_(o.event_id);
  return {
    regId: o.reg_id, badgeCode: o.badge_code,
    qrPayload: o.event_id + '|' + o.badge_code + '|' + o.qr_token,
    name: o.full_name, email: o.email, phone: o.phone, org: o.org, type: o.type,
    eventId: o.event_id, eventName: ev ? ev.name : o.event_id
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

var ROLE_RANK = { VIEWER: 1, STAFF: 2, ADMIN: 3 };

// Identity comes from Google, never from the page. If this returns blank the
// deployment is misconfigured — see the error text surfaced in the console UI.
function currentStaff_() {
  var email = '';
  try { email = (Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (err) { email = ''; }
  if (!email) throw new Error('no_identity');
  var row = findStaffByEmail_(email);
  if (!row) throw new Error('not_authorized:' + email);
  return {
    email: email,
    name: row.name || email,
    role: String(row.role || 'VIEWER').toUpperCase(),
    scope: String(row.event_scope || ''),
    gate: row.gate || '—'
  };
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
      case 'fields': requireStaff_(p.eventId, 'VIEWER'); data = getEventForm(p.eventId); break;
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
  var all = listEvents();
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
  requireStaff_(eventId, 'VIEWER');
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
  var t = readSheet_(SHEETS.REGISTRATIONS);
  return t.rows.map(function (r) { return rowToObj_(t.headers, r); })
    .filter(function (o) { return o.reg_id && o.event_id === eventId && o.status !== 'deleted'; });
}

function checkinRowsFor_(eventId) {
  var t = readSheet_(SHEETS.CHECKINS);
  return t.rows.map(function (r) { return rowToObj_(t.headers, r); })
    .filter(function (o) { return o.scan_id && (!eventId || o.event_id === eventId); })
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
    var t = readSheet_(SHEETS.REGISTRATIONS);
    var idx = -1, rec = null;
    for (var i = 0; i < t.rows.length; i++) {
      var o = rowToObj_(t.headers, t.rows[i]);
      if (o.event_id === eventId && String(o.badge_code).toUpperCase() === badgeCode && o.status !== 'deleted') {
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
      logScan_(eventId, rec.reg_id, badgeCode, rec.full_name, staff, device, 'duplicate', p.clientScanId);
      return {
        result: 'duplicate', name: rec.full_name, org: rec.org, type: rec.type,
        badgeCode: badgeCode, regId: rec.reg_id,
        firstBy: rec.checked_in_by, firstAt: rec.checked_in_at, firstGate: rec.gate
      };
    }

    t.sheet.getRange(rowNum, col.status).setValue('checked_in');
    t.sheet.getRange(rowNum, col.checked_in_at).setValue(nowIso);
    t.sheet.getRange(rowNum, col.checked_in_by).setValue(staff.email);
    t.sheet.getRange(rowNum, col.gate).setValue(staff.gate);
    t.sheet.getRange(rowNum, col.device_id).setValue(device);
    t.sheet.getRange(rowNum, col.scan_count).setValue(1);
    t.sheet.getRange(rowNum, col.updated_at).setValue(nowIso);
    t.sheet.getRange(rowNum, col.updated_by).setValue(staff.email);

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
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.CHECKINS);
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
  requireStaff_(eventId, 'VIEWER');
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
      regId: r.reg_id, name: r.full_name, email: r.email, phone: r.phone, org: r.org,
      type: r.type, code: r.badge_code, status: r.status, source: r.source,
      by: r.checked_in_by || '', at: r.checked_in_at || '', gate: r.gate || ''
    };
  });
}

function svcSetCheckedIn_(p) {
  var staff = requireStaff_(p.eventId, 'STAFF');
  var on = p.on === true || p.on === 'true';
  var t = readSheet_(SHEETS.REGISTRATIONS);
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

function svcSetType_(p) {
  var staff = requireStaff_(p.eventId, 'STAFF');
  var type = String(p.type || '').trim();
  if (PASS_TYPES.indexOf(type) < 0) throw new Error('bad_type');

  var t = readSheet_(SHEETS.REGISTRATIONS);
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
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.REGISTRATIONS);
    regId = 'r' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    badgeCode = p.eventId.toUpperCase().slice(0, 4) + '-' + randomHex_(4) + '-' + (900 + Math.floor(Math.random() * 99));
    var nowIso = new Date().toISOString();
    // Walk-ins are checked in the moment they're created — they're standing
    // at the door.
    sh.appendRow([
      regId, p.eventId, badgeCode, signQr_(p.eventId, badgeCode), name, email, phone,
      String(p.org || ''), (PASS_TYPES.indexOf(String(p.type)) >= 0 ? String(p.type) : 'ทั่วไป'), JSON.stringify({}), 'walkin', 'checked_in',
      nowIso, nowIso, nowIso, staff.email, staff.gate, 'MANUAL', 1, nowIso, staff.email
    ]);
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
  var t = readSheet_(SHEETS.REGISTRATIONS);
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
  requireStaff_(eventId, 'VIEWER');
  var rows = checkinRowsFor_(eventId);
  if (filter && filter !== 'all') rows = rows.filter(function (c) { return c.result === filter; });
  return rows.slice(0, 300).map(function (c) {
    return {
      date: ddmmyy_(c.scanned_at), time: hhmm_(c.scanned_at), name: c.name || '—',
      code: c.badge_code, by: c.scanned_by, gate: c.gate, device: c.device_id, result: c.result
    };
  });
}

function svcCsv_(eventId) {
  requireStaff_(eventId, 'VIEWER');
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
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.FIELDS);
  var all = sh.getDataRange().getValues();
  var headers = all.shift();
  var kept = all.filter(function (r) { return r[0] && r[0] !== p.eventId; });
  var rows = fields.map(function (f, i) {
    return [p.eventId, f.key || ('f' + i), f.label, f.type || 'TEXT', f.required === true, i + 1];
  });
  sh.clear();
  sh.appendRow(headers);
  var out = kept.concat(rows);
  if (out.length) sh.getRange(2, 1, out.length, FIELDS_HEADERS.length).setValues(out);
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

  SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.EVENTS).appendRow([
    id, name, String(p.date || 'ยังไม่กำหนดวัน'), String(p.place || ''), 'เปิดรับ',
    'เปิดรับแล้ว', String(p.price || 'ไม่มีค่าใช้จ่าย'), themes[theme], theme, true, name.toUpperCase()
  ]);
  var fsh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.FIELDS);
  [['name', 'ชื่อ–นามสกุล', 'TEXT', true, 1], ['email', 'อีเมล', 'EMAIL', true, 2], ['phone', 'เบอร์โทรศัพท์', 'PHONE', true, 3]]
    .forEach(function (f) { fsh.appendRow([id].concat(f)); });
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
    return { email: o.email, name: o.name, role: String(o.role || 'VIEWER').toUpperCase(), scope: o.event_scope, gate: o.gate };
  });
}

function svcTeam_() {
  requireStaff_(null, 'VIEWER');
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

// Everything the A6 print page needs for one attendee.
function svcBadgeData_(p) {
  requireStaff_(p.eventId, 'VIEWER');
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
