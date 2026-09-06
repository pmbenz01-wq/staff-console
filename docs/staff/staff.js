(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Transport. Inside Apps Script we talk to svc() over google.script.run —
  // same origin, so the Google session travels with it and there is no CORS.
  // window.STAFF_DEV_API is only set by the local dev harness used for tests.
  // ---------------------------------------------------------------------
  function callSvc(action, payload) {
    if (window.google && window.google.script && window.google.script.run) {
      return new Promise(function (resolve, reject) {
        window.google.script.run
          .withSuccessHandler(resolve)
          .withFailureHandler(function (e) { reject(new Error(e && e.message ? e.message : String(e))); })
          .svc(action, payload || {});
      });
    }
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
    { id: "scan", label: "สแกน QR เข้างาน" },
    { id: "list", label: "ผู้ลงทะเบียน", count: true },
    { id: "history", label: "ประวัติย้อนหลัง" },
    { id: "fields", label: "ฟิลด์ฟอร์ม" },
    { id: "badge", label: "บัตรเข้างาน" },
    { id: "team", label: "ทีมและสิทธิ์" }
  ];

  var state = {
    phase: "loading",       // loading | error | ready
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
    scanResult: null,
    recentScans: [],
    showWalkin: false,
    showNewEvent: false,
    ne: { name: "", date: "", place: "", theme: "editorial", error: "" },
    walkin: { name: "", email: "", phone: "", type: "ทั่วไป" },
    newField: "",
    toast: "",
    busy: false
  };

  var app, toastTimer = null, camNode = null, scanning = false, lastCode = "", lastCodeAt = 0;

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
    var rank = { VIEWER: 1, STAFF: 2, ADMIN: 3 };
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
  // Boot
  // ---------------------------------------------------------------------
  function boot() {
    app = document.getElementById("app");
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
      state.phase = "error";
      state.fatal = String(e && e.message || e);
      render();
    });
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
    } else if (s === "team") {
      api("team").then(function (d) { state.team = d; render(); }).catch(fail);
    }
  }

  function go(screen) {
    if (screen === state.screen) return;
    if (state.screen === "scan") stopCamera();
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
    if (state.phase === "loading") html = renderBoot();
    else if (state.phase === "error") html = renderFatal();
    else html = renderShell();
    if (state.toast) html += '<div class="toast">' + esc(state.toast) + "</div>";
    app.innerHTML = html;
    bind();
    if (state.phase === "ready" && state.screen === "scan") mountCamera();
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
        "เพิ่มแถวใหม่: อีเมลนี้, ชื่อ, บทบาท (ADMIN / STAFF / VIEWER), ขอบเขต (<code>ALL</code> หรือรหัสงาน), ประตู</p>";
    } else if (f.indexOf("team_access_not_configured") >= 0) {
      body = "<p>ยังไม่ได้สร้างไฟล์สิทธิ์ทีมงาน</p><p><b>วิธีแก้:</b> ใน Apps Script เลือกฟังก์ชัน " +
        "<code>setupTeamAccessSheet</code> แล้วกด Run หนึ่งครั้ง</p>";
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
    var evs = state.events.map(function (e) {
      return '<div class="ev' + (e.id === state.eventId ? " is-active" : "") + '" data-act="pick-event" data-id="' + esc(e.id) + '">' +
        '<div class="ev-name">' + esc(e.name) + "</div>" +
        '<div class="ev-meta">' + esc(e.date || "") + "</div></div>";
    }).join("");

    var nav = NAV.map(function (n) {
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
      '<div class="side-me-role">' + esc(me.role || "") + " · " + esc(me.gate || "") + "</div></div></div></div>";
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
      '<button class="btn-ghost" data-act="export">EXPORT CSV</button>' +
      "</div></div>";
  }

  function renderPage() {
    switch (state.screen) {
      case "dash": return renderDash();
      case "scan": return renderScan();
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
  function renderScan() {
    var r = state.scanResult;
    var card;
    if (!r) {
      card = '<div class="card empty">ยังไม่มีการสแกนในเครื่องนี้ · เล็ง QR ของผู้เข้าร่วมเข้ากล้อง หรือพิมพ์รหัสบัตรด้านล่าง</div>';
    } else {
      var cls = r.result === "ok" ? "is-ok" : r.result === "duplicate" ? "is-dup" : "is-bad";
      var status = r.result === "ok" ? "เช็คอินสำเร็จ" :
        r.result === "duplicate" ? "สแกนซ้ำ — เข้างานไปแล้ว" :
        r.result === "wrong_event" ? "บัตรของงานอื่น" :
        r.result === "bad_signature" ? "QR ไม่ถูกต้อง" : "ไม่พบรหัสนี้";
      var by = r.result === "duplicate"
        ? "เช็คอินครั้งแรกโดย " + (r.firstBy || "—") + " · " + (r.firstAt ? new Date(r.firstAt).toLocaleString("th-TH") : "—") + (r.firstGate ? " · " + r.firstGate : "")
        : r.result === "ok" ? "โดย " + (r.by || "") + " · " + (r.gate || "") : "";
      card = '<div class="result-card ' + cls + '"><div style="min-width:200px;flex:1">' +
        '<div class="result-status">' + esc(status) + "</div>" +
        '<div class="result-name">' + esc(r.name || r.badgeCode || "—") + "</div>" +
        '<div class="result-sub">' + esc([r.org, r.type].filter(Boolean).join(" · ")) + "</div>" +
        '<div class="result-by">' + esc(by) + "</div>" +
        (r.regId ? '<div style="display:flex;gap:9px;margin-top:18px">' +
          '<button class="btn-light" data-act="print-badge" data-id="' + esc(r.regId) + '">พิมพ์บัตร A6</button></div>' : "") +
        "</div>" +
        (r.badgeCode ? '<div class="result-qr" id="scan-qr"></div>' : "") +
        "</div>";
    }

    var recent = state.recentScans.length ? '<div class="card">' + state.recentScans.map(function (s) {
      return '<div class="trow"><div class="feed-time" style="width:46px">' + esc(s.time) + "</div>" +
        '<div class="c-grow1"><div class="cell-name">' + esc(s.name || "—") + "</div>" +
        '<div class="cell-mono">' + esc(s.code || "") + "</div></div>" +
        '<div class="tag' + (s.result === "ok" ? " is-in" : "") + '"><div class="tag-label">' + esc(s.result.toUpperCase()) + "</div></div></div>";
    }).join("") + "</div>" : "";

    var e = ev() || {};
    return '<div class="scan-wrap"><div class="phone">' +
      '<div class="side-kicker">มุมมองบนมือถือเจ้าหน้าที่</div>' +
      '<div class="phone-body">' +
      '<div class="phone-status"><span>' + esc(new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })) + "</span><span>SCAN</span></div>" +
      '<div class="phone-head"><div class="phone-title">สแกน QR</div><div class="phone-gate">' + esc((state.me && state.me.gate) || "—") + "</div></div>" +
      '<div id="cam-slot"></div>' +
      '<div class="phone-actions">' +
      '<div class="manual"><input id="manual-code" placeholder="พิมพ์รหัสบัตร เช่น TT-4F2A-901" autocomplete="off" />' +
      '<button class="btn-gold" data-act="manual-checkin">เช็คอิน</button></div>' +
      '<button class="btn-ghost" data-act="nav" data-id="list" style="padding:12px">ค้นหาด้วยชื่อแทน</button>' +
      "</div>" +
      '<div class="phone-foot"><div class="phone-foot-line"><span>' + esc((state.me && state.me.name) || "") + "</span>" +
      '<span style="color:#c9ac74">' + state.recentScans.filter(function (s) { return s.result === "ok"; }).length + " สแกน</span></div>" +
      '<div class="muted">ทุกการสแกนบันทึกชื่อเจ้าหน้าที่คนนี้ลง Google Sheet</div></div>' +
      "</div></div>" +
      '<div class="scan-result"><div class="side-kicker">ผลการสแกนล่าสุด</div>' + card + recent + "</div></div>";
  }

  // ---------------------------------------------------------------------
  function renderList() {
    var rows = state.rows.map(function (r) {
      var isIn = r.status === "checked_in";
      return '<div class="trow">' +
        '<div class="c-grow2"><div class="cell-name">' + esc(r.name) + "</div>" +
        '<div class="cell-sub">' + esc(r.org || "") + (r.source === "walkin" ? " · WALK-IN" : "") + "</div></div>" +
        '<div class="c-grow2"><div class="cell-sub" style="color:#cfc9bd">' + esc(r.email || "") + "</div>" +
        '<div class="cell-mono">' + esc(r.phone || "") + "</div></div>" +
        '<div class="c-code">' + esc(r.code) + "</div>" +
        '<div class="c-type">' +
        (can("STAFF")
          ? '<button class="mini type-btn' + typeClass(r.type) + '" data-act="cycle-type" data-id="' + esc(r.regId) + '" data-type="' + esc(r.type || "") + '" title="กดเพื่อเปลี่ยนประเภทบัตร">' + esc(r.type || "—") + "</button>"
          : '<div class="tag"><div class="tag-label">' + esc(r.type || "—") + "</div></div>") +
        "</div>" +
        '<div class="c-status"><div class="tag' + (isIn ? " is-in" : "") + '"><div class="tag-dot"></div>' +
        '<div class="tag-label">' + (isIn ? "เข้างานแล้ว" : "ลงทะเบียน") + "</div></div>" +
        '<div class="cell-mono">' + esc(isIn ? (r.by || "") : "") + "</div></div>" +
        '<div class="c-actions">' +
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
      '<div class="toolbar"><div class="search"><div class="mono" style="color:#6f6a5f">⌕</div>' +
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
        '<div style="font-size:9.5px;color:#8b8578">' + esc(h.date) + "</div>" +
        '<div style="font-size:9.5px;color:#8b8578">' + esc(h.time) + "</div></div>" +
        '<div class="c-grow2"><div class="cell-name">' + esc(h.name) + "</div>" +
        '<div class="cell-mono">' + esc(h.device || "") + "</div></div>" +
        '<div class="c-code">' + esc(h.code) + "</div>" +
        '<div class="c-grow1"><div class="cell-sub" style="color:#cfc9bd">' + esc(h.by) + "</div>" +
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
  function renderFields() {
    var rows = state.fields.map(function (f, i) {
      return '<div class="trow"><div class="mono" style="width:22px;color:#6f6a5f">' + (i + 1) + "</div>" +
        '<div class="c-grow1"><div class="cell-name">' + esc(f.label) + "</div>" +
        '<div class="cell-mono">' + esc(f.type || "TEXT") + "</div></div>" +
        '<button class="mini" data-act="field-req" data-i="' + i + '">' + (f.required ? "จำเป็น" : "ไม่บังคับ") + "</button>" +
        '<button class="mini is-danger" data-act="field-del" data-i="' + i + '">✕</button></div>';
    }).join("");

    var preview = state.fields.map(function (f) {
      return '<div class="field"><div class="field-label">' + esc(f.label) + (f.required ? " *" : "") + "</div>" +
        '<div style="font:300 14px Anuphan,sans-serif;color:#575349;margin-top:4px">' + esc(f.type === "EMAIL" ? "name@company.com" : f.type === "PHONE" ? "08X XXX XXXX" : "…") + "</div></div>";
    }).join("");

    return '<div class="split"><div class="split-main">' +
      '<div><div class="page-title">ฟิลด์ในฟอร์มลงทะเบียน</div>' +
      '<div class="page-sub">ตั้งค่าแยกตามแต่ละงาน · เพิ่ม ลบ หรือกำหนดว่าฟิลด์ใดจำเป็น แล้วกดบันทึก<br>' +
      '<b style="color:#c9ac74">หมายเหตุ:</b> ตอนนี้บันทึกลงชีตแล้ว แต่หน้าลูกค้ายังใช้ฟอร์ม 5 ขั้นแบบตายตัวอยู่ ' +
      'จะเชื่อมให้ฟอร์มลูกค้าอ่านฟิลด์ชุดนี้จริงในขั้นถัดไป</div></div>' +
      '<div class="card">' + (rows || '<div class="empty">ยังไม่มีฟิลด์</div>') +
      '<div style="padding:16px 20px;display:flex;flex-wrap:wrap;gap:10px;align-items:center">' +
      '<input id="new-field" value="' + esc(state.newField) + '" placeholder="ชื่อฟิลด์ใหม่ เช่น ตำแหน่งงาน" ' +
      'style="flex:1;min-width:170px;background:#17150f;border:1px solid #302c26;outline:none;padding:11px 13px;font:300 12.5px Anuphan,sans-serif" />' +
      '<button class="btn-ghost" data-act="field-add" style="border-color:#c9ac74;color:#c9ac74;padding:11px 16px">+ เพิ่มฟิลด์</button></div></div>' +
      (can("ADMIN") ? '<div><button class="btn-gold" data-act="fields-save">บันทึกฟิลด์ของงานนี้</button></div>' : '<div class="muted">ต้องเป็น ADMIN จึงจะบันทึกได้</div>') +
      "</div>" +
      '<div class="split-side"><div class="side-kicker">พรีวิวหน้าลูกค้า</div>' +
      '<div class="card" style="padding:24px 22px;display:flex;flex-direction:column;gap:18px">' +
      '<div><div class="mono" style="font-size:9.5px;letter-spacing:.26em;color:#c9ac74">' + esc((ev() || {}).short || "") + "</div>" +
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
      '<div style="height:1px;background:#241f1b"></div>' +
      '<div style="display:flex;flex-direction:column;gap:10px"><div class="side-kicker">องค์ประกอบที่พิมพ์</div>' + toggles + "</div>" +
      '<div style="height:1px;background:#241f1b"></div>' +
      '<div style="display:flex;flex-direction:column;gap:11px">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline"><div class="side-kicker">ธีมสีของงานนี้</div>' +
      '<div class="mono" style="font-size:9.5px;color:#c9ac74">' + esc(th.label) + "</div></div>" +
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
        '<div class="cell-sub" style="width:130px">' + esc(m.scope) + "</div></div>";
    }).join("");

    return '<div class="page" style="max-width:820px">' +
      '<div><div class="page-title">ทีมงานและสิทธิ์การเข้าถึง</div>' +
      '<div class="page-sub">เจ้าหน้าที่เข้าใช้งานด้วยบัญชี Google ของตนเอง · แก้ไขรายชื่อได้ในไฟล์ Team Access</div></div>' +
      '<div class="card">' + (rows || '<div class="empty">ยังไม่มีทีมงาน</div>') + "</div>" +
      '<div class="card" style="padding:20px 22px;display:flex;flex-direction:column;gap:11px">' +
      '<div class="side-kicker">สิทธิ์แต่ละบทบาท</div>' +
      '<div class="row-line"><span style="color:#c9ac74;font-size:12px">ADMIN</span><span class="muted" style="margin-left:auto">ทุกอย่าง · จัดการฟิลด์ บัตร ทีม และลบข้อมูล</span></div>' +
      '<div class="row-line"><span style="color:#c9ac74;font-size:12px">STAFF</span><span class="muted" style="margin-left:auto">สแกน เช็คอิน Walk-in</span></div>' +
      '<div class="row-line"><span style="color:#c9ac74;font-size:12px">VIEWER</span><span class="muted" style="margin-left:auto">ดูอย่างเดียว</span></div>' +
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

  // ---------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------
  function mountCamera() {
    var slot = document.getElementById("cam-slot");
    if (!slot) return;
    if (!camNode) {
      camNode = document.createElement("div");
      camNode.className = "cam-wrap";
      camNode.innerHTML =
        '<video id="cam-video" playsinline muted></video><canvas id="cam-canvas" hidden></canvas>' +
        '<div class="cam-corner tl"></div><div class="cam-corner tr"></div>' +
        '<div class="cam-corner bl"></div><div class="cam-corner br"></div>' +
        '<div class="cam-line"></div><div class="cam-hint" id="cam-hint">กำลังเปิดกล้อง…</div>';
    }
    slot.appendChild(camNode);
    startCamera();
  }

  function startCamera() {
    if (scanning) return;
    var video = document.getElementById("cam-video");
    var hint = document.getElementById("cam-hint");
    if (!video) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (hint) hint.textContent = "อุปกรณ์นี้ไม่รองรับกล้อง — ใช้ช่องพิมพ์รหัสบัตรด้านล่างแทน";
      return;
    }
    scanning = true;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then(function (stream) {
        video.srcObject = stream;
        video.play();
        if (hint) hint.textContent = "วาง QR ของผู้เข้าร่วมให้อยู่ในกรอบ";
        requestAnimationFrame(tick);
      })
      .catch(function () {
        scanning = false;
        if (hint) hint.textContent = "เปิดกล้องไม่ได้ (ต้องอนุญาตสิทธิ์กล้อง) — พิมพ์รหัสบัตรด้านล่างแทนได้";
      });
  }

  function stopCamera() {
    scanning = false;
    var video = camNode && camNode.querySelector("video");
    if (video && video.srcObject) {
      video.srcObject.getTracks().forEach(function (t) { t.stop(); });
      video.srcObject = null;
    }
  }

  function tick() {
    if (!scanning) return;
    var video = camNode && camNode.querySelector("video");
    var canvas = camNode && camNode.querySelector("canvas");
    if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA && window.jsQR) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      var ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        var code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        // Same badge held in front of the lens produces a hit every frame —
        // ignore repeats for a few seconds so one person is checked in once.
        if (code && code.data) {
          var now = Date.now();
          if (code.data !== lastCode || now - lastCodeAt > 4000) {
            lastCode = code.data; lastCodeAt = now;
            submitScan({ qr: code.data });
          }
        }
      } catch (err) { /* frame not ready */ }
    }
    requestAnimationFrame(tick);
  }

  function submitScan(payload) {
    if (state.busy) return;
    state.busy = true;
    payload.eventId = state.eventId;
    payload.device = deviceId();
    payload.clientScanId = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    api("checkin", payload).then(function (r) {
      state.busy = false;
      state.scanResult = r;
      state.recentScans.unshift({
        time: new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }),
        name: r.name, code: r.badgeCode, result: r.result
      });
      state.recentScans = state.recentScans.slice(0, 6);
      if (r.result === "ok") beep(880); else beep(220);
      render();
      drawScanQr();
    }).catch(function (e) { state.busy = false; fail(e); });
  }

  function deviceId() {
    try {
      var k = localStorage.getItem("staff-device");
      if (!k) { k = "DEV-" + Math.random().toString(36).slice(2, 6).toUpperCase(); localStorage.setItem("staff-device", k); }
      return k;
    } catch (e) { return "WEB"; }
  }

  function beep(freq) {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx(), osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = freq; osc.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      osc.start(); osc.stop(ctx.currentTime + 0.2);
    } catch (e) { /* audio optional */ }
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

  function drawScanQr() {
    var el = document.getElementById("scan-qr");
    var r = state.scanResult;
    if (el && r && r.badgeCode) el.innerHTML = qrSvg(state.eventId + "|" + r.badgeCode);
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
    var manual = document.getElementById("manual-code");
    if (manual) manual.addEventListener("keydown", function (e) { if (e.key === "Enter") act("manual-checkin"); });
    bindInput("w-name", state.walkin, "name");
    bindInput("w-email", state.walkin, "email");
    bindInput("w-phone", state.walkin, "phone");
    bindInput("ne-name", state.ne, "name");
    bindInput("ne-date", state.ne, "date");
    bindInput("ne-place", state.ne, "place");
    var nf = document.getElementById("new-field");
    if (nf) nf.addEventListener("input", function (e) { state.newField = e.target.value; });

    var bq = document.getElementById("badge-qr");
    if (bq) bq.innerHTML = qrSvg("PREVIEW|TT-4F2A-901");
    drawScanQr();
  }

  function bindInput(id, obj, key) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("input", function (e) { obj[key] = e.target.value; });
  }

  function act(a, el) {
    switch (a) {
      case "reload": location.reload(); break;
      case "nav": go(el.dataset.id); break;
      case "pick-event":
        if (state.screen === "scan") stopCamera();
        state.eventId = el.dataset.id;
        state.scanResult = null; state.recentScans = []; state.rows = []; state.dash = null;
        render(); loadScreen();
        break;
      case "refresh": loadScreen(); flash("อัปเดตแล้ว"); break;
      case "export": doExport(); break;
      case "manual-checkin": {
        var input = document.getElementById("manual-code");
        var code = input ? input.value.trim() : "";
        if (!code) { flash("พิมพ์รหัสบัตรก่อน"); return; }
        if (input) input.value = "";
        submitScan({ badgeCode: code });
        break;
      }
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
        var order = ["VIEWER", "STAFF", "ADMIN"];
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
    }
  }

  function setBadge(patch) {
    var cur = state.badgeCfg[state.eventId] || { size: "A6", logo: true, org: true, type: true, qr: true, bar: true };
    state.badgeCfg[state.eventId] = Object.assign({}, cur, patch);
    render();
  }

  function printUrl(regId) {
    var base = location.href.split("?")[0];
    return base + "?page=badge&eventId=" + encodeURIComponent(state.eventId) + "&regId=" + encodeURIComponent(regId);
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
        state.screen = "fields";
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
