/**
 * @OnlyCurrentDoc
 * Adizes questionnaire: the Google side. Lives inside the Sheet (bound script).
 *
 * Tabs (created by setup()):
 *   Workshops   – code | name | date | open | showScores | expected names (one per line)
 *   Submissions – time | workshop | name | P | A | E | I | code | seconds | flags | answers(JSON)
 *
 * Web app (deploy: execute as me, anyone can access):
 *   GET  ?action=workshop&code=xxxxxx      → public workshop info for the participant page
 *   POST text/plain JSON {action:"submit"}  → validate, recompute, append one row
 * The site POSTs as text/plain on purpose: Apps Script does not answer CORS preflight requests.
 * Every response is JSON, even on errors, so the phone can tell "rejected" from "offline".
 */

var TAB_WORKSHOPS = "Workshops";
var TAB_SUBMISSIONS = "Submissions";
var WORKSHOP_HEAD = ["קוד", "שם הסדנה", "תאריך", "פתוח", "ציונים למשתתפים", "משתתפים צפויים (שם בכל שורה)"];
var SUBMISSION_HEAD = ["זמן", "קוד סדנה", "שם", "P", "A", "E", "I", "קוד", "שניות", "סימונים", "תשובות"];

/* ---------------- web endpoints ---------------- */

function doGet(e) {
  return respond(function () {
    var p = (e && e.parameter) || {};
    if (p.action !== "workshop") return { ok: false, error: "bad_request" };
    if (!isValidWorkshopCode(p.code)) return { ok: false, error: "bad_workshop" };
    var w = findWorkshop(p.code);
    if (!w) return { ok: false, error: "unknown_workshop" };
    // public info only: no expected names, no results
    return { ok: true, workshop: { code: w.code, name: w.name, date: w.date, open: w.open, showScores: w.showScores } };
  });
}

function doPost(e) {
  return respond(function () {
    var payload;
    try { payload = JSON.parse(e.postData.contents); } catch (err) { return { ok: false, error: "bad_json" }; }
    if (payload && payload.action === "results") return modResults(payload);
    if (payload && payload.action === "saveRoster") return modSaveRoster(payload);
    if (!payload || payload.action !== "submit") return { ok: false, error: "bad_request" };

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) return { ok: false, error: "busy", retry: true };   // the site retries with back-off
    try {
      var w = isValidWorkshopCode(payload.workshop) ? findWorkshop(payload.workshop) : null;
      var result = validateSubmission(payload, w, w ? countRows(w.code) : 0);
      if (!result.ok) return result;
      var v = result.value;
      sheet(TAB_SUBMISSIONS).appendRow([
        new Date(), w.code, sheetSafe(v.name), v.scores.P, v.scores.A, v.scores.E, v.scores.I,
        sheetSafe(v.code), v.seconds, v.flags.join(" "), JSON.stringify(v.answers)
      ]);
      return { ok: true, scores: w.showScores ? v.scores : null };
    } finally {
      lock.releaseLock();
    }
  });
}

/* ---------------- moderator endpoints ---------------- */

var FAIL_LIMIT = 10, FAIL_WINDOW_S = 600, LOCK_S = 900;

/** Checks the workshop's moderator key, with a lockout after repeated wrong keys. */
function authModerator(p) {
  if (!isValidWorkshopCode(p.workshop)) return { ok: false, error: "bad_workshop" };
  var cache = CacheService.getScriptCache(), failKey = "fail:" + p.workshop, lockKey = "lock:" + p.workshop;
  if (cache.get(lockKey)) return { ok: false, error: "locked" };
  var stored = PropertiesService.getScriptProperties().getProperty("modkey:" + p.workshop);
  if (!keysMatch(p.key, stored)) {
    var fails = Number(cache.get(failKey) || 0) + 1;
    cache.put(failKey, String(fails), FAIL_WINDOW_S);
    if (fails >= FAIL_LIMIT) { cache.put(lockKey, "1", LOCK_S); cache.remove(failKey); }
    return { ok: false, error: "bad_key" };
  }
  cache.remove(failKey);
  var w = findWorkshop(p.workshop);
  return w ? { ok: true, workshop: w } : { ok: false, error: "unknown_workshop" };
}

function modResults(p) {
  var a = authModerator(p);
  if (!a.ok) return a;
  var w = a.workshop, sh = sheet(TAB_SUBMISSIONS), last = sh.getLastRow();
  var rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, SUBMISSION_HEAD.length).getValues();
  var fmt = function (d, tz) { return d instanceof Date ? Utilities.formatDate(d, tz, "dd/MM/yy HH:mm") : String(d); };
  var subs = rows.filter(function (r) { return r[1] === w.code; })
                 .map(function (r) { return submissionFromRow(r, "Asia/Jerusalem", fmt); });
  return { ok: true, workshop: w, submissions: subs, bands: BANDS };
}

function modSaveRoster(p) {
  var a = authModerator(p);
  if (!a.ok) return a;
  var list = cleanRoster(p.expected);
  if (!list) return { ok: false, error: "bad_roster" };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: "busy", retry: true };
  try {
    var sh = sheet(TAB_WORKSHOPS), rows = sh.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][0]).trim() === a.workshop.code) {
        sh.getRange(i + 1, 6).setValue(list.map(sheetSafe).join("\n"));
        return { ok: true, expected: list };
      }
    }
    return { ok: false, error: "unknown_workshop" };
  } finally { lock.releaseLock(); }
}

