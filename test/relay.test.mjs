import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import worker, { expire } from "../src/worker.js";
import { checkIndex, checkPage } from "../publish/lib.mjs";
import { ROW_CAP, WEEK_ROW_CAP, cellsOf } from "../src/report.js";
import { weekFrom } from "../src/week.js";
import { post, report, seed, startRelay } from "./helpers.mjs";

let relay;
const rows = async () => (await relay.db.prepare("SELECT week, cell, n FROM cells ORDER BY cell").all()).results;

before(async () => { relay = await startRelay(); });
after(async () => { await relay.mf.dispose(); });
beforeEach(async () => {
  await relay.db.prepare("DELETE FROM cells").run();
  await relay.db.prepare("DELETE FROM weeks").run();
});

test("a good report adds one per entry and answers 204 with no body", async () => {
  const response = await post(relay.url, report());
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual((await rows()).map((row) => row.n), [1, 1]);
  await post(relay.url, report());
  assert.deepEqual((await rows()).map((row) => row.n), [2, 2]);
});

test("a calls_out result gets its own counter, and only on a calibrated stack", async () => {
  const value = report({ results: [{ entry: "volte:on", result: "calls_out" }] });
  assert.equal((await post(relay.url, value)).status, 204);
  assert.deepEqual((await rows()).map((row) => row.cell.split(".").at(-1)), ["calls_out"]);
  const other = report({ results: value.results, device: { ...report().device, ims_stack: "phh_ims" } });
  assert.equal((await post(relay.url, other)).status, 400);
  assert.equal((await rows()).length, 1);
});

test("a bad body is refused whole and stores nothing", async () => {
  const bad = [
    report({ extra: 1 }),
    report({ results: [{ entry: "volte:on", result: "signed_in" }, { entry: "apn:sos|emergency|IP", result: "works" }] }),
    report({ week: weekFrom(Date.now(), -2) }),
    "{",
    "[]",
    "null",
  ];
  for (const body of bad) assert.equal((await post(relay.url, body)).status, 400);
  assert.deepEqual(await rows(), []);
});

test("wrong type, method, path and size are refused", async () => {
  assert.equal((await post(relay.url, report(), { "content-type": "text/plain" })).status, 415);
  assert.equal((await fetch(`${relay.url}/v1/week-report`)).status, 405);
  assert.equal((await fetch(`${relay.url}/`)).status, 404);
  assert.equal((await fetch(`${relay.url}/v1/closed`, { method: "POST" })).status, 405);
  assert.equal((await post(relay.url, JSON.stringify(report()) + " ".repeat(4096))).status, 413);
  assert.deepEqual(await rows(), []);
});

test("a body of 4096 bytes with 16 long row keys fits", async () => {
  const entry = (i) => `apn:${String(i).padStart(2, "0")}${"a".repeat(61)}|default,mms,supl|IPV4V6`;
  const value = report({ results: Array.from({ length: 16 }, (_, i) => ({ entry: entry(i), result: "works" })) });
  const body = JSON.stringify(value);
  assert.ok(body.length > 2048 && body.length <= 4096, `body is ${body.length}`);
  assert.equal((await post(relay.url, body)).status, 204);
  assert.equal((await rows()).length, 16);
});

test("a counter stops at 500", async () => {
  const value = report({ results: [{ entry: "volte:on", result: "signed_in" }] });
  const [cell] = await cellsOf(value);
  await relay.db.prepare("INSERT INTO weeks (week, cells) VALUES (?, 1)").bind(value.week).run();
  await relay.db.prepare("INSERT INTO cells (week, cell, n) VALUES (?, ?, ?)").bind(value.week, cell, ROW_CAP - 1).run();
  assert.equal((await post(relay.url, value)).status, 204);
  assert.equal((await post(relay.url, value)).status, 204);
  assert.deepEqual((await rows()).map((row) => row.n), [ROW_CAP]);
});

test("a full week takes no new row, and its old rows still count", async () => {
  const value = report({ results: [{ entry: "volte:on", result: "signed_in" }] });
  await post(relay.url, value);
  await relay.db.prepare("UPDATE weeks SET cells = ?").bind(WEEK_ROW_CAP).run();
  assert.equal((await post(relay.url, value)).status, 204);
  assert.equal((await post(relay.url, report({ results: [{ entry: "vowifi:on", result: "signed_in" }] }))).status, 204);
  assert.deepEqual((await rows()).map((row) => row.n), [2]);
});

