// What the publish step decides, with no network and no clock of its own.
// Everything from the relay is untrusted until it has passed the closed shape,
// the threshold, the cap hold, OCD's public lists and the privacy scan.

import { KEEP_WEEKS, ROW_CAP, THRESHOLD, FEATURES, digestOf, entryAllowed, parseCell } from "../src/report.js";
import { isClosed, monthOfWeek, mondayOfWeek, weekFrom, weeksOfMonth } from "../src/week.js";
import { scanValue } from "./privacy-scan.mjs";

export const LABEL = "automatic, reported by phones, not checked by OCD, counts can be faked";
export const RESULTS_FILE = "results/automatic.json";
export const STATUS_FILE = "status.txt";

export const DESCRIPTION =
  "Weekly counts from phones whose owner said yes to OCD Android's question, as device > carrier > plan, by month " +
  "(OCD rule round 48). A row appears only with at least 3 reports in one ISO week, and each count is a number of " +
  `weekly reports, not of phones or people. Every row reads "${LABEL}". Anyone can send such a report. A row says what ` +
  "reports claimed, not what a carrier or tariff offers. Plan is always unknown. Phones and ROM builds never read this " +
  "file, it sets no carrier value, and its counts are never added to the reports in OCD's observed/ folder.";

export class Refused extends Error {}

const sameKeys = (value, keys) =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();

export function emptyDocument() {
  return { schema: "ocd-automatic-results", schema_version: 1, description: DESCRIPTION, months: [], devices: [] };
}

/** The relay's list of closed weeks, closed shape or refused. */
export function checkIndex(index, nowMs) {
  if (!sameKeys(index, ["schema", "schema_version", "threshold", "row_cap", "weeks"])) throw new Refused("the relay's list has another shape");
  if (index.schema !== "ocd-relay-closed" || index.schema_version !== 1) throw new Refused("the relay's list is another schema");
  if (index.threshold !== THRESHOLD || index.row_cap !== ROW_CAP) throw new Refused("the relay names another threshold or cap");
  if (!Array.isArray(index.weeks)) throw new Refused("the relay's list has no weeks");
  for (const week of index.weeks) {
    if (typeof week !== "string" || mondayOfWeek(week) === null || !isClosed(week, nowMs)) throw new Refused("the relay names a week that is not closed");
  }
  return index.weeks;
}

/** One page of a week, closed shape or refused. */
export function checkPage(page, week) {
  if (!sameKeys(page, ["schema", "schema_version", "week", "cells", "next"])) throw new Refused("a page of the relay has another shape");
  if (page.schema !== "ocd-relay-closed-week" || page.schema_version !== 1 || page.week !== week) throw new Refused("a page of the relay is another schema or week");
  if (!Array.isArray(page.cells) || (page.next !== null && typeof page.next !== "string")) throw new Refused("a page of the relay has no cells");
  return page.cells.map((item) => {
    const cell = sameKeys(item, ["cell", "n"]) ? parseCell(item.cell) : null;
    if (cell === null || !Number.isInteger(item.n) || item.n < 1 || item.n > ROW_CAP) throw new Refused("a cell of the relay has another shape");
    return { ...cell, n: item.n };
  });
}

/** The months to publish now: all their weeks closed, none past the relay's 8 weeks, not published before. */
export function monthsDue(closedWeeks, published, nowMs) {
  const due = [];
  const missed = [];
  const waiting = [];
  for (const month of [...new Set(closedWeeks.map(monthOfWeek))].sort()) {
    if (published.includes(month)) continue;
    const weeks = weeksOfMonth(month);
    if (!isClosed(weeks[weeks.length - 1], nowMs)) waiting.push(month);
    else if (weeks[0] <= weekFrom(nowMs, -KEEP_WEEKS)) missed.push(month);
    else due.push(month);
  }
  return { due, missed, waiting };
}

/**
 * OCD's public lists as the publish step needs them. `models` from
 * generated/devices/android.json; `networks` from generated/ocd-dataset/profiles.json;
 * `index` and `xml` from apn-index.json and apns-conf.xml, read at one commit.
 */
export function readLists({ android, profiles, index, xml }) {
  const models = new Set(["other"]);
  for (const device of android.devices) for (const model of device.models ?? []) models.add(model);

  const carriers = new Set();
  for (const [network, { profiles: list }] of Object.entries(profiles.networks)) {
    carriers.add(network.replace("-", ""));
    for (const profile of list) carriers.add(profile.id);
  }

  const lines = xml.split("\n");
  const rowsOf = new Map();
  const add = (carrier, entry) => {
    if (!rowsOf.has(carrier)) rowsOf.set(carrier, new Set());
    rowsOf.get(carrier).add(entry);
  };
  for (const row of index.rows) {
    const apn = attributes(lines[row.line - 1] ?? "");
    if (apn === null) throw new Refused("apn-index.json and apns-conf.xml disagree");
    const entry = `apn:${apnKey(apn)}`;
    if (!entryAllowed(entry)) continue;
    add(`${apn.mcc}${apn.mnc}`, entry);
    for (const profile of row.profiles) add(profile, entry);
  }
  return { models, carriers, rowsOf };
}

