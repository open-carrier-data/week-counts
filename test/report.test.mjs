import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CALIBRATED_STACKS, IMS_STACKS, MAX_RESULTS, RESULTS, ROM_FAMILIES, entryAllowed, reportAllowed } from "../src/report.js";
import { isClosed, monthOfWeek, mondayOfWeek, weekFrom, weekOf, weeksOfMonth } from "../src/week.js";
import { report } from "./helpers.mjs";

const NOW = Date.now();
const refused = (change) => {
  const value = report();
  change(value);
  assert.equal(reportAllowed(value, NOW), false);
};

test("the closed report passes, and nothing else does", () => {
  assert.equal(reportAllowed(report(), NOW), true);
  refused((r) => { r.extra = 1; });
  refused((r) => { delete r.app_version; });
  refused((r) => { r.schema_version = 2; });
  refused((r) => { r.device.codename = "x1s"; });
  refused((r) => { r.device.build = "CP2A 1792814506"; });
  refused((r) => { r.plan = "unknown"; });
  refused((r) => { r.results[0].bearer = "lte"; });
  refused((r) => { r.results[0].reason = "x"; });
  refused((r) => { r.spn = "x"; });
  refused((r) => { r.id = "abc"; });
});

test("week: only this one or the last", () => {
  assert.equal(reportAllowed(report({ week: weekFrom(NOW, -1) }), NOW), true);
  refused((r) => { r.week = weekFrom(NOW, -2); });
  refused((r) => { r.week = weekFrom(NOW, 1); });
  refused((r) => { r.week = "2026-11-04"; });
});

test("app_version is major.minor, carrier is a profile ID or a network", () => {
  refused((r) => { r.app_version = "0.5.1"; });
  refused((r) => { r.carrier = "Vodafone"; });
  refused((r) => { r.carrier = "26203"; });
  assert.equal(reportAllowed(report({ carrier: "262-03" }), NOW), true);
  assert.equal(reportAllowed(report({ carrier: "fill.26203.0123456789ab" }), NOW), true);
});

test("results: 1 to 16, each entry once, closed words", () => {
  refused((r) => { r.results = []; });
  refused((r) => { r.results = Array.from({ length: MAX_RESULTS + 1 }, (_, i) => ({ entry: `apn:a${i}|default|IP`, result: "works" })); });
  refused((r) => { r.results.push({ ...r.results[0] }); });
  refused((r) => { r.results[0].result = "not_tested"; });
  refused((r) => { r.results[0].entry = "wifi_calling_key:on"; });
});

test("no emergency row, however it is typed", () => {
  assert.equal(entryAllowed("apn:sos|emergency|IPV4V6"), false);
  assert.equal(entryAllowed("apn:sos|default,emergency|IPV4V6"), false);
  assert.equal(entryAllowed("apn:internet|default,supl|IPV4V6"), true);
  assert.equal(entryAllowed("apn:internet|default,supl|"), true);
});

test("an uncalibrated stack sends no works and no failed (SM8)", () => {
  for (const stack of IMS_STACKS.filter((name) => !CALIBRATED_STACKS.includes(name))) {
    for (const result of ["works", "failed"]) refused((r) => { r.device.ims_stack = stack; r.results = [{ entry: "volte:on", result }]; });
    const fine = report();
    fine.device.ims_stack = stack;
    fine.results = [{ entry: "volte:on", result: "signed_in" }];
    assert.equal(reportAllowed(fine, NOW), true);
  }
});

test("the published schema says what the Worker enforces", () => {
  const schema = JSON.parse(readFileSync("schemas/ocd-week-report.schema.json", "utf8"));
  const { device } = schema.properties;
  assert.deepEqual(device.properties.rom_family.enum, ROM_FAMILIES);
  assert.deepEqual(device.properties.ims_stack.enum, IMS_STACKS);
  assert.deepEqual(schema.properties.results.items.properties.result.enum, RESULTS);
  assert.equal(schema.properties.results.maxItems, MAX_RESULTS);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...schema.required].sort());
});

test("ISO weeks at the year's edges", () => {
  assert.equal(weekOf(Date.UTC(2026, 11, 31)), "2026-W53");
  assert.equal(weekOf(Date.UTC(2027, 0, 3)), "2026-W53");
  assert.equal(weekOf(Date.UTC(2027, 0, 4)), "2027-W01");
  assert.equal(weekOf(Date.UTC(2021, 0, 3)), "2020-W53");
  assert.equal(weekOf(Date.UTC(2026, 10, 4)), "2026-W45");
  assert.equal(mondayOfWeek("2025-W53"), null);
  assert.equal(mondayOfWeek("2026-W00"), null);
  assert.equal(new Date(mondayOfWeek("2026-W45")).toISOString().slice(0, 10), "2026-11-02");
  assert.equal(weekFrom(Date.UTC(2027, 0, 5), -1), "2026-W53");
  assert.equal(monthOfWeek("2026-W53"), "2026-12");
  assert.equal(monthOfWeek("2026-W44"), "2026-10");
  assert.deepEqual(weeksOfMonth("2026-11"), ["2026-W45", "2026-W46", "2026-W47", "2026-W48"]);
  assert.deepEqual(weeksOfMonth("2026-12").at(-1), "2026-W53");
  for (let m = 1; m <= 12; m += 1) assert.ok(weeksOfMonth(`2026-${String(m).padStart(2, "0")}`).length >= 4);
});

test("a week closes only when no report can still name it", () => {
  const now = Date.UTC(2026, 10, 4);
  assert.equal(isClosed("2026-W45", now), false);
  assert.equal(isClosed("2026-W44", now), false);
  assert.equal(isClosed("2026-W43", now), true);
});
