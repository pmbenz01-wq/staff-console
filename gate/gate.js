// 1neve Gate — the door's own app: scan, look someone up, see what was scanned.
//
// A second front end over the same Apps Script API the Staff Console uses, not
// a second system. The console is a desk tool whose scan screen puts the result
// 441px below the fold on a phone; this exists so the person holding the phone
// can see what happened without scrolling. See docs/adr/events-checkin-0013.
(function () {
  "use strict";

  var ID_TOKEN_KEY = "staff-id-token";     // shared shape with the console
  var SESSION_KEY = "staff-session";        // a password sign-in, same as the console
  var EVENT_KEY = "gate-event";
  var DEVICE_KEY = "gate-device";
  var GONE_MS = 1500;                      // a badge must leave frame to count again
  var SCAN_TIMEOUT_MS = 25000;
  var PASS_CLEAR_MS = 1900;                // only a pass clears itself
  var PROBE_MS = 5000;                     // how often to re-test a dead network
  var SEARCH_MIN = 2;                      // shorter than this is not a search

  var state = {
    phase: "boot",                         // boot | signin | ready | error
    me: null, events: [], eventId: null,
    tab: "scan",
    online: true,
    camera: "off",                         // off | on | denied | unsupported | noreader
    attendees: [], attendeesQuery: "", attendeesBusy: false,
    manual: "",                            // survives a re-render mid-typing
    history: [], historyBusy: false,
    busy: false, toast: "", fatal: "",
    login: { email: "", error: "", busy: false }
  };

  var app, camNode = null, scanning = false, lastCode = "", lastCodeAt = 0;
  // Which of the panel's two phases is on screen, and an answer that arrived
  // while an unacknowledged one was still up. See ADR 0020 and 0023.
  var panelPhase = "idle";        // "idle" | "scan" | "verdict"
  var heldVerdict = null;         // one deep, never a queue
  // The args behind whatever is currently painted into #verdict, so a
  // render() that just nuked app.innerHTML — network-status flips, tab
  // backgrounding — can put the same panel straight back up instead of
  // leaving panelPhase describing a screen that has gone blank.
  var paintedPanel = null;
  var inFlight = null;            // the check currently being waited on
  var LAPSE_AFTER_MS = 3000;      // when the seconds start showing
  var CANCEL_AFTER_MS = 8000;     // past the worst honest response measured
  var decoderLoading = null;
  // Every stream this app has opened, so none can outlive the button that says
  // the camera is off, and a generation counter so a cancelled attempt cannot
  // come back and attach itself later.
  var camStreams = [], scanGen = 0;
  var raf = null, toastTimer = null, verdictTimer = null, probeTimer = null;

  // ---------------------------------------------------------------------
  // transport — identical contract to the console's callSvc
  // ---------------------------------------------------------------------
  function loadToken() {
    try {
      var raw = localStorage.getItem(ID_TOKEN_KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d.token || !d.exp || d.exp * 1000 < Date.now() + 30000) return null;
      return d.token;
    } catch (e) { return null; }
  }
  function saveToken(token, exp) {
    try { localStorage.setItem(ID_TOKEN_KEY, JSON.stringify({ token: token, exp: exp })); } catch (e) {}
  }
  function clearToken() {
    try { localStorage.removeItem(ID_TOKEN_KEY); } catch (e) {}
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }
  function loadSession() {
    try {
      var d = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (!d || !d.token || !d.exp || d.exp * 1000 < Date.now() + 30000) return null;
      return d.token;
    } catch (e) { return null; }
  }
  function saveSession(token, exp) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ token: token, exp: exp })); } catch (e) {}
  }

  function decodeJwtExp(jwt) {
    try {
      var body = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return body.exp || 0;
    } catch (e) { return 0; }
  }

  function callSvc(action, payload) {
    var idToken = loadToken();
    var session = loadSession();
    if ((idToken || session) && window.APP_CONFIG && window.APP_CONFIG.APPS_SCRIPT_URL) {
      var body = { action: "staffCall", staffAction: action, payload: payload || {} };
      if (session) body.sessionToken = session; else body.idToken = idToken;
      return fetch(window.APP_CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(body)
      }).then(function (r) { return r.json(); });
    }
    // Local dev harness only, same as the console — never present in production.
    if (window.STAFF_DEV_API) {
      return fetch(window.STAFF_DEV_API, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: action, payload: payload || {} })
      }).then(function (r) { return r.json(); });
    }
    return Promise.reject(new Error("not_signed_in"));
  }

  function api(action, payload) {
    return callSvc(action, payload).then(function (res) {
      if (!res) throw new Error("empty_response");
      if (!res.ok) throw new Error(res.error || "unknown_error");
      markOnline(true);
      return res.data;
    });
  }

  // "Offline" means calls are not succeeding — not what navigator.onLine says.
  // A phone joined to a venue's wifi that has lost its uplink reports itself
  // online, which is exactly the case this has to catch (ADR 0017).
  function markOnline(up) {
    if (state.online === up) return;
    state.online = up;
    if (!up) startProbe(); else stopProbe();
    render();
  }
  function startProbe() {
    stopProbe();
    probeTimer = setInterval(function () {
      callSvc("whoAmI", {}).then(function (res) {
        if (res && res.ok) return markOnline(true);
        if (res && isAuthFailure(new Error(res.error || ""))) toSignIn();
      }).catch(function (e) {
        if (isAuthFailure(e)) toSignIn();      // otherwise the network is still down
      });
    }, PROBE_MS);
  }
  function stopProbe() { if (probeTimer) { clearInterval(probeTimer); probeTimer = null; } }

  // A failed call is not always a dead network. A token that expired mid-shift
  // fails every call too, and calling that "offline" sends the operator off to
  // fight the venue's wifi when what they need is to sign in again.
  function isAuthFailure(e) {
    var m = String((e && e.message) || e);
    return m.indexOf("invalid_id_token") >= 0 || m.indexOf("not_signed_in") >= 0 ||
           m.indexOf("no_identity") >= 0 || m.indexOf("wrong_audience") >= 0 ||
           m.indexOf("token_verify_failed") >= 0;
  }

  function toSignIn() {
    stopProbe();
    stopCamera();
    clearToken();
    state.phase = "signin";
    state.fatal = "เซสชันหมดอายุ — ลงชื่อเข้าใช้อีกครั้ง";
    render();
    loadGis();
  }

  // Everything that can fail a call routes through here so each cause gets the
  // response that actually helps: sign in again, wait for the network, or just
  // say what the server said.
  function handleFailure(e) {
    if (isAuthFailure(e)) { toSignIn(); return "auth"; }
    var m = String((e && e.message) || e);
    // A transport failure has no server code to read — fetch throws a TypeError
    // and a timeout carries our own marker.
    if (e instanceof TypeError || m.indexOf("Failed to fetch") >= 0 ||
        m.indexOf("NetworkError") >= 0 || m === "timeout" || m === "empty_response") {
      markOnline(false);
      return "offline";
    }
    return "server";
  }

  function deviceId() {
    try {
      var k = localStorage.getItem(DEVICE_KEY);
      if (!k) { k = "GATE-" + Math.random().toString(36).slice(2, 6).toUpperCase(); localStorage.setItem(DEVICE_KEY, k); }
      return k;
    } catch (e) { return "GATE"; }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function flash(msg) {
    state.toast = msg;
    render();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { state.toast = ""; render(); }, 2600);
  }

  function fail(e) {
    var m = String((e && e.message) || e);
    if (m.indexOf("forbidden_role") >= 0) return flash("สิทธิ์ของคุณไม่พอสำหรับการกระทำนี้");
    if (m.indexOf("forbidden_event") >= 0) return flash("คุณไม่มีสิทธิ์ในงานนี้");
    if (m.indexOf("not_authorized") >= 0) return flash("บัญชีนี้ยังไม่ได้อยู่ในทีมงาน");
    if (m.indexOf("busy") >= 0) return flash("ระบบกำลังบันทึกรายการอื่น ลองอีกครั้ง");
    flash("ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง");
  }

  // ---------------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------------
  function boot() {
    app = document.getElementById("app");
    if (!window.APP_CONFIG || !window.APP_CONFIG.APPS_SCRIPT_URL) {
      if (!window.STAFF_DEV_API) {
        state.phase = "error";
        state.fatal = "ยังไม่ได้ตั้งค่า config.js — ต้องมี APPS_SCRIPT_URL และ GOOGLE_CLIENT_ID";
        return render();
      }
    }
    if (!loadToken() && !loadSession() && !window.STAFF_DEV_API) {
      state.phase = "signin";
      render();
      loadGis();
      return;
    }
    loadBootstrap();
  }

  function loadBootstrap() {
    state.phase = "boot";
    render();
    api("bootstrap", {}).then(function (d) {
      state.me = d.me;
      state.events = d.events || [];
      var saved = null;
      try { saved = localStorage.getItem(EVENT_KEY); } catch (e) {}
      var known = state.events.some(function (e) { return e.id === saved; });
      state.eventId = known ? saved : (state.events.length === 1 ? state.events[0].id : null);
      state.phase = "ready";
      render();
      if (state.eventId) loadTab();
    }).catch(function (e) {
      var m = String((e && e.message) || e);
      if (m.indexOf("invalid_id_token") >= 0 || m.indexOf("not_signed_in") >= 0) {
        clearToken();
        state.phase = "signin";
        render();
        loadGis();
        return;
      }
      state.phase = "error";
      state.fatal = m.indexOf("not_authorized") >= 0
        ? "บัญชีนี้ยังไม่ได้ถูกเพิ่มเข้าทีมงาน — ให้แอดมินเพิ่มก่อน"
        : "เชื่อมต่อระบบไม่สำเร็จ: " + m;
      render();
    });
  }

  function loadGis() {
    if (window.google && window.google.accounts) return renderGis();
    var s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = renderGis;
    s.onerror = function () {
      state.fatal = "โหลด Google Sign-In ไม่ได้ ตรวจการเชื่อมต่ออินเทอร์เน็ต";
      render();
    };
    document.head.appendChild(s);
  }

  function renderGis() {
    var clientId = window.APP_CONFIG && window.APP_CONFIG.GOOGLE_CLIENT_ID;
    var slot = document.getElementById("gis");
    if (!clientId || !slot || !window.google || !window.google.accounts) return;
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: function (resp) {
        if (!resp || !resp.credential) return;
        saveToken(resp.credential, decodeJwtExp(resp.credential));
        loadBootstrap();
      },
      // Catches what it can. It does NOT catch an unregistered origin with a
      // rendered button — Google only routes that through here for One Tap,
      // and otherwise just logs it to the console — which is why the sign-in
      // screen carries a written note about it instead.
      error_callback: function (err) {
        state.fatal = "เข้าสู่ระบบไม่สำเร็จ: " +
          ((err && err.message) || (err && err.type) || "ไม่ทราบสาเหตุ");
        render();
      }
    });
    window.google.accounts.id.renderButton(slot, {
      theme: "filled_black", size: "large", text: "signin_with", shape: "pill"
    });
  }

  // ---------------------------------------------------------------------
  // data per tab
  // ---------------------------------------------------------------------
  function loadTab() {
    if (!state.eventId) return;
    if (state.tab === "list") {
      if (state.attendeesQuery.trim().length < SEARCH_MIN) {
        state.attendees = []; state.attendeesBusy = false; render(); return;
      }
      state.attendeesBusy = true; render();
      api("attendees", { eventId: state.eventId, query: state.attendeesQuery })
        .then(function (d) { state.attendees = d || []; state.attendeesBusy = false; render(); })
        .catch(function (e) {
          state.attendeesBusy = false;
          if (handleFailure(e) === "server") fail(e);
          render();
        });
    } else if (state.tab === "recent") {
      state.historyBusy = true; render();
      api("history", { eventId: state.eventId, filter: "all" })
        .then(function (d) { state.history = d || []; state.historyBusy = false; render(); })
        .catch(function (e) {
          state.historyBusy = false;
          if (handleFailure(e) === "server") fail(e);
          render();
        });
    }
  }

  // ---------------------------------------------------------------------
  // camera — off until asked (ADR 0018)
  // ---------------------------------------------------------------------
  // 260 KB of QR decoder that the sign-in screen has no use for. It arrives
  // when the operator asks for the camera, which by ADR 0018 is the first
  // moment anything scanning-related is wanted at all.
  function ensureDecoder() {
    if (window.jsQR) return Promise.resolve();
    if (decoderLoading) return decoderLoading;
    decoderLoading = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "./vendor/jsQR.js";
      s.onload = function () { resolve(); };
      s.onerror = function () { decoderLoading = null; reject(new Error("decoder_failed")); };
      document.head.appendChild(s);
    });
    return decoderLoading;
  }

  function releaseStreams() {
    camStreams.forEach(function (s) {
      s.getTracks().forEach(function (t) { t.stop(); });
    });
    camStreams.length = 0;
  }

  function startCamera() {
    if (scanning) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      state.camera = "unsupported"; render(); return;
    }
    scanning = true;
    var gen = ++scanGen;
    state.camera = "on";
    render();
    // The decoder has to be here before the camera is, or the operator gets a
    // live picture that silently never reads anything.
    ensureDecoder().then(function () {
      // Stopped while the decoder was still downloading. Do not open the camera
      // at all: opening it only to close it again lights the phone's camera
      // indicator for no reason.
      if (!scanning || gen !== scanGen) throw new Error("cancelled");
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    }).then(function (stream) {
      // This attempt is no longer the current one — someone pressed home, or
      // tapped the button again and a newer open won. The stream still arrived,
      // and if it is not stopped right here nothing else ever will: it is
      // attached to no video element, so stopCamera cannot find it, and the
      // phone keeps the camera running behind a button that says it is off.
      if (!scanning || gen !== scanGen) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      var video = camNode && camNode.querySelector("video");
      if (!video) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      releaseStreams();                      // anything an earlier attempt left open
      camStreams.push(stream);
      video.srcObject = stream;
      video.play();
      raf = requestAnimationFrame(function () { tick(gen); });
    }).catch(function (e) {
      var m = String((e && e.message) || e);
      if (m === "cancelled") return;         // stopCamera has already set the screen right
      scanning = false;
      state.camera = m === "decoder_failed" ? "noreader" : "denied";
      render();
    });
  }

  function stopCamera() {
    scanning = false;
    scanGen++;                               // orphans every pending open and every tick loop
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    releaseStreams();
    var video = camNode && camNode.querySelector("video");
    if (video) video.srcObject = null;
    if (state.camera === "on") state.camera = "off";
  }

  function tick(gen) {
    if (!scanning || gen !== scanGen) return;
    // Nothing is read while a check is in flight. submitScan would refuse it
    // anyway, so running jsQR over every frame for five seconds only to throw
    // the answer away is battery a phone working a door all day does not have
    // to spare. The rAF loop itself keeps running: it costs nothing and means
    // reading resumes the moment the answer lands, with no camera restart.
    if (state.busy) {
      raf = requestAnimationFrame(function () { tick(gen); });
      return;
    }
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
        var now = Date.now();
        if (code && code.data) {
          var fresh = code.data !== lastCode || now - lastCodeAt > GONE_MS;
          if (!fresh) {
            lastCodeAt = now;                    // same badge, still held up
          } else if (submitScan({ qr: code.data })) {
            // Only counts as seen once it actually went out, so a badge
            // presented while an earlier scan is in flight is not swallowed.
            lastCode = code.data;
            lastCodeAt = now;
          }
        } else if (lastCode && now - lastCodeAt > GONE_MS) {
          lastCode = "";                         // frame cleared, next person
        }
      } catch (err) { /* frame not ready */ }
    }
    raf = requestAnimationFrame(function () { tick(gen); });
  }

  // ---------------------------------------------------------------------
  // scanning
  // ---------------------------------------------------------------------
  // Returns true when the scan was actually sent.
  function submitScan(payload) {
    if (state.busy) return false;
    if (!state.online) { showOfflineVerdict(); return false; }
    if (!state.eventId) return false;
    state.busy = true;

    // The receipt: up before anything is sent, so the operator can lower the
    // phone. Deliberately colourless — at this moment the app knows only that
    // it read a code, and a forged badge decodes as cleanly as a real one.
    var shownCode = payload.qr ? String(payload.qr).split("|")[1] || "" : (payload.badgeCode || "");
    showPanel("scan", "รับรหัสแล้ว", "กำลังตรวจ…", "", esc(shownCode), "", false);
    // Fires whether or not the panel could take the screen: if an
    // unacknowledged rejection is still up the panel was skipped, and the
    // sound is then the only thing telling the operator the badge was read.
    receipt();

    payload.eventId = state.eventId;
    payload.device = deviceId();
    payload.clientScanId = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    var run = inFlight = { settled: false, startedAt: Date.now(), timer: null, interval: null };

    function finish() {
      run.settled = true;
      clearTimeout(run.timer);
      clearInterval(run.interval);
      if (inFlight === run) inFlight = null;
      state.busy = false;
    }

    // Under normal conditions this never draws anything: the answer lands at
    // about five seconds and the counter starts at three. It exists for the
    // stalls — Apps Script was measured taking 38s and 48s in one session, and
    // a still panel through that is indistinguishable from a frozen app.
    run.interval = setInterval(function () {
      if (run.settled || panelPhase !== "scan") return;
      var secs = Math.floor((Date.now() - run.startedAt) / 1000);
      if (secs * 1000 < LAPSE_AFTER_MS) return;
      var lapse = document.getElementById("lapse");
      if (lapse) { lapse.hidden = false; lapse.textContent = "รอมาแล้ว " + secs + " วินาที"; }
      if (secs * 1000 >= CANCEL_AFTER_MS && !document.querySelector('[data-act="cancel"]')) {
        var acts = document.querySelector("#verdict .act");
        if (acts) {
          acts.innerHTML = '<button class="ghost" data-act="cancel">ยกเลิกแล้วยิงใหม่</button>';
          acts.querySelectorAll("[data-act]").forEach(function (b) {
            b.addEventListener("click", function (ev) { ev.stopPropagation(); act(b.dataset.act, b); });
          });
        }
      }
    }, 500);

    run.timer = setTimeout(function () {
      if (run.settled) return;
      finish();
      markOnline(false);
      // lastCode is left set on purpose: clearing it would make a badge still
      // held in frame look new and re-send itself with nobody asking. A cancel
      // does the opposite, because a cancel is somebody asking for another go.
      showOfflineVerdict();
    }, SCAN_TIMEOUT_MS);

    api("checkin", payload).then(function (r) {
      if (run.settled) return;
      finish();
      showResult(r);
      if (state.tab === "recent") loadTab();
    }).catch(function (e) {
      if (run.settled) return;
      finish();
      var kind = handleFailure(e);
      if (kind === "offline") showOfflineVerdict();
      else if (kind === "server") { fail(e); }
      // an auth failure has already taken the app to the sign-in screen
    });
    return true;
  }

  var MARKS = {
    scan: '<path d="M4 9V5h4M24 9V5h-4M4 19v4h4M24 19v4h-4"/><path d="M3 14h22"/>',
    ok:   '<path d="M5 13l5 5L23 5"/>',
    dup:  '<path d="M12 6v9"/><path d="M12 20h.01"/>',
    bad:  '<path d="M6 6l16 16M22 6L6 22"/>',
    wait: '<circle cx="14" cy="14" r="11"/><path d="M14 8v6l4 3"/>'
  };

  function showResult(r) {
    var kind = r.result === "ok" ? "ok" : r.result === "duplicate" ? "dup" : "bad";
    var said = r.result === "ok" ? "เช็คอินสำเร็จ"
      : r.result === "duplicate" ? "สแกนซ้ำ — เข้างานไปแล้ว"
      : r.result === "wrong_event" ? "บัตรของงานอื่น"
      : r.result === "bad_signature" ? "QR ไม่ถูกต้อง" : "ไม่พบรหัสนี้";
    var name = r.result === "ok" || r.result === "duplicate" ? (r.name || r.badgeCode || "—") : "ให้เข้าไม่ได้";
    // Everything here is escaped before it goes in: paintPanel writes meta as
    // HTML so the offline message can carry a line break, and org, type and the
    // operator's name are all values somebody typed into a form.
    var meta = "";
    if (r.result === "ok") meta = esc([r.org, r.type].filter(Boolean).join(" · "));
    else if (r.result === "duplicate") {
      meta = esc("เช็คอินครั้งแรก " + (r.firstAt ? new Date(r.firstAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) : "—") +
        (r.firstBy ? " · " + r.firstBy : "") + (r.firstGate ? " · " + r.firstGate : ""));
    } else if (r.result === "wrong_event") meta = "QR ใบนี้ออกให้กับงานอื่น";
    else if (r.result === "bad_signature") meta = "ลายเซ็นไม่ผ่าน — บัตรนี้ไม่ได้ออกจากระบบ";
    else meta = "ไม่มีผู้ลงทะเบียนรหัสนี้ — ลองค้นด้วยชื่อแทน";

    var acts = "";
    if (r.result === "ok" && r.regId) {
      acts = '<button data-act="print" data-id="' + esc(r.regId) + '">พิมพ์บัตร</button>' +
             '<button class="ghost" data-act="dismiss">ถัดไป</button>';
    } else if (kind === "bad") {
      acts = '<button data-act="tolist">ค้นด้วยชื่อ</button><button class="ghost" data-act="dismiss">ปิด</button>';
    } else {
      acts = '<button data-act="dismiss">รับทราบ</button>';
    }

    showPanel(kind, said, name, meta, r.badgeCode ? esc(r.badgeCode) : "", acts, r.result === "ok");
    beep(r.result === "ok" ? 880 : 220);
  }

  function showOfflineVerdict() {
    showPanel("wait", "ยังเช็คอินไม่ได้", "รอเครือข่าย",
      "ตรวจบัตรต้องใช้เซิร์ฟเวอร์ ระบบจึงยังยืนยันไม่ได้ว่าบัตรใบนี้ของจริง<br>" +
      "ลองใหม่เมื่อป้ายด้านบนกลับเป็นออนไลน์", "",
      '<button data-act="dismiss">รับทราบ</button>', false);
    beep(220);
  }

  // Every paint goes through here. Two rules live in this one place:
  //
  //   A verdict the operator has not acknowledged is never painted over. The
  //   newer answer waits — one deep, because nobody at a door wants to tap
  //   through a backlog to reach the person in front of them.
  //
  //   The neutral phase is not queued, it is skipped. Holding it would mean
  //   dismissing a rejection and being shown "กำลังตรวจ" for a check that
  //   finished long ago.
  function showPanel(kind, said, name, meta, code, acts, autoClear) {
    var neutral = kind === "scan";
    if (panelPhase === "verdict") {
      if (neutral) return false;
      heldVerdict = [kind, said, name, meta, code, acts, autoClear];
      return false;
    }
    paintPanel(kind, said, name, meta, code, acts, autoClear);
    return true;
  }

  function paintPanel(kind, said, name, meta, code, acts, autoClear) {
    var el = document.getElementById("verdict");
    if (!el) return;
    panelPhase = kind === "scan" ? "scan" : "verdict";
    paintedPanel = [kind, said, name, meta, code, acts, autoClear];
    // The same node, recoloured. Nothing closes and reopens, so the CSS
    // transition on background-color carries one phase into the next.
    el.className = "verdict v-" + kind + " up";
    el.innerHTML =
      '<svg class="mark" viewBox="0 0 28 28">' + (MARKS[kind] || "") + "</svg>" +
      '<div class="said">' + esc(said) + "</div>" +
      '<div class="name">' + esc(name) + "</div>" +
      '<div class="meta">' + meta + "</div>" +
      (code ? '<div class="code">' + code + "</div>" : "") +
      '<div class="lapse" id="lapse" hidden></div>' +
      '<div class="act">' + acts + "</div>" +
      (kind === "scan" ? "" : '<div class="tap">แตะที่ใดก็ได้เพื่อปิด</div>');
    el.querySelectorAll("[data-act]").forEach(function (b) {
      b.addEventListener("click", function (ev) { ev.stopPropagation(); act(b.dataset.act, b); });
    });
    clearTimeout(verdictTimer);
    // Only a pass clears itself — it is the one the operator does nothing
    // about, and a full screen left up blocks the camera behind it.
    if (autoClear) verdictTimer = setTimeout(hideVerdict, PASS_CLEAR_MS);
  }

  function hideVerdict() {
    clearTimeout(verdictTimer);
    var el = document.getElementById("verdict");
    // Only the visibility class comes off. Clearing the whole className would
    // take the colour with it at once, so the panel would blink transparent
    // while the opacity was still fading.
    if (el) el.classList.remove("up");
    panelPhase = "idle";
    paintedPanel = null;
    if (heldVerdict) {
      var h = heldVerdict;
      heldVerdict = null;
      paintPanel(h[0], h[1], h[2], h[3], h[4], h[5], h[6]);
    }
  }

  // The read gets a sound of its own, higher and much shorter than either
  // verdict tone, so an operator learns the difference without being told.
  // Vibration is a bonus: Safari on iOS has no Vibration API at all, which is
  // why the panel — not the buzz — is the signal the design leans on.
  function receipt() {
    beep(1320, 0.07);
    try { if (navigator.vibrate) navigator.vibrate(35); } catch (e) {}
  }

  function beep(freq, seconds) {
    var dur = seconds || 0.18;
    try {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      var ctx = new C(), o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = freq; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(.06, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + dur);
      o.start(); o.stop(ctx.currentTime + dur + .02);
    } catch (e) { /* sound is a bonus, never the only signal */ }
  }

  function printUrl(regId) {
    return "./badge.html?eventId=" + encodeURIComponent(state.eventId) +
      "&regId=" + encodeURIComponent(regId);
  }

  // ---------------------------------------------------------------------
  // render
  // ---------------------------------------------------------------------
  function render() {
    if (!app) return;
    var html;
    if (state.phase === "signin") html = viewSignIn();
    else if (state.phase === "error") html = viewFatal();
    else if (state.phase === "boot") html = viewBoot();
    else html = viewApp();
    if (state.toast) html += '<div class="toast">' + esc(state.toast) + "</div>";
    var focusId = document.activeElement && document.activeElement.id;
    var caret = null;
    try { if (focusId) caret = document.activeElement.selectionStart; } catch (e) {}
    app.innerHTML = html;
    bind();
    // app.innerHTML just wiped whatever paintPanel had drawn into #verdict —
    // that div is emitted empty by viewApp() every time. panelPhase and
    // paintedPanel survive a render() untouched, so put the same panel back
    // up rather than leave panelPhase claiming a screen nobody can see.
    // Repainting after bind() (not before) matters: bind()'s own
    // [data-act] sweep must not see the panel's buttons, or paintPanel's
    // listeners below would stack a second one on each.
    if (panelPhase !== "idle" && paintedPanel) {
      paintPanel(paintedPanel[0], paintedPanel[1], paintedPanel[2], paintedPanel[3],
                 paintedPanel[4], paintedPanel[5], paintedPanel[6]);
    }
    if (focusId) {
      var back = document.getElementById(focusId);
      if (back && typeof back.focus === "function") {
        back.focus();
        try { if (caret != null) back.setSelectionRange(caret, caret); } catch (e) {}
      }
    }
    if (state.phase === "ready" && state.tab === "scan") mountCamera();
    if (state.phase === "signin") renderGis();
  }

  function viewBoot() {
    return '<div class="app"><div class="boot"><div>' +
      '<div class="boot-kicker">1NEVE GATE</div>' +
      '<div class="boot-title">กำลังเปิดระบบ…</div></div></div></div>';
  }

  function viewSignIn() {
    return '<div class="app"><div class="boot"><div>' +
      '<div class="boot-kicker">1NEVE GATE</div>' +
      '<div class="boot-title">เช็คอินหน้างาน</div>' +
      '<div class="boot-sub">ลงชื่อเข้าใช้ด้วยบัญชี Google ที่อยู่ในทีมงาน<br>' +
      'ระบบจะบันทึกชื่อคุณไว้กับทุกการสแกน</div>' +
      '<div class="boot-slot" id="gis"></div>' +
      (state.fatal ? '<div class="boot-err">' + esc(state.fatal) + "</div>" : "") +
      '<div class="or"><span>หรือ</span></div>' +
      '<input class="li" id="li-email" type="email" autocomplete="username" ' +
      'value="' + esc(state.login.email) + '" placeholder="อีเมล">' +
      '<input class="li" id="li-pass" type="password" autocomplete="current-password" placeholder="รหัสผ่าน">' +
      (state.login.error ? '<div class="boot-err">' + esc(state.login.error) + "</div>" : "") +
      '<button class="cam-start" data-act="pwlogin" style="width:100%;margin-top:12px">' +
      (state.login.busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบด้วยรหัสผ่าน") + "</button>" +
      // An origin missing from the OAuth client renders a button that does
      // nothing and reports it only to the browser console. Nobody at a door
      // reads that, so the possibility is written where it will be looked for.
      '<div class="boot-note">กดแล้วไม่มีอะไรเกิดขึ้น?<br>' +
      'โดเมนนี้อาจยังไม่ได้รับอนุญาต — ผู้ดูแลต้องเพิ่ม<br><b>' + esc(location.origin) +
      "</b><br>ใน Authorized JavaScript origins ของ OAuth client</div>" +
      "</div></div></div>";
  }

  function viewFatal() {
    return '<div class="app"><div class="boot"><div>' +
      '<div class="boot-kicker">1NEVE GATE</div>' +
      '<div class="boot-title">เปิดระบบไม่ได้</div>' +
      '<div class="boot-err">' + esc(state.fatal) + "</div>" +
      '<div class="boot-slot"><button class="cam-start" data-act="retry">ลองใหม่</button></div>' +
      "</div></div></div>";
  }

  function currentEvent() {
    for (var i = 0; i < state.events.length; i++) {
      if (state.events[i].id === state.eventId) return state.events[i];
    }
    return null;
  }

  function viewApp() {
    var ev = currentEvent();
    var bar =
      '<div class="bar">' +
        '<div class="who"><b>' + esc((state.me && state.me.name) || "") + "</b>" +
        '<span data-act="pickevent">' + esc((state.me && state.me.gate) || "—") + " · " +
        esc(ev ? ev.name : "เลือกงาน") + " ▾</span></div>" +
        '<button class="net' + (state.online ? "" : " is-down") + '" data-act="probe">' +
        '<i class="dot"></i>' + (state.online ? "ออนไลน์" : "ออฟไลน์ · หยุดรับ") + "</button>" +
      "</div>";

    var tabs =
      '<div class="tabs">' +
        tabBtn("scan", "สแกน", '<path d="M4 8V5a1 1 0 011-1h3M20 8V5a1 1 0 00-1-1h-3M4 16v3a1 1 0 001 1h3M20 16v3a1 1 0 01-1 1h-3M3 12h18"/>') +
        tabBtn("list", "รายชื่อ", '<path d="M4 6h16M4 12h16M4 18h10"/>') +
        tabBtn("recent", "เพิ่งสแกน", '<path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="8"/>') +
      "</div>";

    return '<div class="app">' + bar +
      viewScan() + viewList() + viewRecent() + tabs +
      '<div class="verdict" id="verdict"></div>' +
      (state.eventId ? "" : viewPicker()) +
      "</div>";
  }

  function tabBtn(id, label, path) {
    return '<button class="' + (state.tab === id ? "on" : "") + '" data-act="tab" data-id="' + id + '">' +
      '<svg viewBox="0 0 24 24">' + path + "</svg>" + label + "</button>";
  }

  function viewScan() {
    var off = "";
    if (state.camera !== "on") {
      var msg = state.camera === "denied"
        ? "ไม่ได้รับสิทธิ์ใช้กล้อง — เปิดสิทธิ์ในตั้งค่าเบราว์เซอร์ หรือพิมพ์รหัสบัตรด้านล่างแทน"
        : state.camera === "unsupported"
        ? "อุปกรณ์นี้เปิดกล้องไม่ได้ — ใช้ช่องพิมพ์รหัสบัตรด้านล่างแทน"
        : state.camera === "noreader"
        ? "โหลดตัวอ่าน QR ไม่สำเร็จ — ตรวจอินเทอร์เน็ตแล้วกดลองใหม่ หรือพิมพ์รหัสบัตรด้านล่างแทน"
        : "กล้องยังไม่เปิด กดปุ่มด้านล่างเมื่อพร้อมสแกน";
      off = '<div class="cam-off"><div><p>' + esc(msg) + "</p>" +
        (state.camera === "off" || state.camera === "noreader"
          ? '<button class="cam-start" data-act="camon">' +
            (state.camera === "noreader" ? "ลองใหม่" : "เริ่มสแกน") + "</button>" : "") +
        "</div></div>";
    }
    return '<div class="pane' + (state.tab === "scan" ? " on" : "") + '">' +
      '<div class="cam" id="cam">' +
        '<div class="frame"><i></i><i></i><i></i><i></i></div>' +
        '<div class="hint">วาง QR ของผู้เข้าร่วมให้อยู่ในกรอบ</div>' +
        off +
        (state.online ? "" : '<div class="cam-down">รอเครือข่าย — ยังเช็คอินไม่ได้</div>') +
      "</div>" +
      '<div class="manual">' +
        '<input id="manual" value="' + esc(state.manual) +
        '" placeholder="พิมพ์รหัสบัตร เช่น TT-1A2B-901" autocomplete="off" autocapitalize="characters">' +
        '<button data-act="manual">เช็คอิน</button>' +
      "</div></div>";
  }

  function viewList() {
    var rows;
    var q = state.attendeesQuery.trim();
    if (state.attendeesBusy) rows = '<div class="empty">กำลังโหลด…</div>';
    else if (q.length < SEARCH_MIN) rows = '<div class="empty">พิมพ์ชื่อ หรือรหัสบัตร เพื่อค้นหา<br>' +
      "รายชื่อทั้งงานจะไม่แสดงขึ้นมาเอง</div>";
    else if (!state.attendees.length) rows = '<div class="empty">ไม่พบ “' + esc(q) + "”</div>";
    else rows = state.attendees.map(function (a) {
      var inn = a.status === "checked_in";
      return '<div class="row"><div class="grow"><div class="nm">' + esc(a.name) + "</div>" +
        '<div class="sub">' + esc(a.code) + (a.org ? " · " + esc(a.org) : "") + "</div></div>" +
        '<span class="tag ' + (inn ? "t-in" : "t-out") + '">' + (inn ? "เข้าแล้ว" : "ยังไม่เข้า") + "</span>" +
        // One button per row, and which one follows from where the person is:
        // not in yet, so let them in; already in, so print what they wear.
        // Printing before a check-in would hand out a badge for someone the
        // system has no record of admitting.
        (inn
          ? '<button class="go" data-act="print" data-id="' + esc(a.regId) + '">พิมพ์บัตร</button>'
          : '<button class="go" data-act="checkin" data-id="' + esc(a.regId) + '">เช็คอิน</button>') +
        "</div>";
    }).join("");
    return '<div class="pane' + (state.tab === "list" ? " on" : "") + '"><div class="scroll">' +
      '<div class="search"><input id="q" value="' + esc(state.attendeesQuery) +
      '" placeholder="ค้นหาชื่อ หรือรหัสบัตร"></div>' + rows + "</div></div>";
  }

  function viewRecent() {
    var rows;
    if (state.historyBusy) rows = '<div class="empty">กำลังโหลด…</div>';
    else if (!state.history.length) rows = '<div class="empty">ยังไม่มีการสแกนในงานนี้</div>';
    else rows = state.history.map(function (h) {
      var cls = h.result === "ok" ? "t-in" : h.result === "duplicate" ? "t-dup" : "t-bad";
      var lab = h.result === "ok" ? "เข้าแล้ว" : h.result === "duplicate" ? "ซ้ำ" : "ปฏิเสธ";
      return '<div class="row"><div class="time">' + esc(h.time) + "</div>" +
        '<div class="grow"><div class="nm">' + esc(h.name || "—") + "</div>" +
        '<div class="sub">' + esc(h.code) + (h.by ? " · " + esc(h.by) : "") + "</div></div>" +
        '<span class="tag ' + cls + '">' + lab + "</span></div>";
    }).join("");
    return '<div class="pane' + (state.tab === "recent" ? " on" : "") + '"><div class="scroll">' +
      '<div class="cap">ทุกการสแกนของงานนี้ · ล่าสุด 300 รายการ</div>' + rows + "</div></div>";
  }

  function viewPicker() {
    var list = state.events.map(function (e) {
      return '<button class="ev' + (e.id === state.eventId ? " on" : "") + '" data-act="setevent" data-id="' + esc(e.id) + '">' +
        "<b>" + esc(e.name) + "</b><span>" + esc(e.date || "") + (e.hidden ? " · ซ่อนจากลูกค้า" : "") + "</span></button>";
    }).join("");
    return '<div class="sheet"><div class="sheet-in"><h2>เลือกงาน</h2>' +
      "<p>เครื่องนี้จะจำงานที่เลือกไว้ เปลี่ยนได้จากแถบบน</p>" +
      (list || '<div class="empty">บัญชีนี้ยังไม่ได้รับสิทธิ์งานใด</div>') + "</div></div>";
  }

  function mountCamera() {
    var slot = document.getElementById("cam");
    if (!slot) return;
    if (!camNode) {
      camNode = document.createElement("div");
      camNode.style.cssText = "position:absolute;inset:0;z-index:1";
      camNode.innerHTML = '<video playsinline muted></video><canvas></canvas>';
    }
    // Re-appended rather than rebuilt, so the stream survives a re-render.
    slot.insertBefore(camNode, slot.firstChild);
  }

  // ---------------------------------------------------------------------
  // events
  // ---------------------------------------------------------------------
  function bind() {
    app.querySelectorAll("[data-act]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        act(el.dataset.act, el);
      });
    });
    var v = document.getElementById("verdict");
    if (v) v.addEventListener("click", function (e) {
      if (!e.target.closest("[data-act]")) hideVerdict();
    });
    var q = document.getElementById("q");
    if (q) {
      q.addEventListener("input", function () {
        state.attendeesQuery = q.value;
        clearTimeout(q.__t);
        q.__t = setTimeout(loadTab, 350);
      });
    }
    var m = document.getElementById("manual");
    if (m) {
      m.addEventListener("input", function () { state.manual = m.value; });
      m.addEventListener("keydown", function (e) { if (e.key === "Enter") act("manual"); });
    }
  }

  function act(what, el) {
    if (what === "tab") {
      var next = el.dataset.id;
      if (next === state.tab) return;
      if (state.tab === "scan") stopCamera();
      state.tab = next;
      render();
      loadTab();
    } else if (what === "camon") {
      startCamera();
    } else if (what === "dismiss") {
      hideVerdict();
    } else if (what === "cancel") {
      // Abandons waiting, never the check-in: the request may already have
      // reached the server. Presenting the badge again is what tells the
      // operator what really happened — gold means the first attempt landed,
      // green means it did not.
      if (inFlight) {
        inFlight.settled = true;
        clearTimeout(inFlight.timer);
        clearInterval(inFlight.interval);
        inFlight = null;
      }
      state.busy = false;
      lastCode = "";                 // so the same badge can be read straight away
      hideVerdict();
    } else if (what === "print") {
      window.open(printUrl(el.dataset.id), "_blank");
    } else if (what === "tolist") {
      hideVerdict();
      if (state.tab === "scan") stopCamera();
      state.tab = "list";
      render();
      loadTab();
    } else if (what === "manual") {
      var input = document.getElementById("manual");
      var code = (input && input.value || state.manual || "").trim().toUpperCase();
      if (!code) return;
      if (submitScan({ badgeCode: code })) {
        state.manual = "";
        if (input) input.value = "";
      } else flash("กำลังบันทึกรายการก่อนหน้า — กดเช็คอินอีกครั้ง");
    } else if (what === "checkin") {
      var regId = el.dataset.id;
      state.busy = true;
      api("setCheckedIn", { eventId: state.eventId, regId: regId, on: true })
        .then(function () { state.busy = false; flash("เช็คอินแล้ว"); loadTab(); })
        .catch(function (e) {
          state.busy = false;
          if (handleFailure(e) === "server") fail(e);
        });
    } else if (what === "pickevent") {
      state.eventId = null;
      render();
    } else if (what === "setevent") {
      state.eventId = el.dataset.id;
      try { localStorage.setItem(EVENT_KEY, state.eventId); } catch (e) {}
      render();
      loadTab();
    } else if (what === "probe") {
      callSvc("whoAmI", {}).then(function (res) {
        if (res && res.ok) { markOnline(true); flash("เชื่อมต่อได้แล้ว"); }
        else flash("ยังเชื่อมต่อไม่ได้");
      }).catch(function () { flash("ยังเชื่อมต่อไม่ได้"); });
    } else if (what === "pwlogin") {
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
          state.login.error = res && res.error === "too_many_attempts"
            ? "ลองผิดหลายครั้งเกินไป รอสัก 15 นาทีแล้วลองใหม่"
            : "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
          render();
          return;
        }
        saveSession(res.data.sessionToken, res.data.exp);
        state.fatal = "";
        loadBootstrap();
      }).catch(function () {
        state.login.busy = false;
        state.login.error = "เชื่อมต่อไม่สำเร็จ ลองใหม่อีกครั้ง";
        render();
      });
    } else if (what === "retry") {
      state.fatal = "";
      boot();
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden && scanning) { stopCamera(); render(); }
  });

  boot();
})();