function attributes(line) {
  if (!line.trimStart().startsWith("<apn ")) return null;
  const found = {};
  for (const [, name, value] of line.matchAll(/([a-z_]+)="([^"]*)"/g)) found[name] = value;
  return found;
}

const unescapeXml = (text) =>
  text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name]);

/** The row key of tools/observed_reports.py: lower-case APN, sorted lower-case types, upper-case protocol. */
function apnKey(apn) {
  const types = unescapeXml(apn.type ?? "").split(",").map((type) => type.trim().toLowerCase()).filter(Boolean);
  types.sort();
  return `${unescapeXml(apn.apn ?? "").toLowerCase()}|${types.join(",")}|${(apn.protocol ?? "").toUpperCase()}`;
}

/** Digest back to value, for every value on OCD's lists. A digest on no list stays unreadable. */
export async function digestTables({ models, carriers, rowsOf }) {
  const table = async (kind, values) => {
    const map = new Map();
    for (const value of values) map.set(await digestOf(kind, value), value);
    return map;
  };
  const features = FEATURES.flatMap((feature) => [`${feature}:on`, `${feature}:off`]);
  const rows = new Set();
  for (const set of rowsOf.values()) for (const row of set) rows.add(row);
  return {
    device: await table("device", models),
    carrier: await table("carrier", carriers),
    entry: await table("entry", [...features, ...rows]),
  };
}

/** The rows of one month from its weeks' cells, with what was left out and why. */
export function monthRows(month, weeks, tables, lists) {
  const tally = { rows: 0, held_at_cap: 0, below_threshold: 0, not_on_a_list: 0, privacy: 0 };
  const rows = new Map();
  for (const cells of weeks) {
    for (const cell of cells) {
      // A row jumping from nothing to the cap is at the cap too: one hold covers both.
      if (cell.n >= ROW_CAP) { tally.held_at_cap += 1; continue; }
      if (cell.n < THRESHOLD) { tally.below_threshold += 1; continue; }
      const model = tables.device.get(cell.device);
      const carrier = tables.carrier.get(cell.carrier);
      const entry = tables.entry.get(cell.entry);
      const held = entry?.startsWith("apn:") ? lists.rowsOf.get(carrier)?.has(entry) === true : entry !== undefined;
      if (model === undefined || carrier === undefined || !held) { tally.not_on_a_list += 1; continue; }
      const row = { model, carrier, rom_family: cell.rom_family, android_major: cell.android_major, ims_stack: cell.ims_stack, entry, result: cell.result };
      if (scanValue(row).length > 0) { tally.privacy += 1; continue; }
      const key = JSON.stringify(row);
      rows.set(key, { ...row, month, reports: (rows.get(key)?.reports ?? 0) + cell.n, status: LABEL });
    }
  }
  tally.rows = rows.size;
  return { rows: [...rows.values()], tally };
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `document` with the month's rows in the tree device > carrier > plan. */
export function addMonth(document, month, rows) {
  const flat = [...flatten(document), ...rows];
  const devices = new Map();
  for (const { model, carrier, ...row } of flat) {
    if (!devices.has(model)) devices.set(model, new Map());
    const carriers = devices.get(model);
    if (!carriers.has(carrier)) carriers.set(carrier, []);
    carriers.get(carrier).push(row);
  }
  const order = (a, b) => byText(JSON.stringify(a), JSON.stringify(b));
  return {
    ...document,
    months: [...document.months, month].sort(),
    devices: [...devices.keys()].sort(byText).map((model) => ({
      model,
      carriers: [...devices.get(model).keys()].sort(byText).map((carrier) => ({
        carrier,
        plans: [{ plan: "unknown", rows: devices.get(model).get(carrier).sort(order) }],
      })),
    })),
  };
}

function flatten(document) {
  return document.devices.flatMap(({ model, carriers }) =>
    carriers.flatMap(({ carrier, plans }) => plans.flatMap(({ rows }) => rows.map((row) => ({ model, carrier, ...row })))),
  );
}

/** The file as it is written. Refused whole when any string fails the privacy scan or any row lost its label. */
export function render(document) {
  if (scanValue({ months: document.months, devices: document.devices }).length > 0) throw new Refused("the file failed the privacy scan");
  if (flatten(document).some((row) => row.status !== LABEL)) throw new Refused("a row lost its label");
  return `${JSON.stringify(document, null, 2)}\n`;
}