test("the store holds counters only: no model, carrier, entry or address in clear", async () => {
  await post(relay.url, report());
  const dump = JSON.stringify([await rows(), (await relay.db.prepare("SELECT * FROM weeks").all()).results]);
  for (const text of ["SM-G981B", "open.26203", "volte", "internet", "127.0.0.1"]) assert.equal(dump.includes(text), false, text);
  const tables = (await relay.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'").all()).results;
  assert.deepEqual(tables.map((table) => table.name).sort(), ["cells", "weeks"]);
  assert.equal(/ip|addr|header|agent|country|time|body/i.test(tables.map((table) => table.sql).join(" ")), false);
});

test("the public read serves closed weeks at or above the threshold, and no open week", async () => {
  const open = weekFrom(Date.now(), -1);
  const closed = weekFrom(Date.now(), -2);
  await seed(relay.db, open, report(), 9);
  await seed(relay.db, closed, report(), 3);
  await seed(relay.db, closed, report({ carrier: "262-03" }), 2);
  const index = await (await fetch(`${relay.url}/v1/closed`)).json();
  assert.deepEqual(index.weeks, [closed]);
  assert.equal((await fetch(`${relay.url}/v1/closed/${open}`)).status, 404);
  const page = await (await fetch(`${relay.url}/v1/closed/${closed}`)).json();
  assert.equal(page.cells.length, 2);
  assert.ok(page.cells.every((cell) => cell.n === 3));
  assert.equal(page.next, null);
  assert.equal(JSON.stringify(page).includes("SM-G981B"), false);
  assert.deepEqual(checkIndex(index, Date.now()), [closed]);
  assert.equal(checkPage(page, closed).length, 2);
});

test("the public read pages through a large week", async () => {
  const week = weekFrom(Date.now(), -2);
  await relay.db.prepare("INSERT INTO weeks (week) VALUES (?)").bind(week).run();
  const insert = relay.db.prepare("INSERT INTO cells (week, cell, n) VALUES (?, ?, 3)");
  const cell = (i) => `${i.toString(16).padStart(32, "0")}.${"a".repeat(32)}.lineageos.16.aosp_imsstack.${"b".repeat(32)}.works`;
  await relay.db.batch(Array.from({ length: 1500 }, (_, i) => insert.bind(week, cell(i))));
  const first = await (await fetch(`${relay.url}/v1/closed/${week}`)).json();
  assert.equal(first.cells.length, 1000);
  const second = await (await fetch(`${relay.url}/v1/closed/${week}?after=${first.next}`)).json();
  assert.equal(second.cells.length, 500);
  assert.equal(second.next, null);
  assert.equal((await fetch(`${relay.url}/v1/closed/${week}?after=${"%27"}`)).status, 400);
});

test("the cron deletes everything 8 weeks old, published or not", async () => {
  const now = Date.now();
  await seed(relay.db, weekFrom(now, -8), report(), 9);
  await seed(relay.db, weekFrom(now, -7), report(), 1);
  const scheduled = await (await relay.mf.getWorker()).scheduled({ scheduledTime: new Date(now), cron: "17 3 * * *" });
  assert.equal(scheduled.outcome, "ok");
  const left = await rows();
  assert.equal(left.length, 2);
  assert.ok(left.every((row) => row.week === weekFrom(now, -7)));
  const weeks = (await relay.db.prepare("SELECT week FROM weeks").all()).results;
  assert.deepEqual(weeks, [{ week: weekFrom(now, -7) }]);
});

test("fails closed: any store failure is a 503 with an empty body", async () => {
  const env = { DB: { prepare() { throw new Error("D1_ERROR: daily limit exceeded"); } } };
  const response = await worker.fetch(new Request("https://relay.test/v1/week-report", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report()),
  }), env);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "");
  const read = await worker.fetch(new Request("https://relay.test/v1/closed"), env);
  assert.equal(read.status, 503);
  await assert.rejects(expire(env, Date.now()));
});

test("the source has no log line, no address or header read, no GitHub credential", () => {
  for (const file of ["src/worker.js", "src/report.js", "src/week.js"]) {
    const source = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.equal(/console\.|CF-Connecting|X-Forwarded|X-Real-IP|User-Agent|request\.cf|\.cf\b|GITHUB|api\.github|fetch\(/i.test(source.replace(/async fetch\(request, env\)/, "")), false, file);
  }
  const reads = [...readFileSync("src/worker.js", "utf8").matchAll(/headers\.get\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(reads.sort(), ["content-length", "content-type"]);
});

test("wrangler.toml turns on no log, trace or export", () => {
  const config = readFileSync("wrangler.toml", "utf8");
  assert.match(config, /^logpush = false$/m);
  assert.match(config, /^\[observability\]\nenabled = false$/m);
  assert.match(config, /^preview_urls = false$/m);
  assert.equal(/tail_consumers|analytics_engine|\[vars\]|\[\[r2/.test(config), false);
});
