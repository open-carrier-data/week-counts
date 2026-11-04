import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { LABEL, Refused, addMonth, checkIndex, checkPage, emptyDocument, monthsDue, readLists, render } from "../publish/lib.mjs";
import { scanText, scanValue } from "../publish/privacy-scan.mjs";
import { publish } from "../publish/run.mjs";
import { ROW_CAP } from "../src/report.js";
import { weekFrom, weekOf, weeksOfMonth } from "../src/week.js";
import { report, seed, startRelay } from "./helpers.mjs";

const PROFILE = "open.26203.0123456789ab";
const lists = () => ({
  android: { devices: [{ models: ["SM-G981B", "SM-G980F"] }, {}] },
  profiles: { networks: { "262-03": { profiles: [{ id: PROFILE }] } } },
  index: { rows: [
    { line: 2, profiles: [PROFILE] },
    { line: 3, profiles: [PROFILE] },
    { line: 4, profiles: ["open.20404.0123456789ab"] },
  ] },
  xml: [
    "<apns>",
    '  <apn apn="internet" mcc="262" mnc="03" protocol="IPV4V6" type="supl,default" />',
    '  <apn apn="sos" mcc="262" mnc="03" protocol="IPV4V6" type="emergency" />',
    '  <apn apn="other.apn" mcc="204" mnc="04" protocol="IP" type="default" />',
    "</apns>",
  ].join("\n"),
});

// Tuesday 2026-12-15: November's weeks are closed and within 8 weeks of it.
const NOW = Date.UTC(2026, 11, 15, 5);
const MONTH = "2026-11";
const WEEKS = weeksOfMonth(MONTH);

let relay;
let root;

before(async () => { relay = await startRelay(); });
after(async () => { await relay.mf.dispose(); });
beforeEach(async () => {
  await relay.db.prepare("DELETE FROM cells").run();
  await relay.db.prepare("DELETE FROM weeks").run();
  root = mkdtempSync(join(tmpdir(), "week-counts-"));
  (await import("node:fs")).mkdirSync(join(root, "results"));
});

// The relay in workerd runs on today's clock, where these weeks are closed or
// not by the real date, so the publish step reads a stand-in for the same answers.
const standIn = async () => {
  const { createServer } = await import("node:http");
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    let body;
    if (url.pathname === "/v1/closed") {
      const { results } = await relay.db.prepare("SELECT week FROM weeks ORDER BY week").all();
      body = { schema: "ocd-relay-closed", schema_version: 1, threshold: 3, row_cap: ROW_CAP, weeks: results.map((row) => row.week) };
    } else {
      const week = url.pathname.split("/").at(-1);
      const { results } = await relay.db.prepare("SELECT cell, n FROM cells WHERE week = ? AND n >= 3 ORDER BY cell").bind(week).all();
      body = { schema: "ocd-relay-closed-week", schema_version: 1, week, cells: results, next: null };
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
};

const run = async (nowMs = NOW) => {
  const server = await standIn();
  try {
    return await publish({ root, nowMs, relay: server.url, lists: async () => lists() });
  } finally {
    server.close();
  }
};
const file = () => JSON.parse(readFileSync(join(root, "results/automatic.json"), "utf8"));
const allRows = (document) => document.devices.flatMap((d) => d.carriers.flatMap((c) => c.plans.flatMap((p) => p.rows.map((r) => ({ model: d.model, carrier: c.carrier, plan: p.plan, ...r })))));

test("a row with 3 reports in one week is published by month, under device > carrier > plan unknown", async () => {
  await seed(relay.db, WEEKS[0], report({ week: WEEKS[0] }), 3);
  await seed(relay.db, WEEKS[1], report({ week: WEEKS[1] }), 4);
  const line = await run();
  assert.match(line, /^2026-12-15 /);
  const rows = allRows(file());
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.plan === "unknown" && row.month === MONTH && row.reports === 7 && row.status === LABEL));
  assert.deepEqual(rows.map((row) => row.entry).sort(), ["apn:internet|default,supl|IPV4V6", "volte:on"]);
  assert.deepEqual(file().months, [MONTH]);
  const text = readFileSync(join(root, "results/automatic.json"), "utf8");
  assert.equal(/week|W4/.test(JSON.stringify(rows)), false, "no week in a row");
  assert.equal(/anonym/i.test(text), false);
});

