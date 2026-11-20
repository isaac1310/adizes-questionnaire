// End-to-end test against the live Apps Script web app. Usage: node e2e.mjs <workshopCode> <modKey> [lockout]
const URL_ = "https://script.google.com/macros/s/AKfycbw58fcEWjgEFWoIyg9_DQS6ZY7lC1lRJUeS6UaKAgd_OFWdQ23Qsu9fTnigzZGLE3IBJA/exec";
const [code, key, mode] = process.argv.slice(2);
const PERM = [[2,3,1,0],[0,1,3,2],[3,0,2,1],[1,2,0,3],[1,2,0,3],[3,0,2,1],[0,1,3,2],[2,3,1,0],[3,0,2,1],[2,3,1,0],
              [1,2,0,3],[0,1,3,2],[0,1,3,2],[1,2,0,3],[2,3,1,0],[3,0,2,1],[2,3,1,0],[3,0,2,1],[0,1,3,2],[1,2,0,3]];
const allP = () => Array.from({ length: 20 }, () => [0, 1, 2, 3]);
const post = async (body) => { const r = await fetch(URL_, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) });
  const t = await r.text(); try { return JSON.parse(t); } catch { return { NOT_JSON: t.slice(0, 120), status: r.status }; } };
const get = async (q) => { const r = await fetch(URL_ + q); const t = await r.text(); try { return JSON.parse(t); } catch { return { NOT_JSON: t.slice(0, 120) }; } };
const results = [];
const check = (label, got, pass) => { results.push(`${pass ? "PASS" : "FAIL"}  ${label}${pass ? "" : "  → " + JSON.stringify(got)}`); };

if (mode === "lockout") {
  let last;
  for (let i = 1; i <= 11; i++) last = await post({ action: "results", workshop: code, key: "0".repeat(32) });
  check("11th wrong key → locked", last, last.error === "locked");
  const right = await post({ action: "results", workshop: code, key });
  check("right key while locked → still locked", right, right.error === "locked");
} else {
  let r = await get("?action=ping"); check("ping", r, r.ok && r.version);
  r = await get(`?action=workshop&code=${code}`); check("workshop info (public)", r, r.ok && r.workshop.name === "סדנת בדיקה" && r.workshop.open && !("expected" in r.workshop));
  r = await get("?action=workshop&code=zzzzzz"); check("unknown workshop", r, r.error === "unknown_workshop");

  r = await post({ action: "submit", workshop: code, name: "דנה כהן", answers: allP(), seconds: 300, P: 999 });
  check("valid submit, client totals ignored", r, r.ok && r.scores.P === 160 && r.scores.A === 80);
  r = await post({ action: "submit", workshop: code, name: "=HYPERLINK(\"http://x\")", answers: PERM, seconds: 40, displayOrder: PERM });
  check("formula-looking name accepted (stored as text)", r, r.ok && r.scores.P === 75);
  r = await post({ action: "submit", workshop: code, name: "x", answers: allP() });                   check("short name rejected", r, r.error === "bad_name");
  r = await post({ action: "submit", workshop: code, name: "דנה", answers: allP().slice(1) });        check("19 rows rejected", r, r.error === "bad_answers");
  r = await post({ action: "submit", workshop: code, name: "דנה", answers: [...allP().slice(1), [0,0,1,2]] }); check("repeated type rejected", r, r.error === "bad_answers");
  r = await post({ action: "submit", workshop: "zzzzzz", name: "דנה", answers: allP() });             check("unknown workshop rejected", r, r.error === "unknown_workshop");
  r = await post({ action: "submit", workshop: "BAD!", name: "דנה", answers: allP() });               check("malformed code rejected", r, r.error === "bad_workshop");
  r = await post({ action: "nonsense" });                                                              check("unknown action rejected", r, r.error === "bad_request");
  const raw = await fetch(URL_, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{not json" }); const rt = await raw.text();
  check("broken JSON → JSON error, not an HTML page", rt, /"error":"bad_json"/.test(rt));

  r = await post({ action: "results", workshop: code, key: "f".repeat(32) });  check("wrong key rejected", r, r.error === "bad_key");
  r = await post({ action: "results", workshop: code });                       check("missing key rejected", r, r.error === "bad_key");
  r = await post({ action: "results", workshop: code, key });
  const names = (r.submissions || []).map(s => s.name);
  check("results with right key", { n: names.length }, r.ok && names.includes("דנה כהן") && names.includes("=HYPERLINK(\"http://x\")"));
  const sus = (r.submissions || []).find(s => s.name.startsWith("=HYPERLINK"));
  check("suspicious flags stored (fast + same-spot)", sus, sus && sus.flags.includes("fast") && sus.flags.includes("same-spot"));
  const dana = (r.submissions || []).find(s => s.name === "דנה כהן");
  check("code recomputed on server", dana, dana && dana.code === "P---");

  r = await post({ action: "saveRoster", workshop: code, key, expected: ["דנה כהן", " יוסי  לוי ", "דנה כהן", "=evil"] });
  check("roster saved, cleaned and de-duplicated", r, r.ok && JSON.stringify(r.expected) === JSON.stringify(["דנה כהן", "יוסי לוי", "=evil"]));
  r = await post({ action: "results", workshop: code, key });
  check("roster reads back (formula guard removed)", r.workshop && r.workshop.expected, r.ok && r.workshop.expected.includes("=evil") && r.workshop.expected.includes("יוסי לוי"));
  r = await post({ action: "saveRoster", workshop: code, key: "f".repeat(32), expected: ["x y"] }); check("roster save needs the key", r, r.error === "bad_key");
}
console.log(results.join("\n"));
console.log(`\n${results.filter(l => l.startsWith("PASS")).length}/${results.length} passed`);
