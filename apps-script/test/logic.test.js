// Run: node --test website/apps-script/test/
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../Logic.js");

const allP = () => Array.from({ length: 20 }, () => [0, 1, 2, 3]);
// Same balanced display order as website/index.html
const PERM = [[2,3,1,0],[0,1,3,2],[3,0,2,1],[1,2,0,3],[1,2,0,3],[3,0,2,1],[0,1,3,2],[2,3,1,0],[3,0,2,1],[2,3,1,0],
              [1,2,0,3],[0,1,3,2],[0,1,3,2],[1,2,0,3],[2,3,1,0],[3,0,2,1],[2,3,1,0],[3,0,2,1],[0,1,3,2],[1,2,0,3]];
const W = { code: "abc234", open: true, showScores: true };
const ok = (over) => Object.assign({ action: "submit", workshop: "abc234", name: "דנה כהן", answers: allP(), seconds: 300 }, over);

test("always P first scores 160/80/40/20 and totals 300", () => {
  assert.deepEqual(L.scoreAnswers(allP()), { P: 160, A: 80, E: 40, I: 20 });
});

test("top-to-bottom tapper on the balanced order scores a flat 75", () => {
  assert.deepEqual(L.scoreAnswers(PERM), { P: 75, A: 75, E: 75, I: 75 });
});

test("random valid answers always total 300, each score 20..160", () => {
  for (let k = 0; k < 2000; k++) {
    const a = Array.from({ length: 20 }, () => [0, 1, 2, 3].sort(() => Math.random() - 0.5));
    const s = L.scoreAnswers(a);
    assert.equal(s.P + s.A + s.E + s.I, 300);
    for (const t of L.TYPES) assert.ok(s[t] >= 20 && s[t] <= 160);
  }
});

test("code follows Shlomo's per-letter bands at every edge", () => {
  assert.equal(L.codeOf({ P: 82, A: 96, E: 73, I: 47 }), "Pae-");
  assert.equal(L.codeOf({ P: 81, A: 97, E: 72, I: 48 }), "pA-i");
  assert.equal(L.codeOf({ P: 67, A: 82, E: 87, I: 62 }), "--EI");
  assert.deepEqual([L.bandOf("P", 89), L.bandOf("P", 90), L.bandOf("A", 104), L.bandOf("A", 105),
                    L.bandOf("E", 94), L.bandOf("E", 95), L.bandOf("I", 69), L.bandOf("I", 70)], [2, 3, 2, 3, 2, 3, 2, 3]);
});

test("rejects answers that are not 20 full orderings", () => {
  assert.equal(L.isValidAnswers(allP()), true);
  assert.equal(L.isValidAnswers(allP().slice(0, 19)), false);                       // 19 rows
  assert.equal(L.isValidAnswers([...allP().slice(0, 19), [0, 0, 1, 2]]), false);   // repeated type
  assert.equal(L.isValidAnswers([...allP().slice(0, 19), [0, 1, 2, 4]]), false);   // out of range
  assert.equal(L.isValidAnswers([...allP().slice(0, 19), [0, 1, 2]]), false);      // short row
  assert.equal(L.isValidAnswers([...allP().slice(0, 19), ["0", 1, 2, 3]]), false); // string
  assert.equal(L.isValidAnswers([...allP().slice(0, 19), [0.5, 1, 2, 3]]), false); // fraction
  assert.equal(L.isValidAnswers("nope"), false);
});

test("validateSubmission: happy path recomputes scores and ignores client totals", () => {
  const r = L.validateSubmission(ok({ P: 999, scores: { P: 999 } }), W, 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.scores, { P: 160, A: 80, E: 40, I: 20 });
  assert.equal(r.value.code, "P---");   // A=80 is below A's lowest band (83)
});

test("validateSubmission: every rejection path", () => {
  assert.equal(L.validateSubmission(null, W, 0).error, "bad_request");
  assert.equal(L.validateSubmission(ok({ workshop: "BAD!" }), W, 0).error, "bad_workshop");
  assert.equal(L.validateSubmission(ok(), null, 0).error, "unknown_workshop");
  assert.equal(L.validateSubmission(ok(), { ...W, open: false }, 0).error, "workshop_closed");
  assert.equal(L.validateSubmission(ok(), W, L.MAX_ROWS_PER_WORKSHOP).error, "workshop_full");
  assert.equal(L.validateSubmission(ok({ name: " a " }), W, 0).error, "bad_name");
  assert.equal(L.validateSubmission(ok({ name: "x".repeat(41) }), W, 0).error, "bad_name");
  assert.equal(L.validateSubmission(ok({ answers: allP().slice(1) }), W, 0).error, "bad_answers");
});

test("names: cleaned, and formula-looking names stay text in the Sheet", () => {
  assert.equal(L.cleanName("  דנה \n  כהן "), "דנה כהן");
  assert.equal(L.sheetSafe("=HYPERLINK(\"x\")"), "'=HYPERLINK(\"x\")");
  assert.equal(L.sheetSafe("+972"), "'+972");
  assert.equal(L.sheetSafe("-AE-"), "'-AE-");
  assert.equal(L.sheetSafe("@me"), "'@me");
  assert.equal(L.sheetSafe("דנה"), "דנה");
});

test("workshop codes: generated codes are valid, junk is not", () => {
  for (let k = 0; k < 500; k++) assert.equal(L.isValidWorkshopCode(L.newWorkshopCode(Math.random)), true);
  for (const bad of ["", "abc", "abcdefg", "ABC234", "abc23l", "abc230", "abc 23"]) assert.equal(L.isValidWorkshopCode(bad), false);
});

test("moderator key: well-formed check and exact match only", () => {
  const k = "0123456789abcdef0123456789abcdef";
  assert.equal(L.keysMatch(k, k), true);
  assert.equal(L.keysMatch(k.slice(0, 31) + "0", k), false);
  assert.equal(L.keysMatch("", k), false);
  assert.equal(L.keysMatch(k.toUpperCase(), k), false);
  assert.equal(L.keysMatch(k, null), false);           // workshop without a key never opens
  assert.equal(L.keysMatch(undefined, undefined), false);
});

test("roster: cleaned, de-duplicated, capped; non-lists rejected", () => {
  assert.deepEqual(L.cleanRoster([" דנה  כהן ", "דנה כהן", "", "x", "יוסי לוי"]), ["דנה כהן", "יוסי לוי"]);
  assert.equal(L.cleanRoster("דנה"), null);
  assert.equal(L.cleanRoster(Array.from({ length: 500 }, (_, i) => "שם " + i)).length, L.MAX_ROSTER);
});

test("submission rows read back without the formula-guard quote", () => {
  const row = [new Date(), "abc234", "'=evil", 75, 75, 75, 75, "'-AE-", 300, "fast", "[]"];
  const s = L.submissionFromRow(row, "Asia/Jerusalem", () => "20/11/26 10:00");
  assert.equal(s.name, "=evil");
  assert.equal(s.code, "-AE-");
  assert.deepEqual(s.flags, ["fast"]);
});

test("suspicion flags: fast finishers and same-spot tappers", () => {
  assert.deepEqual(L.suspicionFlags(allP(), 300, PERM), []);
  assert.deepEqual(L.suspicionFlags(allP(), 60, null), ["fast"]);
  const sameSpot = PERM.map(p => p.slice());          // always the top option on screen
  assert.deepEqual(L.suspicionFlags(sameSpot, 300, PERM), ["same-spot"]);
});
