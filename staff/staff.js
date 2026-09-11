(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Auth + transport.
  //
  // This page is hosted on Vercel — a different origin from the Apps Script
  // backend — so the old trick (same-origin google.script.run, riding on
  // Apps Script's own session) doesn't apply here. Identity instead comes
  // from a Google Identity Services ID token, sent with every call and
  // verified server-side (see verifyIdToken_ in Code.gs) against Google
  // itself, not trusted from the client.
  // ---------------------------------------------------------------------
  var ID_TOKEN_KEY = "staff-id-token";
  // A password sign-in is exchanged for a session token, kept separately from
  // the Google one so signing out of either does not disturb the other.
  var SESSION_KEY = "staff-session";

  function saveSession(token, exp) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ token: token, exp: exp })); } catch (e) {}
  }
  function loadSession() {
    try {
      var d = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (!d || !d.token || !d.exp || d.exp * 1000 < Date.now() + 30000) return null;
      return d.token;
    } catch (e) { return null; }
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function saveToken(token, exp) {
    try { localStorage.setItem(ID_TOKEN_KEY, JSON.stringify({ token: token, exp: exp })); } catch (e) { /* ignore */ }
  }
  function loadToken() {
    try {
      var raw = localStorage.getItem(ID_TOKEN_KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d.token || !d.exp || d.exp * 1000 < Date.now() + 30000) return null; // 30s safety margin
      return d.token;
    } catch (e) { return null; }
  }
  function clearToken() {
    try { localStorage.removeItem(ID_TOKEN_KEY); } catch (e) { /* ignore */ }
  }
  // A JWT's payload is the middle base64url segment — no signature check
  // needed client-side, we only read `exp` to know when to stop using it.
  // The signature IS checked, server-side, on every call.
  function decodeJwtExp(jwt) {
    try {
      var b64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      var json = JSON.parse(decodeURIComponent(atob(b64).split("").map(function (c) {
        return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
      }).join("")));
      return json.exp || 0;
    } catch (e) { return 0; }
  }

  function callSvc(action, payload) {
    var idToken = loadToken();
    var session = loadSession();
    if ((idToken || session) && window.APP_CONFIG && window.APP_CONFIG.APPS_SCRIPT_URL) {
      var body = { action: "staffCall", staffAction: action, payload: payload || {} };
      // The session token wins when both are present: it is the one the person
      // chose most recently, and the server treats them identically anyway.
      if (session) body.sessionToken = session; else body.idToken = idToken;
      return fetch(window.APP_CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(body)
      }).then(function (r) { return r.json(); });
    }
    // Local dev harness only (see ../../../_test/mock-staff.js) — never used
    // in production, where APP_CONFIG + a real token are always present.
    if (window.STAFF_DEV_API) {
      return fetch(window.STAFF_DEV_API, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: action, payload: payload || {} })
      }).then(function (r) { return r.json(); });
    }
    return Promise.reject(new Error("no_transport"));
  }

  // Unwraps {ok,data,error} so callers deal in data or a thrown error.
  function api(action, payload) {
    return callSvc(action, payload).then(function (res) {
      if (!res) throw new Error("empty_response");
      if (!res.ok) throw new Error(res.error || "unknown_error");
      return res.data;
    });
  }


  var THEMES = {
    editorial: { label: "Editorial", paper: "#f4f1e6", accent: "#d8482b", ink: "#17150f" },
    brass: { label: "Ivory & Brass", paper: "#f6f2e8", accent: "#a8874f", ink: "#1c1a16" },
    onyx: { label: "Onyx", paper: "#1a1815", accent: "#c9ac74", ink: "#f0ece3" },
    forest: { label: "Forest", paper: "#f2f4ef", accent: "#2f6b4f", ink: "#141815" },
    ink: { label: "Ink Blue", paper: "#eef1f6", accent: "#2f4d8c", ink: "#12161f" }
  };

  // Kept in the same order the backend validates against; cycling walks this list.
  var PASS_TYPES = ["ทั่วไป", "VIP", "สื่อ"];

  var NAV = [
    { id: "dash", label: "ภาพรวมสด" },
    { id: "event", label: "ตั้งค่างาน" },
    { id: "list", label: "ผู้ลงทะเบียน", count: true },
    { id: "history", label: "ประวัติย้อนหลัง" },
    { id: "fields", label: "ฟิลด์ฟอร์ม" },
    { id: "badge", label: "บัตรเข้างาน" },
    { id: "team", label: "ทีมและสิทธิ์" }
  ];

  var state = {
    phase: "signin",        // signin | loading | error | ready
    fatal: "",
    me: null,
    events: [],
    badgeCfg: {},
    eventId: null,
    screen: "dash",
    dash: null,
    rows: [],
    query: "",
    history: [],
    histFilter: "all",
    fields: [],
    team: [],
    sending: false,
    showWalkin: false,
    showNewEvent: false,
    showInvite: false,
    ne: { name: "", date: "", place: "", theme: "editorial", error: "" },
    // Edits in flight on the ตั้งค่างาน screen. Seeded from the chosen event
    // by loadScreen() so the inputs render with what the sheet actually holds.
    es: { name: "", date: "", place: "", organizerName: "", organizerContact: "", doors: "", price: "", error: "", busy: false },
    walkin: { name: "", email: "", phone: "", type: "ทั่วไป" },
    invite: { email: "", name: "", role: "STAFF", scope: "ALL", gate: "", error: "", withPw: false },
    newField: "",
    toast: "",
    busy: false,
    login: { email: "", error: "", busy: false },
    pwFor: null, pwValue: "", pwError: ""
  };

  var app, toastTimer = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // VIP and press get a visible accent so they stand out while scanning a list.
  function typeClass(type) {
    if (type === "VIP") return " is-vip";
    if (type === "สื่อ") return " is-press";
    return "";
  }
  function ev() { return state.events.filter(function (e) { return e.id === state.eventId; })[0] || null; }
  function theme() { var e = ev(); return THEMES[e && e.theme] || THEMES.editorial; }
  function can(role) {
    var rank = { STAFF: 1, ADMIN: 2 };
    return state.me && (rank[state.me.role] || 0) >= (rank[role] || 0);
  }
  function flash(msg) {
    state.toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { state.toast = ""; render(); }, 2400);
    render();
  }
  function fail(e) {
    var m = String(e && e.message || e);
    if (m.indexOf("forbidden_role") >= 0) m = "สิทธิ์ของคุณไม่พอสำหรับการกระทำนี้";
    else if (m.indexOf("forbidden_event") >= 0) m = "คุณไม่มีสิทธิ์ในงานนี้";
    else if (m.indexOf("busy") >= 0) m = "ระบบกำลังบันทึกรายการอื่น ลองอีกครั้ง";
    flash(m);
  }

  // ---------------------------------------------------------------------
  // Boot / sign-in
  // ---------------------------------------------------------------------
  function boot() {
    app = document.getElementById("app");
    render();
    var existing = loadToken() || loadSession();
    if (existing) { startBootstrap(); return; }
    mountSignIn();
  }

  function mountSignIn() {
    var s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = renderGisButton;
    s.onerror = function () {
      state.phase = "error";
      state.fatal = "gsi_load_failed";
      render();
    };
    document.body.appendChild(s);
  }

  function renderGisButton() {
    var clientId = window.APP_CONFIG && window.APP_CONFIG.GOOGLE_CLIENT_ID;
    var slot = document.getElementById("gis-button");
    if (!clientId || !slot || !window.google || !window.google.accounts) return;
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: function (resp) {
        var exp = decodeJwtExp(resp.credential);
        saveToken(resp.credential, exp);
        startBootstrap();
      }
    });
    window.google.accounts.id.renderButton(slot, { theme: "filled_black", size: "large", text: "signin_with", shape: "pill" });
  }

  function startBootstrap() {
    state.phase = "loading";
    render();
    api("bootstrap").then(function (d) {
      state.me = d.me;
      state.events = d.events || [];
      state.badgeCfg = d.badge || {};
      if (!state.events.length) {
        state.phase = "error";
        state.fatal = "no_events";
        render();
        return;
      }
      state.eventId = state.events[0].id;
      state.phase = "ready";
      render();
      loadScreen();
    }).catch(function (e) {
      var m = String(e && e.message || e);
      // The token we had was rejected outright (not just "not on the team
      // yet") — clear it and send the person back through sign-in rather
      // than showing a dead end.
      if (m.indexOf("invalid_id_token") >= 0 || m.indexOf("wrong_audience") >= 0 ||
          m.indexOf("missing_id_token") >= 0 || m.indexOf("email_not_verified") >= 0) {
        clearToken();
        state.phase = "signin";
        render();
        mountSignIn();
        return;
      }
      state.phase = "error";
      state.fatal = m;
      render();
    });
  }

  function passwordLogin() {
    var em = (document.getElementById("li-email") || {}).value || "";
    var pw = (document.getElementById("li-pass") || {}).value || "";
    state.login.email = em;
    if (!em.trim() || !pw) { state.login.error = "กรอกอีเมลและรหัสผ่านก่อน"; render(); return; }
    state.login.busy = true; state.login.error = ""; render();
    fetch(window.APP_CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "login", email: em.trim(), password: pw })
    }).then(function (r) { return r.json(); }).then(function (res) {
      state.login.busy = false;
      if (!res || !res.ok) {
        // The server deliberately does not say which half was wrong, and
        // neither does this.
        state.login.error = res && res.error === "too_many_attempts"
          ? "ลองผิดหลายครั้งเกินไป รอสัก 15 นาทีแล้วลองใหม่"
          : "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
        render();
        return;
      }
      saveSession(res.data.sessionToken, res.data.exp);
      startBootstrap();
    }).catch(function () {
      state.login.busy = false;
      state.login.error = "เชื่อมต่อไม่สำเร็จ ลองใหม่อีกครั้ง";
      render();
    });
  }

  function savePassword(clearing) {
    var pw = (document.getElementById("pw-value") || {}).value || "";
    if (!clearing && pw.length < 8) { state.pwError = "รหัสผ่านต้องยาวอย่างน้อย 8 ตัว"; render(); return; }
    state.pwError = ""; render();
    api("setPassword", { eventId: state.eventId, email: state.pwFor, password: pw, clear: clearing })
      .then(function () {
        state.pwFor = null;
        flash(clearing ? "ลบรหัสผ่านแล้ว" : "ตั้งรหัสผ่านแล้ว");
        render();
      })
      .catch(function (e) {
        state.pwError = String((e && e.message) || e) === "password_too_short"
          ? "รหัสผ่านต้องยาวอย่างน้อย 8 ตัว" : "ตั้งรหัสผ่านไม่สำเร็จ";
        render();
      });
  }

  function signOut() {
    var session = loadSession();
    // Revoking on the server is what stops a token somebody else copied;
    // clearing it locally only stops this browser. logout is a public action —
    // it takes the token itself rather than a staffCall wrapper, so revoking
    // works even when the session is the thing that has gone wrong.
    if (session && window.APP_CONFIG && window.APP_CONFIG.APPS_SCRIPT_URL) {
      try {
        fetch(window.APP_CONFIG.APPS_SCRIPT_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ action: "logout", sessionToken: session })
        });
      } catch (e) {}
    }
    clearToken();
    clearSession();
    state.phase = "signin";
    state.me = null;
    render();
    mountSignIn();
  }


  function loadScreen() {
    var s = state.screen, id = state.eventId;
    if (s === "dash") {
      api("dashboard", { eventId: id }).then(function (d) { state.dash = d; render(); }).catch(fail);
    } else if (s === "list") {
      api("attendees", { eventId: id, query: state.query }).then(function (d) { state.rows = d; render(); }).catch(fail);
    } else if (s === "history") {
      api("history", { eventId: id, filter: state.histFilter }).then(function (d) { state.history = d; render(); }).catch(fail);
    } else if (s === "fields") {
      // The same rows the customer form renders from, so what staff edit here
      // is literally what the next customer will be asked.
      api("fields", { eventId: id }).then(function (d) { state.fields = d || []; render(); }).catch(fail);
    } else if (s === "event") {
      // No round trip — bootstrap already carries every field this screen edits.
      var e = ev() || {};
      state.es = {
        name: e.name || "", date: e.date || "", place: e.place || "",
        organizerName: e.organizerName || "", organizerContact: e.organizerContact || "",
        doors: e.doors || "", price: e.price || "", error: "", busy: false
      };
      render();
    } else if (s === "team") {
      api("team").then(function (d) { state.team = d; render(); }).catch(fail);
    }
  }

  function go(screen) {
    if (screen === state.screen) return;
    state.screen = screen;
    render();
    loadScreen();
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  function render() {
    if (!app) return;
    var html;
    if (state.phase === "signin") html = renderSignIn();
    else if (state.phase === "loading") html = renderBoot();
    else if (state.phase === "error") html = renderFatal();
    else html = renderShell();
    if (state.pwFor) html += renderPwBox();
    if (state.toast) html += '<div class="toast">' + esc(state.toast) + "</div>";
    app.innerHTML = html;
    bind();
    if (state.phase === "signin" && window.google && window.google.accounts) renderGisButton();
  }

  function renderPwBox() {
    var mine = state.me && state.pwFor === state.me.email;
    return '<div class="pw-veil" data-act="close-pw"></div>' +
      '<div class="pw-modal">' +
      '<div class="modal-head"><div class="modal-title">' +
      (mine ? "เปลี่ยนรหัสผ่านของฉัน" : "ตั้งรหัสผ่านให้ " + esc(state.pwFor)) + "</div>" +
      '<div class="modal-close" data-act="close-pw">ปิด ✕</div></div>' +
      '<div class="field"><div class="field-label">รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)</div>' +
      '<input id="pw-value" type="password" autocomplete="new-password" placeholder="พิมพ์รหัสผ่าน"></div>' +
      '<div class="err">' + esc(state.pwError) + "</div>" +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">' +
      '<button class="btn-light" data-act="save-pw">บันทึกรหัสผ่าน</button>' +
      '<button class="mini" data-act="clear-pw">' + (mine ? "ลบรหัสผ่านของฉัน" : "ลบรหัสผ่านของคนนี้") + "</button></div>" +
      '<div class="muted">เข้าใช้งานได้ทั้งด้วยบัญชี Google เดิมและด้วยรหัสผ่านนี้ · ' +
      'ระบบเก็บเฉพาะค่าที่ผ่านการแฮชแล้ว อ่านย้อนกลับไม่ได้ ถ้าลืมต้องตั้งใหม่</div></div>';
  }

  function renderSignIn() {
    return '<div class="boot"><div class="boot-card">' +
      '<div class="boot-kicker">STAFF CONSOLE</div>' +
      '<div class="boot-title">ระบบลงทะเบียน<br>เข้างาน</div>' +
      '<div class="boot-sub">เข้าสู่ระบบด้วยบัญชี Google ที่ได้รับสิทธิ์เจ้าหน้าที่</div>' +
      '<div class="boot-rule"></div>' +
      '<div id="gis-button"></div>' +
      '<div class="muted">ใช้อีเมล Google ที่แอดมินเพิ่มไว้ในทีมเท่านั้น</div>' +
      '<div class="signin-or"><span>หรือ</span></div>' +
      '<div class="field"><div class="field-label">อีเมล</div>' +
      '<input id="li-email" type="email" autocomplete="username" value="' + esc(state.login.email) + '" placeholder="name@company.com"></div>' +
      '<div class="field"><div class="field-label">รหัสผ่าน</div>' +
      '<input id="li-pass" type="password" autocomplete="current-password" placeholder="รหัสผ่านที่แอดมินตั้งให้"></div>' +
      '<div class="err">' + esc(state.login.error) + "</div>" +
      '<button class="btn-light" data-act="password-login" style="width:100%">' +
      (state.login.busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบด้วยรหัสผ่าน") + "</button>" +
      '<div class="muted">รหัสผ่านตั้งได้จากหน้าทีมงาน โดยแอดมินที่ล็อกอินด้วย Google อยู่แล้ว</div>' +
      "</div></div>";
  }

  function renderBoot() {
    return '<div class="boot"><div class="boot-card">' +
      '<div class="boot-kicker">STAFF CONSOLE</div>' +
      '<div class="boot-title">ระบบลงทะเบียน<br>เข้างาน</div>' +
      '<div style="display:flex;align-items:center;gap:14px"><div class="spinner"></div>' +
      '<div class="boot-sub">กำลังตรวจสอบสิทธิ์…</div></div>' +
      "</div></div>";
  }

  function renderFatal() {
    var f = state.fatal, body;
    if (f.indexOf("no_identity") >= 0) {
      body = "<p>Google ไม่ได้ส่งอีเมลของคุณมาให้ระบบ — แปลว่า Web App ถูก deploy ในโหมดที่ระบุตัวตนไม่ได้</p>" +
        "<p><b>วิธีแก้:</b> ใน Apps Script → Deploy → Manage deployments → แก้ deployment ของ Staff Console ให้เป็น<br>" +
        "<code>Execute as: Me</code><br><code>Who has access: Anyone with a Google account</code><br>" +
        "ถ้าตั้งแบบนี้แล้วยังไม่ได้ ให้เปลี่ยนเป็น <code>Execute as: User accessing the web app</code> " +
        "แล้วแชร์ Google Sheet ให้เจ้าหน้าที่คนนั้นแบบ Viewer</p>";
    } else if (f.indexOf("not_authorized") >= 0) {
      var who = f.split(":")[1] || "";
      body = "<p>บัญชี <code>" + esc(who) + "</code> ยังไม่อยู่ในรายชื่อทีมงาน</p>" +
        "<p><b>วิธีแก้:</b> เปิด Google Sheet ชื่อ <b>Event Check-in — Team Access</b> → แท็บ <code>Staff</code> → " +
        "เพิ่มแถวใหม่: อีเมลนี้, ชื่อ, บทบาท (ADMIN / STAFF), ขอบเขต (<code>ALL</code> หรือรหัสงาน), ประตู</p>";
    } else if (f.indexOf("team_access_not_configured") >= 0) {
      body = "<p>ยังไม่ได้สร้างไฟล์สิทธิ์ทีมงาน</p><p><b>วิธีแก้:</b> ใน Apps Script เลือกฟังก์ชัน " +
        "<code>setupTeamAccessSheet</code> แล้วกด Run หนึ่งครั้ง</p>";
    } else if (f.indexOf("google_client_id_not_configured") >= 0) {
      body = "<p>ยังไม่ได้ใส่ Google OAuth Client ID ในโค้ดฝั่งเซิร์ฟเวอร์</p>" +
        "<p><b>วิธีแก้:</b> เปิด <code>backend/Code.gs</code> → แก้ค่า <code>GOOGLE_CLIENT_ID</code> " +
        "ให้เป็น Client ID จริงจาก Google Cloud Console → Credentials แล้ว deploy ใหม่</p>";
    } else if (f.indexOf("wrong_audience") >= 0) {
      body = "<p>Client ID ที่หน้าเว็บใช้ ไม่ตรงกับที่ตั้งไว้ในเซิร์ฟเวอร์</p>" +
        "<p><b>วิธีแก้:</b> ตรวจว่า <code>GOOGLE_CLIENT_ID</code> ใน <code>Code.gs</code> กับใน " +
        "<code>staff/config.js</code> (ฝั่งหน้าเว็บ) เป็นค่าเดียวกันเป๊ะ</p>";
    } else if (f.indexOf("gsi_load_failed") >= 0) {
      body = "<p>โหลดสคริปต์ Google Sign-In ไม่สำเร็จ</p><p><b>วิธีแก้:</b> เช็คว่าเครื่องนี้เข้าอินเทอร์เน็ตได้ " +
        "และ accounts.google.com ไม่ถูกบล็อก แล้วลองรีเฟรชอีกครั้ง</p>";
    } else if (f.indexOf("no_events") >= 0) {
      body = "<p>ไม่พบงานที่คุณมีสิทธิ์เข้าถึง</p><p><b>วิธีแก้:</b> ตรวจคอลัมน์ <code>event_scope</code> " +
        "ในแท็บ Staff ว่าเป็น <code>ALL</code> หรือมีรหัสงานที่มีอยู่จริง</p>";
    } else {
      body = "<p>เกิดข้อผิดพลาด: <code>" + esc(f) + "</code></p>";
    }
    return '<div class="boot"><div class="boot-card">' +
      '<div class="boot-kicker">STAFF CONSOLE</div>' +
      '<div class="boot-title">เข้าใช้งานไม่ได้</div>' +
      '<div class="boot-rule"></div>' +
      '<div class="boot-err">' + body + "</div>" +
      '<div class="btn-ghost" data-act="reload" style="text-align:center">ลองใหม่อีกครั้ง</div>' +
      "</div></div>";
  }

  function renderShell() {
    return '<div class="shell">' + renderSide() + '<div class="main">' + renderTop() + renderPage() + "</div></div>" +
      (state.showNewEvent ? renderNewEvent() : "");
  }

  function renderSide() {
    // Hidden events are archived: kept fully intact (data, files, badge
    // config — nothing deleted) but dropped from the public customer picker.
    // Staff still see them here, dimmed, with an ADMIN-only toggle to
    // un-hide. See svcSetEventProp_'s `hidden` handling.
    var evs = state.events.map(function (e) {
      return '<div class="ev' + (e.id === state.eventId ? " is-active" : "") + (e.hidden ? " is-hidden" : "") + '">' +
        '<div data-act="pick-event" data-id="' + esc(e.id) + '" style="cursor:pointer;flex:1;min-width:0">' +
        '<div class="ev-name">' + esc(e.name) + (e.hidden ? " · ซ่อนจากลูกค้า" : "") + "</div>" +
        '<div class="ev-meta">' + esc(e.date || "") + "</div></div>" +
        (can("ADMIN")
          ? '<div class="ev-hide" data-act="toggle-hidden" data-id="' + esc(e.id) + '" data-hidden="' + (e.hidden ? "0" : "1") + '" title="' + (e.hidden ? "แสดงงานนี้ให้ลูกค้าเห็นอีกครั้ง" : "ซ่อนงานนี้จากหน้าลูกค้า (ข้อมูลเดิมยังอยู่ครบ)") + '">' + (e.hidden ? "แสดง" : "ซ่อน") + "</div>"
          : "") +
        "</div>";
    }).join("");

    // Team & roles is ADMIN-only — hidden here, and rejected by svcTeam_ on
    // the backend too if someone calls the API directly.
    var nav = NAV.filter(function (n) {
      return n.id !== "team" || can("ADMIN");
    }).map(function (n) {
      var count = n.count && state.dash ? '<div class="nav-count">' + state.dash.total + "</div>" : "";
      return '<div class="nav-item' + (state.screen === n.id ? " is-active" : "") + '" data-act="nav" data-id="' + n.id + '">' +
        '<div class="nav-bar"></div><div class="nav-label">' + esc(n.label) + "</div>" + count + "</div>";
    }).join("");

    var me = state.me || {};
    return '<div class="side">' +
      '<div class="side-head"><div class="side-brand">STAFF CONSOLE</div><div class="side-org">ThinkTech Events</div></div>' +
      '<div class="evbox"><div class="evbox-head"><div class="evbox-label">งานที่กำลังดู</div>' +
      (can("ADMIN") ? '<div class="evbox-add" data-act="new-event" title="เพิ่มงานใหม่">+</div>' : "") + "</div>" +
      evs + (can("ADMIN") ? '<div class="ev-new" data-act="new-event">+ เพิ่มงานใหม่</div>' : "") + "</div>" +
      '<div class="nav">' + nav + "</div>" +
      '<div class="side-foot"><div class="avatar">' + esc((me.name || "?").slice(0, 1)) + "</div>" +
      '<div class="side-me"><div class="side-me-name">' + esc(me.name || "") + "</div>" +
      '<div class="side-me-role">' + esc(me.role || "") + " · " + esc(me.gate || "") + "</div></div>" +
      '<div class="mono" data-act="my-pw" style="margin-left:auto;font-size:9.5px;color:var(--muted);cursor:pointer">รหัสผ่าน</div>' +
      '<div class="mono" data-act="sign-out" style="font-size:9.5px;color:var(--muted);cursor:pointer">ออก</div></div></div>';
  }

  function renderTop() {
    var e = ev() || {};
    var synced = state.dash ? "SYNCED · " + new Date(state.dash.syncedAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) : "SYNCED · GOOGLE SHEET";
    return '<div class="topbar"><div style="min-width:0">' +
      '<div class="topbar-title">' + esc(e.name || "") + "</div>" +
      '<div class="topbar-meta">' + esc([e.date, e.place].filter(Boolean).join(" · ")) + "</div></div>" +
      '<div class="topbar-right">' +
      '<div class="chip"><div class="chip-dot"></div><div class="chip-label">' + esc(synced) + "</div></div>" +
      '<button class="btn-ghost" data-act="refresh">REFRESH</button>' +
      (can("ADMIN") ? '<button class="btn-ghost" data-act="export">EXPORT CSV</button>' : "") +
      "</div></div>";
  }

  function renderPage() {
    switch (state.screen) {
      case "dash": return renderDash();
      case "event": return renderEvent();
      case "list": return renderList();
      case "history": return renderHistory();
      case "fields": return renderFields();
      case "badge": return renderBadge();
      case "team": return renderTeam();
    }
    return "";
  }

  // ---------------------------------------------------------------------
  function renderDash() {
    var d = state.dash;
    if (!d) return '<div class="page"><div class="empty">กำลังโหลด…</div></div>';
    var maxBar = Math.max.apply(null, d.bars.map(function (b) { return b.n; }).concat([1]));
    var bars = d.bars.map(function (b) {
      var h = Math.round(b.n / maxBar * 120);
      return '<div class="bar-col"><div class="bar-n">' + b.n + "</div>" +
        '<div class="bar-fill' + (b.n === maxBar && b.n > 0 ? " is-peak" : "") + '" style="height:' + Math.max(h, 2) + 'px"></div>' +
        '<div class="bar-hour">' + esc(b.hour) + "</div></div>";
    }).join("");

    var board = d.staffBoard.length ? d.staffBoard.map(function (s) {
      return '<div class="row-line"><div class="dot' + (s.scans > 0 ? " is-on" : "") + '"></div>' +
        '<div style="flex:1;min-width:0"><div class="cell-name">' + esc(s.name) + "</div>" +
        '<div class="cell-sub">' + esc(s.role + " · " + (s.gate || "—")) + "</div></div>" +
        '<div class="mono" style="font-size:13px">' + s.scans + "</div></div>";
    }).join("") : '<div class="muted">ยังไม่มีเจ้าหน้าที่สแกนวันนี้</div>';

    var feed = d.feed.length ? d.feed.map(function (f) {
      return '<div class="row-line"><div class="feed-time">' + esc(f.time) + "</div>" +
        '<div class="feed-text">' + esc(f.text) + "</div></div>";
    }).join("") : '<div class="muted">ยังไม่มีกิจกรรม</div>';

    return '<div class="page">' +
      '<div class="stats">' +
      '<div class="stat"><div class="stat-label">ลงทะเบียนล่วงหน้า</div><div class="stat-value">' + d.total + "</div></div>" +
      '<div class="stat is-gold"><div class="stat-label">เข้างานแล้ว</div><div class="stat-value">' + d.checkedIn + "</div></div>" +
      '<div class="stat"><div class="stat-label">อัตราเข้างาน</div><div class="stat-value">' + esc(d.rate) + "</div></div>" +
      '<div class="stat"><div class="stat-label">Walk-in หน้างาน</div><div class="stat-value">' + d.walkins + "</div></div>" +
      "</div>" +
      '<div class="panels">' +
      '<div class="panel is-wide"><div class="panel-head"><div class="panel-title">การเช็คอินรายชั่วโมง</div>' +
      '<div class="panel-kicker">TODAY · LIVE</div></div><div class="bars">' + bars + "</div></div>" +
      '<div class="panel is-narrow"><div class="panel-head"><div class="panel-title">เจ้าหน้าที่ที่กำลังสแกน</div>' +
      '<div class="panel-kicker">SCANS</div></div><div>' + board + "</div>" +
      '<div class="muted">ทุกการเช็คอินบันทึกชื่อผู้สแกน เวลา และประตู ลงแถวเดียวกันใน Google Sheet</div></div>' +
      '<div class="panel is-narrow"><div class="panel-title">กิจกรรมล่าสุด (ทุกเครื่อง)</div><div>' + feed + "</div></div>" +
      "</div></div>";
  }

  // ---------------------------------------------------------------------
  function renderList() {
    var rows = state.rows.map(function (r) {
      var isIn = r.status === "checked_in";
      return '<div class="trow">' +
        '<div class="c-grow2"><div class="cell-name">' + esc(r.name) + "</div>" +
        '<div class="cell-sub">' + esc(r.org || "") + (r.source === "walkin" ? " · WALK-IN" : "") + "</div></div>" +
        // Email/phone come back blank from the API for non-ADMIN roles
        // (PDPA — door staff don't need contact info to do their job); the
        // column itself is hidden here too rather than showing empty cells.
        (can("ADMIN")
          ? '<div class="c-grow2"><div class="cell-sub" style="color:var(--ink-soft)">' + esc(r.email || "") + "</div>" +
            '<div class="cell-mono">' + esc(r.phone || "") + "</div></div>"
          : "") +
        '<div class="c-code">' + esc(r.code) + "</div>" +
        '<div class="c-type">' +
        (can("ADMIN")
          ? '<button class="mini type-btn' + typeClass(r.type) + '" data-act="cycle-type" data-id="' + esc(r.regId) + '" data-type="' + esc(r.type || "") + '" title="กดเพื่อเปลี่ยนประเภทบัตร">' + esc(r.type || "—") + "</button>"
          : '<div class="tag"><div class="tag-label">' + esc(r.type || "—") + "</div></div>") +
        "</div>" +
        '<div class="c-status"><div class="tag' + (isIn ? " is-in" : "") + '"><div class="tag-dot"></div>' +
        '<div class="tag-label">' + (isIn ? "เข้างานแล้ว" : "ลงทะเบียน") + "</div></div>" +
        '<div class="cell-mono">' + esc(isIn ? (r.by || "") : "") + "</div></div>" +
        '<div class="c-actions">' +
        // Unlike the gate app, printing here is not held behind a check-in.
        // This is the desk: printing a stack of badges the night before an
        // event is the normal way to work, and nobody is standing at a door
        // waiting to be let in on the strength of it.
        (can("STAFF") ? '<button class="mini" data-act="print-badge" data-id="' + esc(r.regId) + '">พิมพ์</button>' : "") +
        (can("STAFF") ? '<button class="mini" data-act="toggle-in" data-id="' + esc(r.regId) + '" data-on="' + (isIn ? "0" : "1") + '">' + (isIn ? "ยกเลิก" : "เช็คอิน") + "</button>" : "") +
        (can("ADMIN") ? '<button class="mini is-danger" data-act="del" data-id="' + esc(r.regId) + '" data-name="' + esc(r.name) + '">ลบ</button>' : "") +
        "</div></div>";
    }).join("");

    var walkin = state.showWalkin ? '<div class="walkin">' +
      '<div class="modal-head"><div class="modal-title">ลงทะเบียน Walk-in หน้างาน</div>' +
      '<div class="modal-close" data-act="toggle-walkin">ปิด ✕</div></div>' +
      '<div class="field-row">' +
      '<div class="field"><div class="field-label">ชื่อ–นามสกุล *</div><input id="w-name" value="' + esc(state.walkin.name) + '" placeholder="ชื่อผู้เข้าร่วม" /></div>' +
      '<div class="field"><div class="field-label">อีเมล</div><input id="w-email" value="' + esc(state.walkin.email) + '" placeholder="name@company.com" /></div>' +
      '<div class="field"><div class="field-label">เบอร์โทร</div><input id="w-phone" value="' + esc(state.walkin.phone) + '" placeholder="08X XXX XXXX" /></div>' +
      "</div>" +
      '<div><div class="side-kicker" style="margin-bottom:9px">ประเภทบัตร</div><div class="pills">' +
      PASS_TYPES.map(function (ty) {
        return '<div class="pill' + (state.walkin.type === ty ? " is-active" : "") + '" data-act="walkin-type" data-id="' + esc(ty) + '">' + esc(ty) + "</div>";
      }).join("") + "</div></div>" +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">' +
      '<button class="btn-light" data-act="save-walkin">บันทึกและเช็คอินทันที</button>' +
      '<div class="muted">สร้างรหัสบัตรใหม่และเช็คอินให้ทันทีในขั้นตอนเดียว</div></div></div>' : "";

    return '<div class="page">' +
      '<div class="toolbar"><div class="search"><div class="mono" style="color:var(--muted)">⌕</div>' +
      '<input id="q" value="' + esc(state.query) + '" placeholder="ค้นหาชื่อ อีเมล เบอร์โทร หรือรหัสบัตร" autocomplete="off" /></div>' +
      (can("STAFF") ? '<button class="btn-gold" data-act="toggle-walkin">+ WALK-IN</button>' : "") + "</div>" +
      walkin +
      '<div class="card"><div class="thead">' +
      '<div class="c-grow2">ผู้เข้าร่วม</div><div class="c-grow2">ติดต่อ</div>' +
      '<div class="c-code">รหัสบัตร</div><div class="c-type">ประเภทบัตร</div>' +
      '<div class="c-status">สถานะ · ผู้สแกน</div><div class="c-actions">จัดการ</div></div>' +
      (rows || '<div class="empty">ยังไม่มีผู้ลงทะเบียนในงานนี้</div>') +
      '<div class="tfoot"><div>' + state.rows.length + " รายการ</div><div>ทุกการแก้ไขบันทึกลง Google Sheet ทันที</div></div></div></div>";
  }

  // ---------------------------------------------------------------------
  function renderHistory() {
    var tabs = [["all", "ทั้งหมด"], ["ok", "สำเร็จ"], ["duplicate", "สแกนซ้ำ"], ["not_found", "ไม่พบ"], ["undo", "ยกเลิก"]]
      .map(function (t) {
        return '<div class="pill' + (state.histFilter === t[0] ? " is-active" : "") + '" data-act="hist" data-id="' + t[0] + '">' + esc(t[1]) + "</div>";
      }).join("");

    var rows = state.history.map(function (h) {
      var ok = h.result === "ok";
      return '<div class="trow"><div style="width:104px;flex:none" class="mono' + '" >' +
        '<div style="font-size:9.5px;color:var(--ink-soft)">' + esc(h.date) + "</div>" +
        '<div style="font-size:9.5px;color:var(--ink-soft)">' + esc(h.time) + "</div></div>" +
        '<div class="c-grow2"><div class="cell-name">' + esc(h.name) + "</div>" +
        '<div class="cell-mono">' + esc(h.device || "") + "</div></div>" +
        '<div class="c-code">' + esc(h.code) + "</div>" +
        '<div class="c-grow1"><div class="cell-sub" style="color:var(--ink-soft)">' + esc(h.by) + "</div>" +
        '<div class="cell-mono">' + esc(h.gate || "") + "</div></div>" +
        '<div style="width:88px;flex:none;display:flex;justify-content:flex-end">' +
        '<div class="tag' + (ok ? " is-in" : "") + '"><div class="tag-label">' + esc(h.result) + "</div></div></div></div>";
    }).join("");

    return '<div class="page">' +
      '<div><div class="page-title">ประวัติการสแกนย้อนหลัง</div>' +
      '<div class="page-sub">ทุกครั้งที่สแกนถูกบันทึกเป็นแถวใหม่ ไม่ทับของเดิม · ตรงกับชีต Checkins ใน Google Sheet</div></div>' +
      '<div class="pills">' + tabs + "</div>" +
      '<div class="card"><div class="thead">' +
      '<div style="width:104px;flex:none">วันเวลา</div><div class="c-grow2">ผู้เข้าร่วม</div>' +
      '<div class="c-code">รหัสบัตร</div><div class="c-grow1">ผู้สแกน · จุด</div>' +
      '<div style="width:88px;flex:none;text-align:right">ผล</div></div>' +
      (rows || '<div class="empty">ยังไม่มีประวัติการสแกน</div>') +
      '<div class="tfoot"><div>' + state.history.length + " รายการ</div></div></div></div>";
  }

  // ---------------------------------------------------------------------
  function renderEvent() {
    var e = ev() || {};
    var admin = can("ADMIN");
    var es = state.es;

    function textRow(id, label, value, hint) {
      return '<div class="field"><div class="field-label">' + esc(label) + "</div>" +
        '<input id="' + id + '" value="' + esc(value) + '"' + (admin ? "" : " disabled") + ' />' +
        (hint ? '<div class="muted" style="font:300 11px/1.5 Prompt,sans-serif;margin-top:4px">' + esc(hint) + "</div>" : "") +
        "</div>";
    }

    function switchRow(actName, label, on, onText, offText, detail) {
      return '<div class="card" style="padding:16px 20px;display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:220px"><div style="font:500 13px Prompt,sans-serif">' + esc(label) + "</div>" +
        '<div class="muted" style="font:300 11.5px/1.5 Prompt,sans-serif;margin-top:3px">' + esc(detail) + "</div></div>" +
        (admin
          ? '<button class="btn-ghost" data-act="' + actName + '" data-on="' + (on ? "0" : "1") + '"' +
            (on ? ' style="border-color:var(--accent);color:var(--accent)"' : "") + ">" +
            esc(on ? onText : offText) + "</button>"
          : '<span class="muted">ต้องเป็น ADMIN</span>') +
        "</div>";
    }

    var open = !!e.open;
    var priceOn = !!(e.price && String(e.price).trim());

    var bannerPreview = e.image
      ? '<img src="' + esc(e.image) + '" alt="" style="width:100%;display:block;aspect-ratio:16/9;object-fit:cover" />'
      : '<div style="width:100%;aspect-ratio:16/9;background:linear-gradient(148deg,#d8482b 0%,#8e3524 34%,#17150f 82%);' +
        'display:flex;align-items:center;justify-content:center;color:rgba(244,241,230,.72);' +
        'font:600 10px Prompt,sans-serif;letter-spacing:.3em">1NEVE</div>';

    var bannerCard = '<div class="card" style="padding:0;overflow:hidden">' + bannerPreview +
      '<div style="padding:16px 20px;display:flex;flex-wrap:wrap;gap:10px;align-items:center">' +
      '<div style="flex:1;min-width:200px"><div style="font:500 13px Prompt,sans-serif">ภาพแบนเนอร์</div>' +
      '<div class="muted" style="font:300 11.5px/1.5 Prompt,sans-serif;margin-top:3px">' +
      (e.image
        ? "ใช้ภาพที่อัพโหลดไว้ · ระบบจะย่อให้กว้างสุด 1600px ก่อนส่ง"
        : "ยังไม่ได้ใส่ภาพ · หน้าลูกค้าจะแสดงพื้นผิวของ 1NEVE แทน") +
      "</div>" +
      '<div class="muted" style="font:300 11px/1.5 Prompt,sans-serif;margin-top:6px">' +
      "ของสำคัญในภาพไม่ควรอยู่ครึ่งล่าง เพราะชื่องานและปุ่มลงทะเบียนทับอยู่</div></div>" +
      (admin
        ? '<input type="file" id="banner-file" accept="image/jpeg,image/png,image/webp" style="display:none" />' +
          '<button class="btn-ghost" data-act="banner-pick" style="border-color:var(--accent);color:var(--accent);padding:11px 16px">' +
          (state.es.busy ? "กำลังอัพโหลด…" : (e.image ? "เปลี่ยนภาพ" : "อัพโหลดภาพ")) + "</button>"
        : '<span class="muted">ต้องเป็น ADMIN</span>') +
      "</div></div>";

    return '<div class="split"><div class="split-main">' +
      '<div><div class="page-title">ตั้งค่างาน</div>' +
      '<div class="page-sub">ค่าทั้งหมดของงานนี้อยู่ที่เดียว · ' +
      "ช่องที่ทำเครื่องหมาย <b>เฉพาะภายใน</b> ไม่เคยถูกส่งออกไปหน้าลูกค้า</div></div>" +

      '<div class="card" style="padding:20px">' +
      textRow("es-name", "ชื่องาน", es.name, "") +
      textRow("es-date", "วันที่จัด", es.date, "ข้อความอิสระ เช่น 15 มี.ค. 70") +
      textRow("es-place", "สถานที่", es.place, "") +
      textRow("es-doors", "เวลาเปิดประตู", es.doors, "ข้อความอิสระ พิมพ์บนบัตร · เว้นว่างได้") +
      "</div>" +

      '<div class="card" style="padding:20px">' +
      '<div class="side-kicker" style="margin-bottom:12px">ผู้จัดงาน · เฉพาะภายใน</div>' +
      textRow("es-org-name", "ชื่อผู้จัดงาน", es.organizerName,
        "ลูกค้าไม่เห็นช่องนี้ · มีไว้ให้ตอบได้ว่าใครรับข้อมูลของงานนี้ไป") +
      textRow("es-org-contact", "ผู้ติดต่อผู้จัดงาน", es.organizerContact, "") +
      "</div>" +

      bannerCard +

      switchRow("toggle-open", "เปิดรับลงทะเบียน", open, "เปิดอยู่", "ปิดอยู่",
        open ? "หน้าลูกค้าเปิดให้ลงทะเบียนได้" : "หน้าลูกค้าแสดงว่าปิดรับแล้ว และปุ่มลงทะเบียนกดไม่ได้") +

      '<div class="card" style="padding:16px 20px">' +
      '<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:220px"><div style="font:500 13px Prompt,sans-serif">ค่าเข้างาน</div>' +
      '<div class="muted" style="font:300 11.5px/1.5 Prompt,sans-serif;margin-top:3px">' +
      (priceOn ? "แสดงบรรทัดนี้ในข้อมูลงาน" : "ไม่แสดงบรรทัดค่าเข้างานเลย") + "</div></div>" +
      (admin
        ? '<button class="btn-ghost" data-act="toggle-price" data-on="' + (priceOn ? "0" : "1") + '"' +
          (priceOn ? ' style="border-color:var(--accent);color:var(--accent)"' : "") + ">" +
          (priceOn ? "เปิดอยู่" : "ปิดอยู่") + "</button>"
        : '<span class="muted">ต้องเป็น ADMIN</span>') +
      "</div>" +
      (priceOn ? '<div style="margin-top:14px">' + textRow("es-price", "ข้อความที่แสดง", es.price, "เช่น ฿500 หรือ ฟรีสำหรับสมาชิก") + "</div>" : "") +
      "</div>" +

      (es.error ? '<div class="err">' + esc(es.error) + "</div>" : "") +
      (admin
        ? '<div><button class="btn-gold" data-act="event-save">บันทึกการตั้งค่า</button></div>'
        : '<div class="muted">ต้องเป็น ADMIN จึงจะบันทึกได้</div>') +
      "</div>" +

      '<div class="split-side"><div class="side-kicker">หน้าลูกค้าจะเห็น</div>' +
      '<div class="card" style="padding:0;overflow:hidden">' + bannerPreview +
      '<div style="padding:18px 20px">' +
      '<div class="mono" style="font-size:9.5px;letter-spacing:.26em;color:var(--accent)">' + esc(es.date || "") + "</div>" +
      '<div class="serif" style="font-size:22px;font-weight:200;line-height:1.2;margin-top:9px">' + esc(es.name || "") + "</div>" +
      '<div class="muted" style="font:300 12px Prompt,sans-serif;margin-top:4px">' + esc(es.place || "") + "</div>" +
      '<div style="margin-top:14px;padding:12px 0;text-align:center;font:600 12px Prompt,sans-serif;' +
      (open ? "background:var(--accent);color:#fff" : "background:#ded8c6;color:#57533f") + '">' +
      (open ? "ลงทะเบียน" : "ปิดรับแล้ว") + "</div>" +
      "</div></div></div></div>";
  }

  // ---------------------------------------------------------------------
  function renderFields() {
    // Consent is taken by the act of confirming, with the wording shown next
    // to the button — so this switch decides whether that wording appears at
    // all, and whether register() demands consent for this event.
    var e = ev() || {};
    var pdpaOn = !!e.pdpa;
    var pdpaRow = '<div class="card" style="padding:16px 20px;display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:220px"><div style="font:500 13px Prompt,sans-serif">ข้อความยินยอม PDPA</div>' +
      '<div class="muted" style="font:300 11.5px/1.5 Prompt,sans-serif;margin-top:3px">' +
      (pdpaOn
        ? "กำลังแสดงใต้ปุ่มยืนยัน · การกดยืนยันถือเป็นการให้ความยินยอม และระบบจะบันทึกเวลาไว้"
        : "ปิดอยู่ · หน้าลงทะเบียนไม่แสดงข้อความ และไม่บันทึกเวลายินยอม") +
      "</div></div>" +
      (can("ADMIN")
        ? '<button class="btn-ghost" data-act="toggle-pdpa" data-on="' + (pdpaOn ? "0" : "1") + '"' +
          (pdpaOn ? ' style="border-color:var(--accent);color:var(--accent)"' : "") + ">" +
          (pdpaOn ? "เปิดอยู่" : "ปิดอยู่") + "</button>"
        : '<span class="muted">ต้องเป็น ADMIN</span>') +
      "</div>";

    var rows = state.fields.map(function (f, i) {
      return '<div class="trow"><div class="mono" style="width:22px;color:var(--muted)">' + (i + 1) + "</div>" +
        '<div class="c-grow1"><div class="cell-name">' + esc(f.label) + "</div>" +
        '<div class="cell-mono">' + esc(f.type || "TEXT") + "</div></div>" +
        '<button class="mini" data-act="field-req" data-i="' + i + '">' + (f.required ? "จำเป็น" : "ไม่บังคับ") + "</button>" +
        '<button class="mini is-danger" data-act="field-del" data-i="' + i + '">✕</button></div>';
    }).join("");

    var preview = state.fields.map(function (f) {
      return '<div class="field"><div class="field-label">' + esc(f.label) + (f.required ? " *" : "") + "</div>" +
        '<div style="font:300 14px Prompt,sans-serif;color:var(--placeholder);margin-top:4px">' + esc(f.type === "EMAIL" ? "name@company.com" : f.type === "PHONE" ? "08X XXX XXXX" : "…") + "</div></div>";
    }).join("");

    return '<div class="split"><div class="split-main">' +
      '<div><div class="page-title">ฟิลด์ในฟอร์มลงทะเบียน</div>' +
      '<div class="page-sub">ตั้งค่าแยกตามแต่ละงาน · เพิ่ม ลบ หรือกำหนดว่าฟิลด์ใดจำเป็น แล้วกดบันทึก<br>' +
      'หน้าลูกค้าอ่านฟิลด์ชุดนี้จริง — ฟิลด์ที่ตั้งเป็น <b>จำเป็น</b> จะอยู่หน้าแรก ' +
      'ที่เหลืออยู่หน้าถัดไปซึ่งลูกค้าข้ามได้ ถ้าไม่มีฟิลด์ที่ไม่บังคับเลย จะเหลือหน้าเดียวแล้วขึ้น QR ทันที</div></div>' +
      '<div class="card">' + (rows || '<div class="empty">ยังไม่มีฟิลด์</div>') +
      '<div style="padding:16px 20px;display:flex;flex-wrap:wrap;gap:10px;align-items:center">' +
      '<input id="new-field" value="' + esc(state.newField) + '" placeholder="ชื่อฟิลด์ใหม่ เช่น ตำแหน่งงาน" ' +
      'style="flex:1;min-width:170px;background:var(--sunken);border:1px solid var(--line);outline:none;padding:11px 13px;font:300 12.5px Prompt,sans-serif" />' +
      '<button class="btn-ghost" data-act="field-add" style="border-color:var(--accent);color:var(--accent);padding:11px 16px">+ เพิ่มฟิลด์</button></div></div>' +
      pdpaRow +
      (can("ADMIN") ? '<div><button class="btn-gold" data-act="fields-save">บันทึกฟิลด์ของงานนี้</button></div>' : '<div class="muted">ต้องเป็น ADMIN จึงจะบันทึกได้</div>') +
      "</div>" +
      '<div class="split-side"><div class="side-kicker">พรีวิวหน้าลูกค้า</div>' +
      '<div class="card" style="padding:24px 22px;display:flex;flex-direction:column;gap:18px">' +
      '<div><div class="mono" style="font-size:9.5px;letter-spacing:.26em;color:var(--accent)">' + esc((ev() || {}).short || "") + "</div>" +
      '<div class="serif" style="font-size:25px;font-weight:200;line-height:1.2;margin-top:11px">กรอกข้อมูล<br>เพื่อรับ QR</div></div>' +
      preview +
      '<div class="btn-gold" style="padding:14px 0">ยืนยันการลงทะเบียน</div></div></div></div>';
  }

  // ---------------------------------------------------------------------
  function renderBadge() {
    var e = ev() || {};
    var cfg = state.badgeCfg[state.eventId] || { size: "A6", logo: true, org: true, type: true, qr: true, bar: true };
    var th = theme();

    var sizes = ["A6", "4x6in", "80mm"].map(function (s) {
      return '<div class="pill' + (cfg.size === s ? " is-active" : "") + '" data-act="badge-size" data-id="' + s + '">' + s + "</div>";
    }).join("");

    var toggles = [["logo", "ชื่องานและเส้นแบรนด์"], ["org", "บริษัท / องค์กร"], ["type", "ประเภทบัตร"], ["qr", "QR และรหัสบัตร"], ["bar", "แถบสีท้ายบัตร"]]
      .map(function (t) {
        return '<div class="toggle-row" data-act="badge-toggle" data-id="' + t[0] + '">' +
          '<div class="track' + (cfg[t[0]] ? " is-on" : "") + '"><div class="knob"></div></div>' +
          '<div class="toggle-label">' + esc(t[1]) + "</div></div>";
      }).join("");

    var themeCards = Object.keys(THEMES).map(function (k) {
      var t = THEMES[k];
      return '<div class="theme-card' + (e.theme === k ? " is-active" : "") + '" data-act="set-theme" data-id="' + k + '">' +
        '<div class="sw"><div style="background:' + t.paper + '"></div><div style="background:' + t.accent + '"></div>' +
        '<div style="background:' + t.ink + '"></div></div>' +
        '<div class="theme-name">' + esc(t.label) + "</div></div>";
    }).join("");

    var bp = '<div class="badge-preview" style="background:' + th.paper + ";color:" + th.ink + '">' +
      '<div class="bp-top" style="background:' + th.accent + '"><div></div></div>' +
      (cfg.logo ? '<div class="bp-event"><div style="width:1px;height:14px;background:' + th.accent + '"></div>' +
        '<span style="color:' + th.accent + '">' + esc(e.short || e.name || "") + "</span></div>" : "") +
      '<div class="bp-body"><div class="bp-label" style="opacity:.55">ATTENDEE</div>' +
      '<div class="bp-name">ณัฐพงษ์<br>สุวรรณเลิศ</div>' +
      (cfg.org ? '<div class="bp-org" style="opacity:.6">บริษัท คอร์ปเทค จำกัด</div>' : "") +
      (cfg.type ? '<div class="bp-type" style="border:1px solid ' + th.accent + ";color:" + th.accent + '">GENERAL</div>' : "") +
      "</div>" +
      (cfg.qr ? '<div class="bp-foot" style="background:' + th.ink + ";color:" + th.paper + '">' +
        '<div class="bp-qr" id="badge-qr" style="background:' + th.paper + ";color:" + th.ink + '"></div>' +
        '<div class="bp-lines">TT-4F2A-901<br>' + esc((e.place || "").toUpperCase()) + "<br>" + esc(e.date || "") + "</div></div>" : "") +
      (cfg.bar ? '<div class="bp-bar" style="background:' + th.accent + '"></div>' : "") +
      "</div>";

    return '<div class="split"><div class="split-main">' +
      '<div><div class="page-title">รูปแบบการพิมพ์บัตรเข้างาน</div>' +
      '<div class="page-sub">เลือกขนาด องค์ประกอบ และธีมสี ตั้งค่าแยกได้ทุกงาน</div></div>' +
      '<div class="card" style="padding:20px 22px;display:flex;flex-direction:column;gap:18px">' +
      '<div style="display:flex;flex-direction:column;gap:10px"><div class="side-kicker">ขนาดบัตร</div>' +
      '<div class="pills">' + sizes + "</div></div>" +
      '<div style="height:1px;background:var(--line-soft)"></div>' +
      '<div style="display:flex;flex-direction:column;gap:10px"><div class="side-kicker">องค์ประกอบที่พิมพ์</div>' + toggles + "</div>" +
      '<div style="height:1px;background:var(--line-soft)"></div>' +
      '<div style="display:flex;flex-direction:column;gap:11px">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline"><div class="side-kicker">ธีมสีของงานนี้</div>' +
      '<div class="mono" style="font-size:9.5px;color:var(--accent)">' + esc(th.label) + "</div></div>" +
      '<div class="pills">' + themeCards + "</div></div></div>" +
      (can("ADMIN") ? '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<button class="btn-gold" data-act="badge-save">บันทึกค่าบัตรของงานนี้</button></div>' : '<div class="muted">ต้องเป็น ADMIN จึงจะบันทึกได้</div>') +
      "</div>" +
      '<div class="split-side" style="width:auto;align-items:center">' +
      '<div class="side-kicker">' + esc(cfg.size) + " · พรีวิวตามสัดส่วนงานพิมพ์จริง</div>" + bp + "</div></div>";
  }

  // ---------------------------------------------------------------------
  function renderTeam() {
    var rows = state.team.map(function (m) {
      return '<div class="trow"><div class="avatar">' + esc((m.name || "?").slice(0, 1)) + "</div>" +
        '<div class="c-grow1"><div class="cell-name">' + esc(m.name) + "</div>" +
        '<div class="cell-sub">' + esc(m.email) + "</div>" +
        '<div class="cell-mono">' + esc(m.gate || "") + "</div></div>" +
        '<button class="mini" data-act="cycle-role" data-id="' + esc(m.email) + '" data-role="' + esc(m.role) + '">' + esc(m.role) + "</button>" +
        (can("ADMIN") ? '<button class="mini" data-act="set-pw" data-id="' + esc(m.email) + '">' +
          (m.hasPassword ? "เปลี่ยนรหัส" : "ตั้งรหัส") + "</button>" : "") +
        '<div class="cell-sub" style="width:130px">' + esc(m.scope) + "</div></div>";
    }).join("");

    var scopePills = ['ALL'].concat(state.events.map(function (e) { return e.id; })).map(function (s) {
      return '<div class="pill' + (state.invite.scope === s ? " is-active" : "") + '" data-act="invite-scope" data-id="' + esc(s) + '">' + esc(s === 'ALL' ? 'ทุกงาน' : s) + "</div>";
    }).join("");
    var rolePills = ['STAFF', 'ADMIN'].map(function (r) {
      return '<div class="pill' + (state.invite.role === r ? " is-active" : "") + '" data-act="invite-role" data-id="' + esc(r) + '">' + esc(r) + "</div>";
    }).join("");

    var invite = state.showInvite ? '<div class="walkin">' +
      '<div class="modal-head"><div class="modal-title">' +
      (state.invite.withPw ? "เพิ่มเจ้าหน้าที่ด้วยอีเมล + รหัสผ่าน" : "เชิญเจ้าหน้าที่ด้วยอีเมล Google") + "</div>" +
      '<div class="modal-close" data-act="toggle-invite">ปิด ✕</div></div>' +
      '<div class="pills"><div class="pill' + (state.invite.withPw ? "" : " is-active") + '" data-act="invite-kind" data-id="google">บัญชี Google</div>' +
      '<div class="pill' + (state.invite.withPw ? " is-active" : "") + '" data-act="invite-kind" data-id="password">อีเมล + รหัสผ่าน</div></div>' +
      '<div class="field-row">' +
      '<div class="field"><div class="field-label">อีเมล *</div><input id="inv-email" value="' + esc(state.invite.email) + '" placeholder="' + (state.invite.withPw ? "name@company.com" : "name@gmail.com") + '" /></div>' +
      '<div class="field"><div class="field-label">ชื่อแสดงผล</div><input id="inv-name" value="' + esc(state.invite.name) + '" placeholder="ไม่ใส่ก็ได้" /></div>' +
      '<div class="field"><div class="field-label">ประตู/จุดประจำ</div><input id="inv-gate" value="' + esc(state.invite.gate) + '" placeholder="เช่น ประตู A" /></div>' +
      (state.invite.withPw
        ? '<div class="field"><div class="field-label">รหัสผ่าน * (อย่างน้อย 8 ตัว)</div>' +
          '<input id="inv-pass" type="password" autocomplete="new-password" placeholder="ตั้งรหัสผ่านให้คนนี้" /></div>'
        : "") +
      "</div>" +
      '<div><div class="side-kicker" style="margin-bottom:9px">บทบาท</div><div class="pills">' + rolePills + "</div></div>" +
      '<div><div class="side-kicker" style="margin-bottom:9px">ขอบเขตงานที่เห็น</div><div class="pills">' + scopePills + "</div></div>" +
      '<div class="err">' + esc(state.invite.error) + "</div>" +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">' +
      '<button class="btn-light" data-act="save-invite">เพิ่มเข้าทีม</button>' +
      '<div class="muted">' + (state.invite.withPw
        ? "คนนี้เข้าใช้งานได้ทันทีด้วยอีเมลและรหัสผ่านนี้ ไม่ต้องมีบัญชี Google · ระบบเก็บเฉพาะค่าที่ผ่านการแฮชแล้ว ถ้าลืมต้องตั้งใหม่"
        : "คนนั้นต้องล็อกอินด้วยอีเมลนี้เป๊ะๆ ถึงจะเข้าได้ — แค่เพิ่มชื่อยังไม่ได้ตรวจสอบว่าอีเมลมีจริง") +
      "</div></div></div>" : "";

    return '<div class="page" style="max-width:820px">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:14px;flex-wrap:wrap">' +
      '<div><div class="page-title">ทีมงานและสิทธิ์การเข้าถึง</div>' +
      '<div class="page-sub">เจ้าหน้าที่เข้าใช้งานด้วยบัญชี Google ของตนเอง · แก้ไขรายชื่อได้ในไฟล์ Team Access</div></div>' +
      (can("ADMIN") ? '<button class="btn-gold" data-act="toggle-invite">+ เพิ่มเจ้าหน้าที่</button>' : "") +
      "</div>" +
      invite +
      '<div class="card">' + (rows || '<div class="empty">ยังไม่มีทีมงาน</div>') + "</div>" +
      '<div class="card" style="padding:20px 22px;display:flex;flex-direction:column;gap:11px">' +
      '<div class="side-kicker">สิทธิ์แต่ละบทบาท</div>' +
      '<div class="row-line"><span style="color:var(--accent);font-size:12px">ADMIN</span><span class="muted" style="margin-left:auto">ทุกอย่าง · เปลี่ยนประเภทบัตร ดูอีเมล/เบอร์ export CSV จัดการฟิลด์ บัตร ทีม และลบข้อมูล</span></div>' +
      '<div class="row-line"><span style="color:var(--accent);font-size:12px">STAFF</span><span class="muted" style="margin-left:auto">สแกน เช็คอิน Walk-in ดูรายชื่อ · ไม่เห็นอีเมล/เบอร์ ไม่เปลี่ยนประเภทบัตรได้</span></div>' +
      "</div></div>";
  }

  function renderNewEvent() {
    var themes = Object.keys(THEMES).map(function (k) {
      var t = THEMES[k];
      return '<div class="theme-card' + (state.ne.theme === k ? " is-active" : "") + '" data-act="ne-theme" data-id="' + k + '">' +
        '<div class="sw"><div style="background:' + t.paper + '"></div><div style="background:' + t.accent + '"></div></div>' +
        '<div class="theme-name">' + esc(t.label) + "</div></div>";
    }).join("");
    return '<div class="modal"><div class="modal-card">' +
      '<div class="modal-head"><div class="modal-title">สร้างงานใหม่</div>' +
      '<div class="modal-close" data-act="new-event">ปิด ✕</div></div>' +
      '<div class="field"><div class="field-label">ชื่องาน *</div><input id="ne-name" value="' + esc(state.ne.name) + '" placeholder="เช่น Tech Meetup 2027" /></div>' +
      '<div class="field-row">' +
      '<div class="field"><div class="field-label">วันที่จัด</div><input id="ne-date" value="' + esc(state.ne.date) + '" placeholder="15 มี.ค. 70" /></div>' +
      '<div class="field"><div class="field-label">สถานที่</div><input id="ne-place" value="' + esc(state.ne.place) + '" placeholder="ไอคอนสยาม" /></div></div>' +
      '<div><div class="side-kicker" style="margin-bottom:9px">ธีมสีของงาน</div><div class="pills">' + themes + "</div></div>" +
      '<div class="err">' + esc(state.ne.error) + "</div>" +
      '<button class="btn-gold" data-act="ne-create" style="padding:15px 0">สร้างงานและตั้งฟิลด์ฟอร์ม</button>' +
      '<div class="muted">งานใหม่จะได้ฟิลด์เริ่มต้น 3 ช่อง (ชื่อ อีเมล เบอร์โทร) โดยอัตโนมัติ</div>' +
      "</div></div>";
  }

  function qrSvg(payload) {
    if (!window.qrcode) return "";
    var qr = window.qrcode(0, "M");
    qr.addData(String(payload));
    qr.make();
    var n = qr.getModuleCount(), d = "";
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) d += "M" + c + "," + r + "h1v1h-1Z";
    return '<svg viewBox="-2 -2 ' + (n + 4) + " " + (n + 4) + '" width="100%" height="100%" shape-rendering="crispEdges" style="display:block"><path d="' + d + '" fill="currentColor"/></svg>';
  }

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------
  function bind() {
    app.querySelectorAll("[data-act]").forEach(function (el) {
      el.addEventListener("click", function () { act(el.dataset.act, el); });
    });
    var q = document.getElementById("q");
    if (q) {
      q.focus();
      var t = null;
      q.addEventListener("input", function (e) {
        state.query = e.target.value;
        clearTimeout(t);
        t = setTimeout(function () {
          api("attendees", { eventId: state.eventId, query: state.query })
            .then(function (d) { state.rows = d; render(); }).catch(fail);
        }, 260);
      });
    }
    bindInput("w-name", state.walkin, "name");
    bindInput("w-email", state.walkin, "email");
    bindInput("w-phone", state.walkin, "phone");
    bindInput("ne-name", state.ne, "name");
    bindInput("ne-date", state.ne, "date");
    bindInput("ne-place", state.ne, "place");
    bindInput("es-name", state.es, "name");
    bindInput("es-date", state.es, "date");
    bindInput("es-place", state.es, "place");
    bindInput("es-doors", state.es, "doors");
    bindInput("es-price", state.es, "price");
    bindInput("es-org-name", state.es, "organizerName");
    bindInput("es-org-contact", state.es, "organizerContact");

    var bf = document.getElementById("banner-file");
    if (bf) bf.addEventListener("change", function (e2) {
      var f = e2.target.files && e2.target.files[0];
      if (f) uploadBanner(f);
    });
    bindInput("inv-email", state.invite, "email");
    bindInput("inv-name", state.invite, "name");
    bindInput("inv-gate", state.invite, "gate");
    var nf = document.getElementById("new-field");
    if (nf) nf.addEventListener("input", function (e) { state.newField = e.target.value; });

    var bq = document.getElementById("badge-qr");
    if (bq) bq.innerHTML = qrSvg("PREVIEW|TT-4F2A-901");
  }

  function bindInput(id, obj, key) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("input", function (e) { obj[key] = e.target.value; });
  }

  function act(a, el) {
    switch (a) {
      case "reload": location.reload(); break;
      case "sign-out": signOut(); break;
      case "password-login": passwordLogin(); break;
      case "set-pw": state.pwFor = el.dataset.id; state.pwValue = ""; state.pwError = ""; render(); break;
      case "my-pw":
        state.pwFor = state.me && state.me.email;
        state.pwValue = ""; state.pwError = "";
        render();
        break;
      case "close-pw": state.pwFor = null; render(); break;
      case "save-pw": savePassword(false); break;
      case "clear-pw": savePassword(true); break;
      case "nav": go(el.dataset.id); break;
      case "pick-event":
        state.eventId = el.dataset.id;
        state.rows = []; state.dash = null;
        render(); loadScreen();
        break;
      case "refresh": loadScreen(); flash("อัปเดตแล้ว"); break;
      case "toggle-pdpa": {
        var wantPdpa = el.dataset.on === "1";
        api("setEventProp", { eventId: state.eventId, pdpa: wantPdpa }).then(function () {
          var found = state.events.filter(function (x) { return x.id === state.eventId; })[0];
          if (found) found.pdpa = wantPdpa;
          flash(wantPdpa ? "เปิดข้อความยินยอม PDPA แล้ว" : "ปิดข้อความยินยอม PDPA แล้ว");
          render();
        }).catch(fail);
        break;
      }
      case "toggle-hidden": {
        var willHide = el.dataset.hidden === "1";
        api("setEventProp", { eventId: el.dataset.id, hidden: willHide }).then(function () {
          var found = state.events.filter(function (x) { return x.id === el.dataset.id; })[0];
          if (found) found.hidden = willHide;
          flash(willHide ? "ซ่อนจากหน้าลูกค้าแล้ว — ข้อมูลเดิมยังอยู่ครบ" : "แสดงให้ลูกค้าเห็นอีกครั้งแล้ว");
          render();
        }).catch(fail);
        break;
      }
      case "export": doExport(); break;
      case "toggle-walkin": state.showWalkin = !state.showWalkin; render(); break;
      case "walkin-type": state.walkin.type = el.dataset.id; render(); break;
      case "cycle-type": {
        var cur = el.dataset.type;
        var next = PASS_TYPES[(PASS_TYPES.indexOf(cur) + 1) % PASS_TYPES.length];
        api("setType", { eventId: state.eventId, regId: el.dataset.id, type: next })
          .then(function () { flash("เปลี่ยนเป็น " + next); loadScreen(); }).catch(fail);
        break;
      }
      case "save-walkin": saveWalkin(); break;
      case "toggle-invite": state.showInvite = !state.showInvite; state.invite.error = ""; render(); break;
      case "invite-role": state.invite.role = el.dataset.id; render(); break;
      case "invite-kind": state.invite.withPw = el.dataset.id === "password"; state.invite.error = ""; render(); break;
      case "invite-scope": state.invite.scope = el.dataset.id; render(); break;
      case "save-invite": saveInvite(); break;
      case "toggle-in": {
        var on = el.dataset.on === "1";
        api("setCheckedIn", { eventId: state.eventId, regId: el.dataset.id, on: on })
          .then(function () { flash(on ? "เช็คอินแล้ว" : "ยกเลิกเช็คอินแล้ว"); loadScreen(); }).catch(fail);
        break;
      }
      case "del":
        if (!confirm('ลบ "' + el.dataset.name + '" ออกจากงานนี้?')) return;
        api("deleteAttendee", { eventId: state.eventId, regId: el.dataset.id })
          .then(function () { flash("ลบแล้ว"); loadScreen(); }).catch(fail);
        break;
      case "hist": state.histFilter = el.dataset.id; loadScreen(); break;
      case "field-req": state.fields[+el.dataset.i].required = !state.fields[+el.dataset.i].required; render(); break;
      case "field-del": state.fields.splice(+el.dataset.i, 1); render(); break;
      case "field-add": {
        var label = (document.getElementById("new-field") || {}).value || state.newField;
        if (!label.trim()) { flash("พิมพ์ชื่อฟิลด์ก่อน"); return; }
        state.fields.push({ key: "f" + Date.now().toString(36).slice(-4), label: label.trim(), type: "TEXT", required: false });
        state.newField = "";
        render();
        break;
      }
      case "fields-save":
        api("saveFields", { eventId: state.eventId, fields: state.fields })
          .then(function () { flash("บันทึกฟิลด์ลง Google Sheet แล้ว"); }).catch(fail);
        break;
      case "badge-size": setBadge({ size: el.dataset.id }); break;
      case "badge-toggle": {
        var cfg = state.badgeCfg[state.eventId] || {};
        var patch = {}; patch[el.dataset.id] = !cfg[el.dataset.id];
        setBadge(patch);
        break;
      }
      case "badge-save": {
        var c = state.badgeCfg[state.eventId] || {};
        api("saveBadgeConfig", {
          eventId: state.eventId, size: c.size || "A6",
          logo: !!c.logo, org: !!c.org, type: !!c.type, qr: !!c.qr, bar: !!c.bar
        }).then(function () { flash("บันทึกค่าบัตรแล้ว"); }).catch(fail);
        break;
      }
      case "set-theme":
        api("setEventProp", { eventId: state.eventId, theme: el.dataset.id }).then(function () {
          var e = ev(); if (e) { e.theme = el.dataset.id; e.accent = THEMES[el.dataset.id].accent; }
          flash("เปลี่ยนธีมแล้ว"); render();
        }).catch(fail);
        break;
      case "new-event":
        state.showNewEvent = !state.showNewEvent;
        state.ne.error = "";
        render();
        break;
      case "ne-theme": state.ne.theme = el.dataset.id; render(); break;
      case "ne-create": createEvent(); break;
      case "cycle-role": {
        var order = ["STAFF", "ADMIN"];
        var next = order[(order.indexOf(el.dataset.role) + 1) % order.length];
        api("setRole", { email: el.dataset.id, role: next })
          .then(function () { flash("เปลี่ยนเป็น " + next); loadScreen(); })
          .catch(function (e) {
            if (String(e.message).indexOf("cannot_change_own_role") >= 0) flash("เปลี่ยนบทบาทของตัวเองไม่ได้");
            else fail(e);
          });
        break;
      }
      case "print-badge":
        window.open(printUrl(el.dataset.id), "_blank");
        break;
      case "banner-pick": {
        var picker = document.getElementById("banner-file");
        if (picker) picker.click();
        break;
      }
      case "toggle-open": {
        var wantOpen = el.dataset.on === "1";
        api("setEventProp", { eventId: state.eventId, open: wantOpen }).then(function () {
          var cur = ev(); if (cur) cur.open = wantOpen;
          flash(wantOpen ? "เปิดรับลงทะเบียนแล้ว" : "ปิดรับลงทะเบียนแล้ว");
          render();
        }).catch(fail);
        break;
      }
      case "toggle-price": {
        var wantPrice = el.dataset.on === "1";
        // Off writes an empty string — the customer site skips a fact row whose
        // value is blank, so there is no separate "show price" column to keep
        // in step with the text itself.
        var text = wantPrice ? (state.es.price || "ไม่มีค่าใช้จ่าย") : "";
        api("setEventProp", { eventId: state.eventId, price: text }).then(function () {
          var cur = ev(); if (cur) cur.price = text;
          state.es.price = text;
          render();
        }).catch(fail);
        break;
      }
      case "event-save": saveEventSettings(); break;
    }
  }

  function setBadge(patch) {
    var cur = state.badgeCfg[state.eventId] || { size: "A6", logo: true, org: true, type: true, qr: true, bar: true };
    state.badgeCfg[state.eventId] = Object.assign({}, cur, patch);
    render();
  }

  // Where this very file was served from — which is also where badge.html
  // sits. The Apps Script shell (Staff.html) loads staff.js cross-origin from
  // Vercel, so a relative link would resolve against googleusercontent.com
  // and 404; taking the base from our own <script src> works from either host.
  var SELF_BASE = (function () {
    var el = document.currentScript;
    if (!el) {
      var all = document.getElementsByTagName("script");
      for (var i = all.length - 1; i >= 0; i--) {
        if (all[i].src && all[i].src.indexOf("staff.js") >= 0) { el = all[i]; break; }
      }
    }
    return el && el.src ? el.src.replace(/\/staff\.js(\?.*)?$/, "") : "./staff";
  })();

  function printUrl(regId) {
    // Served from this app, not Apps Script. The Apps-Script-hosted Badge.html
    // identified the caller with Session.getActiveUser(), which is blank for
    // anyone but the script owner under executeAs: USER_DEPLOYING — so every
    // staff member got no_identity instead of a badge. This page is on our own
    // origin, so it reuses the ID token already in localStorage.
    return SELF_BASE + "/badge.html?eventId=" + encodeURIComponent(state.eventId) +
      "&regId=" + encodeURIComponent(regId);
  }

  function saveWalkin() {
    var w = state.walkin;
    if (!w.name.trim()) { flash("กรอกชื่อก่อน"); return; }
    api("addWalkin", {
      eventId: state.eventId, name: w.name.trim(), email: w.email.trim(),
      phone: w.phone.trim(), type: w.type
    }).then(function (r) {
      state.walkin = { name: "", email: "", phone: "", type: "ทั่วไป" };
      state.showWalkin = false;
      flash("เพิ่มและเช็คอินแล้ว · " + r.badgeCode);
      loadScreen();
    }).catch(fail);
  }

  function saveInvite() {
    var inv = state.invite;
    if (!inv.email.trim()) { state.invite.error = "กรอกอีเมลก่อน"; render(); return; }
    var pw = inv.withPw ? ((document.getElementById("inv-pass") || {}).value || "") : "";
    if (inv.withPw && pw.length < 8) {
      state.invite.error = "รหัสผ่านต้องยาวอย่างน้อย 8 ตัว";
      render();
      return;
    }
    // The row and its password go in one call: as two, a failure between them
    // leaves somebody on the team who cannot sign in, and an admin who was
    // told they could.
    api("addTeamMember", {
      email: inv.email.trim(), name: inv.name.trim(), role: inv.role,
      scope: inv.scope, gate: inv.gate.trim(), password: pw
    }).then(function (r) {
      state.invite = { email: "", name: "", role: "STAFF", scope: "ALL", gate: "", error: "", withPw: false };
      state.showInvite = false;
      flash(r.hasPassword
        ? "เพิ่ม " + r.email + " แล้ว เข้าใช้งานได้ทันทีด้วยรหัสผ่านที่ตั้งไว้"
        : "เพิ่ม " + r.email + " เป็น " + r.role + " แล้ว");
      loadScreen();
    }).catch(function (e) {
      var m = String(e.message || e);
      state.invite.error = m.indexOf("already_exists") >= 0 ? "อีเมลนี้อยู่ในทีมแล้ว" :
        m.indexOf("invalid_email") >= 0 ? "รูปแบบอีเมลไม่ถูกต้อง" :
        m.indexOf("password_too_short") >= 0 ? "รหัสผ่านต้องยาวอย่างน้อย 8 ตัว" : m;
      render();
    });
  }

  function saveEventSettings() {
    var es = state.es;
    if (!es.name.trim()) { es.error = "กรุณากรอกชื่องาน"; render(); return; }
    es.error = "";
    // The price switch (toggle-price) writes state.es.price only as a side
    // effect of the api() call succeeding — it does not touch what the user
    // may have typed into the price text box in the meantime. Without this,
    // pressing บันทึกการตั้งค่า after editing the price text would silently
    // discard that edit: the same class of silent no-op this project exists
    // to remove.
    var cur0 = ev() || {};
    var priceOn = !!(cur0.price && String(cur0.price).trim());
    api("setEventProp", {
      eventId: state.eventId,
      name: es.name.trim(),
      date: es.date.trim(),
      place: es.place.trim(),
      doors: es.doors.trim(),
      organizerName: es.organizerName.trim(),
      organizerContact: es.organizerContact.trim(),
      price: priceOn ? es.price.trim() : ''
    }).then(function () {
      var cur = ev();
      if (cur) {
        cur.name = es.name.trim(); cur.date = es.date.trim(); cur.place = es.place.trim();
        cur.doors = es.doors.trim();
        cur.organizerName = es.organizerName.trim();
        cur.organizerContact = es.organizerContact.trim();
        cur.price = priceOn ? es.price.trim() : '';
      }
      flash("บันทึกแล้ว");
      render();
    }).catch(function (e2) { es.error = String(e2.message || e2); render(); });
  }

  var BANNER_SRC_MAX = 12 * 1024 * 1024;   // reject before we even try to decode
  var BANNER_OUT_MAX = 1500000;            // must match BANNER_MAX_BYTES in Code.gs
  var BANNER_MAX_W = 1600;

  // Resizing happens here, not on the server. A phone photo is 3-5 MB and grows
  // by a third again in base64; sending that through an Apps Script body is a
  // risk taken for nothing, and a 5 MB hero is the page-load problem this
  // project already had once. 1600px is wider than the hero ever renders.
  function uploadBanner(file) {
    var es = state.es;
    if (file.size > BANNER_SRC_MAX) {
      es.error = "ไฟล์ใหญ่เกินไป (เกิน 12 MB) กรุณาย่อก่อนอัพโหลด";
      render(); return;
    }
    es.error = ""; es.busy = true; render();

    var reader = new FileReader();
    reader.onerror = function () { es.busy = false; es.error = "อ่านไฟล์ไม่สำเร็จ"; render(); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { es.busy = false; es.error = "ไฟล์นี้ไม่ใช่รูปภาพที่เปิดได้"; render(); };
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        if (w > BANNER_MAX_W) { h = Math.round(h * BANNER_MAX_W / w); w = BANNER_MAX_W; }
        var canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        var dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        var b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        // base64 carries 3 bytes per 4 characters; padding makes this an
        // over-estimate by at most two bytes, which is the safe direction.
        if (b64.length * 3 / 4 > BANNER_OUT_MAX) {
          es.busy = false;
          es.error = "ย่อแล้วยังใหญ่เกิน 1.5 MB กรุณาใช้ภาพอื่น";
          render(); return;
        }
        api("uploadBanner", { eventId: state.eventId, dataB64: b64, mimeType: "image/jpeg" })
          .then(function (r) {
            var cur = ev(); if (cur) cur.image = r.url;
            es.busy = false;
            flash("อัพโหลดภาพแล้ว");
            render();
          })
          .catch(function (e2) {
            es.busy = false;
            var m = String(e2.message || e2);
            es.error =
              m.indexOf("image_too_large") >= 0 ? "ไฟล์ใหญ่เกินไป" :
              m.indexOf("bad_image_type") >= 0 ? "รองรับเฉพาะ JPG PNG และ WebP" :
              m.indexOf("bad_image_data") >= 0 ? "ข้อมูลภาพเสียหาย" : m;
            render();
          });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function createEvent() {
    if (!state.ne.name.trim()) { state.ne.error = "กรุณากรอกชื่องาน"; render(); return; }
    api("createEvent", {
      name: state.ne.name.trim(), date: state.ne.date.trim(), place: state.ne.place.trim(), theme: state.ne.theme
    }).then(function (r) {
      state.showNewEvent = false;
      state.ne = { name: "", date: "", place: "", theme: "editorial", error: "" };
      return api("bootstrap").then(function (d) {
        state.events = d.events || [];
        state.badgeCfg = d.badge || {};
        state.eventId = r.id;
        state.screen = "event";
        render();
        loadScreen();
        flash("สร้างงาน " + r.name + " แล้ว");
      });
    }).catch(function (e) { state.ne.error = String(e.message || e); render(); });
  }

  function doExport() {
    api("csv", { eventId: state.eventId }).then(function (csv) {
      var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = state.eventId + "-registrations.csv";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      flash("ดาวน์โหลด CSV แล้ว");
    }).catch(fail);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