/** Wrap a handler: always JSON, never an HTML error page. */
function respond(fn) {
  var out;
  try { out = fn(); }
  catch (err) { console.error(err && err.stack || err); out = { ok: false, error: "server_error", retry: true }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- sheet helpers ---------------- */

function sheet(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error("Missing tab: " + name + " (run setup)");
  return sh;
}

function findWorkshop(code) {
  var rows = sheet(TAB_WORKSHOPS).getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === code) {
      return {
        code: code, name: String(rows[i][1] || ""),
        date: rows[i][2] instanceof Date ? Utilities.formatDate(rows[i][2], "Asia/Jerusalem", "dd/MM/yy") : String(rows[i][2] || ""),
        open: rows[i][3] === true, showScores: rows[i][4] !== false,
        expected: String(rows[i][5] || "").split("\n").map(function (s) { return s.trim().replace(/^'/, ""); }).filter(String)
      };
    }
  }
  return null;
}

function countRows(code) {
  var sh = sheet(TAB_SUBMISSIONS);
  var last = sh.getLastRow();
  if (last < 2) return 0;
  return sh.getRange(2, 2, last - 1, 1).getValues().filter(function (r) { return r[0] === code; }).length;
}

/* ---------------- Shlomo's menu (desktop Sheets) ---------------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu("שאלון אדיג'ס")
    .addItem("סדנה חדשה…", "menuNewWorkshop")
    .addItem("קישורים לסדנה קיימת…", "menuShowLinks")
    .addSeparator()
    .addItem("הגדרה ראשונית (פעם אחת)", "setup")
    .addItem("כתובת האתר…", "menuSetSiteUrl")
    .addToUi();
}

function siteUrl() { return PropertiesService.getScriptProperties().getProperty("SITE_URL") || ""; }

function menuSetSiteUrl() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt("כתובת האתר", "הכתובת של אתר השאלון (למשל https://xxxx.netlify.app):", ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var url = r.getResponseText().trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(url)) { ui.alert("כתובת לא תקינה. צריכה להתחיל ב־https://"); return; }
  PropertiesService.getScriptProperties().setProperty("SITE_URL", url);
  ui.alert("נשמר.");
}

/** The links Shlomo shares: participants get ?w=code; the moderator link adds the key after # (never sent to a server). */
function linksFor(code) {
  var base = siteUrl() || "https://<כתובת-האתר>";
  var key = PropertiesService.getScriptProperties().getProperty("modkey:" + code);
  return { participant: base + "/?w=" + code, moderator: base + "/?w=" + code + "#k=" + key };
}

function showLinks(code, title) {
  var l = linksFor(code);
  var html = HtmlService.createHtmlOutput(
    '<div dir="rtl" style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">' +
    '<p><b>קישור למשתתפים</b> (לשלוח בוואטסאפ):</p><textarea readonly style="width:100%;height:46px" onclick="this.select()">' + l.participant + '</textarea>' +
    '<p><b>קישור למנחה</b> – פרטי! לא לשלוח לאף אחד:</p><textarea readonly style="width:100%;height:62px" onclick="this.select()">' + l.moderator + '</textarea>' +
    (siteUrl() ? "" : '<p style="color:#8A1F11">עדיין לא הוגדרה כתובת האתר (תפריט ← כתובת האתר).</p>') +
    '</div>').setWidth(460).setHeight(300);
  SpreadsheetApp.getUi().showModalDialog(html, title);
}

function menuShowLinks() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt("קישורים לסדנה", "קוד הסדנה (6 תווים, מהעמודה הראשונה):", ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var code = r.getResponseText().trim().toLowerCase();
  if (!isValidWorkshopCode(code) || !findWorkshop(code)) { ui.alert("לא נמצאה סדנה עם הקוד הזה."); return; }
  ensureModKey(code);
  showLinks(code, "קישורים – " + code);
}

/** One random 32-hex-char key per workshop, kept in Script Properties (not in a cell). */
function ensureModKey(code) {
  var props = PropertiesService.getScriptProperties(), k = props.getProperty("modkey:" + code);
  if (!isWellFormedKey(k)) { k = Utilities.getUuid().replace(/-/g, "").toLowerCase(); props.setProperty("modkey:" + code, k); }
  return k;
}

/** Creates the two tabs with headers. Safe to run again: it never deletes data. */
function setup() {
  var ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone("Asia/Jerusalem");
  [[TAB_WORKSHOPS, WORKSHOP_HEAD], [TAB_SUBMISSIONS, SUBMISSION_HEAD]].forEach(function (t) {
    var sh = ss.getSheetByName(t[0]) || ss.insertSheet(t[0]);
    if (sh.getLastRow() === 0) sh.appendRow(t[1]);
    sh.setFrozenRows(1);
    sh.setRightToLeft(true);
    sh.getRange(1, 1, 1, t[1].length).setFontWeight("bold").setBackground("#EEF5E6");
  });
  var w = sheet(TAB_WORKSHOPS);
  w.getRange("D2:E").insertCheckboxes();
  w.getRange("F2:F").setWrap(true);
  var first = ss.getSheetByName("Sheet1") || ss.getSheetByName("גיליון1");
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 2) ss.deleteSheet(first);
  try { SpreadsheetApp.getUi().alert("ההגדרה הושלמה."); } catch (e) {}
}

function menuNewWorkshop() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt("סדנה חדשה", "שם הסדנה (למשל: סדנת מנהלים – חברה X):", ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK || !r.getResponseText().trim()) return;
  var code = createWorkshop(r.getResponseText().trim(), "");
  showLinks(code, "נוצרה סדנה – " + code);
}

function createWorkshop(name, date) {
  var sh = sheet(TAB_WORKSHOPS), code;
  do { code = newWorkshopCode(Math.random); } while (findWorkshop(code));
  sh.appendRow([code, sheetSafe(name), date || new Date(), true, true, ""]);
  sh.getRange(sh.getLastRow(), 4, 1, 2).insertCheckboxes().setValue(true);
  ensureModKey(code);
  return code;
}