test("calls_out is published as its own row, beside works", async () => {
  const one = (result) => report({ week: WEEKS[0], results: [{ entry: "volte:on", result }] });
  await seed(relay.db, WEEKS[0], one("calls_out"), 3);
  await seed(relay.db, WEEKS[0], one("works"), 4);
  await run();
  assert.deepEqual(allRows(file()).map((row) => `${row.result} ${row.reports}`).sort(), ["calls_out 3", "works 4"]);
});

test("2 reports a week stay out, even when the month adds up to more", async () => {
  await seed(relay.db, WEEKS[0], report({ week: WEEKS[0] }), 2);
  await seed(relay.db, WEEKS[1], report({ week: WEEKS[1] }), 2);
  await run();
  assert.equal(existsSync(join(root, "results/automatic.json")) ? allRows(file()).length : 0, 0);
});

test("a row at the cap is held that week; its other weeks stay", async () => {
  await seed(relay.db, WEEKS[0], report({ week: WEEKS[0] }), ROW_CAP);
  await seed(relay.db, WEEKS[1], report({ week: WEEKS[1] }), 5);
  const line = await run();
  assert.ok(allRows(file()).every((row) => row.reports === 5));
  assert.match(line, /2 held at the cap/);
});

test("values on no public list are dropped: model, carrier, APN row of another carrier, emergency row", async () => {
  const week = WEEKS[0];
  await seed(relay.db, week, report({ week, device: { ...report().device, model: "01511234567" } }), 9);
  await seed(relay.db, week, report({ week, carrier: "open.26203.ffffffffffff" }), 9);
  const one = (entry) => report({ week, results: [{ entry, result: "works" }] });
  await seed(relay.db, week, one("apn:other.apn|default|IP"), 9);
  await seed(relay.db, week, one("apn:sos|emergency|IPV4V6"), 9);
  await seed(relay.db, week, one("apn:made.up.row|default|IP"), 9);
  await seed(relay.db, week, report({ week, carrier: "262-03", results: [{ entry: "apn:internet|default,supl|IPV4V6", result: "works" }] }), 3);
  await seed(relay.db, week, report({ week, device: { ...report().device, model: "other" }, results: [{ entry: "vonr:on", result: "signed_in" }] }), 3);
  const line = await run();
  const rows = allRows(file());
  assert.deepEqual(rows.map((row) => `${row.model} ${row.carrier} ${row.entry}`).sort(), [
    `SM-G981B 262-03 apn:internet|default,supl|IPV4V6`,
    `other ${PROFILE} vonr:on`,
  ]);
  assert.match(line, /7 not on a list/);
  assert.equal(readFileSync(join(root, "results/automatic.json"), "utf8").includes("01511234567"), false);
});

test("the emergency row is never on the lists", () => {
  const held = readLists(lists());
  assert.deepEqual([...held.rowsOf.get(PROFILE)], ["apn:internet|default,supl|IPV4V6"]);
  assert.deepEqual([...held.rowsOf.get("262-03")], ["apn:internet|default,supl|IPV4V6"]);
});

test("a month waits until its last week is closed, then is published once", async () => {
  await seed(relay.db, WEEKS[0], report({ week: WEEKS[0] }), 3);
  const early = Date.UTC(2026, 10, 30, 5); // Week 49 starts: week 48 can still take reports.
  assert.match(await run(early), /1 month\(s\) still open/);
  assert.equal(existsSync(join(root, "results/automatic.json")), false);
  await run();
  assert.equal(file().months.length, 1);
  const first = readFileSync(join(root, "results/automatic.json"), "utf8");
  await run(NOW + 7 * 86_400_000);
  assert.equal(readFileSync(join(root, "results/automatic.json"), "utf8"), first);
});

test("months published earlier stay when a later one comes", () => {
  const row = (month) => ({ model: "SM-G981B", carrier: PROFILE, rom_family: "lineageos", android_major: 16, ims_stack: "aosp_imsstack", entry: "volte:on", result: "signed_in", month, reports: 3, status: LABEL });
  const both = addMonth(addMonth(emptyDocument(), "2026-10", [row("2026-10")]), "2026-11", [row("2026-11")]);
  assert.deepEqual(both.months, ["2026-10", "2026-11"]);
  assert.deepEqual(allRows(both).map((r) => r.month), ["2026-10", "2026-11"]);
  assert.equal(both.devices.length, 1);
});

test("a month past the relay's 8 weeks is reported, never published in part", () => {
  const { due, missed } = monthsDue(WEEKS, [], Date.UTC(2027, 0, 20));
  assert.deepEqual(due, []);
  assert.deepEqual(missed, [MONTH]);
});

test("anything of another shape from the relay stops the run and publishes nothing", async () => {
  const now = NOW;
  const closed = weekFrom(now, -2);
  assert.throws(() => checkIndex({ schema: "ocd-relay-closed", schema_version: 1, threshold: 3, row_cap: ROW_CAP, weeks: [], extra: 1 }, now), Refused);
  assert.throws(() => checkIndex({ schema: "ocd-relay-closed", schema_version: 1, threshold: 1, row_cap: ROW_CAP, weeks: [] }, now), Refused);
  assert.throws(() => checkIndex({ schema: "ocd-relay-closed", schema_version: 1, threshold: 3, row_cap: ROW_CAP, weeks: [weekOf(now)] }, now), Refused);
  const page = (cells) => ({ schema: "ocd-relay-closed-week", schema_version: 1, week: closed, cells, next: null });
  assert.throws(() => checkPage(page([{ cell: "call +4915112345678 now", n: 3 }]), closed), Refused);
  assert.throws(() => checkPage(page([{ cell: `${"a".repeat(32)}.${"a".repeat(32)}.lineageos.16.aosp_imsstack.${"a".repeat(32)}.works`, n: 501 }]), closed), Refused);
  const status = await publish({ root, nowMs: now, relay: "https://evil.example", lists: async () => lists() });
  assert.match(status, /nothing published: relay-url.txt is not the relay's address/);
  assert.equal(existsSync(join(root, "results/automatic.json")), false);
});

test("a run with no relay or a dead one still writes a status line, and names no relay text", async () => {
  const none = await publish({ root, nowMs: NOW, relay: null });
  assert.equal(none, "2026-12-15 no relay deployed yet\n");
  assert.equal(readFileSync(join(root, "status.txt"), "utf8"), none);
  const dead = await publish({ root, nowMs: NOW, relay: "http://127.0.0.1:9" });
  assert.equal(dead, "2026-12-15 nothing published: a read failed\n");
});

test("the real relay in workerd feeds the same step", async () => {
  // Today's clock on both sides: the closed week of two weeks ago, its month not yet settled or settled alike.
  const now = Date.now();
  const closed = weekFrom(now, -2);
  await seed(relay.db, closed, report({ week: closed }), 3);
  const line = await publish({ root, nowMs: now, relay: relay.url, lists: async () => lists() });
  assert.match(line, /1 closed week\(s\)/);
});

test("the privacy scan catches what the report path's scan catches", () => {
  assert.deepEqual(scanText("a@b.de"), ["email"]);
  assert.deepEqual(scanText("+4915112345678"), ["international_phone"]);
  assert.deepEqual(scanText("0151 12345678"), ["national_phone"]);
  assert.deepEqual(scanText("123456789012345"), ["long_decimal_identity"]);
  assert.deepEqual(scanText("sip:me@ims.example").includes("sip_or_tel_uri"), true);
  assert.deepEqual(scanText("10.0.0.1"), ["ipv4_address"]);
  assert.deepEqual(scanValue({ imsi: "x" }), ["blocked_key"]);
  assert.deepEqual(scanValue({ carrier: "open.26203.012345678901", model: "SM-G981B", entry: "apn:internet|default,supl|IPV4V6", result: "works" }), []);
});

test("render refuses a file that fails the scan or lost its label", () => {
  const row = { model: "SM-G981B", carrier: PROFILE, rom_family: "lineageos", android_major: 16, ims_stack: "aosp_imsstack", entry: "volte:on", result: "signed_in", month: MONTH, reports: 3, status: LABEL };
  assert.ok(render(addMonth(emptyDocument(), MONTH, [row])).includes(LABEL));
  assert.throws(() => render(addMonth(emptyDocument(), MONTH, [{ ...row, status: "works" }])), Refused);
  assert.throws(() => render(addMonth(emptyDocument(), MONTH, [{ ...row, model: "+4915112345678" }])), Refused);
});
