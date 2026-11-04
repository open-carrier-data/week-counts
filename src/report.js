// The closed schema ocd-week-report v1 (OCD rule round 48, item 2). Anything
// that is not exactly this is refused whole. schemas/ocd-week-report.schema.json
// says the same for readers; test/report.test.mjs holds the two together.

import { weekFrom } from "./week.js";

export const MAX_BODY_BYTES = 4096;
export const MAX_RESULTS = 16;
/** A row of counts stops here for the week, and such a row is not published. */
export const ROW_CAP = 500;
/** A week takes no new rows past this. */
export const WEEK_ROW_CAP = 50_000;
/** Below this many reports in one ISO week a row is never served or published. */
export const THRESHOLD = 3;
/** The week this far back and older is deleted: 8 weeks. */
export const KEEP_WEEKS = 8;

export const ROM_FAMILIES = ["stock", "lineageos", "other"];
export const IMS_STACKS = ["phh_ims", "samsung_ims", "aosp_imsstack", "other", "not_known"];
// works is round 26's L3, calls both ways on one SIM, bearer and build. calls_out is
// L2, an outgoing call only (OCD rule round 49, item 1).
export const RESULTS = ["works", "calls_out", "signed_in", "service_off", "not_possible", "failed"];
/** SM8: where one calls-out pass confirmed the app's readings. Elsewhere works, calls_out and failed mean nothing. */
export const CALIBRATED_STACKS = ["aosp_imsstack"];
export const UNCALIBRATED_RESULTS = ["signed_in", "service_off", "not_possible"];
export const FEATURES = ["volte", "vowifi", "sms_over_ims", "video_calling", "vonr"];

const WEEK = /^[0-9]{4}-W[0-9]{2}$/;
const APP_VERSION = /^[0-9]{1,3}\.[0-9]{1,3}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,39}$/;
const CARRIER = /^(?:(?:open|fill)\.[0-9]{5,6}\.[0-9a-f]{12}|[0-9]{3}-[0-9]{2,3})$/;
const FEATURE_ENTRY = new RegExp(`^(?:${FEATURES.join("|")}):(?:on|off)$`);
// apn: and the row key of the tap report: the APN, its sorted types, its protocol.
const APN_ENTRY = /^apn:[a-z0-9][a-z0-9._-]{0,62}\|([a-z_*]{1,16}(?:,[a-z_*]{1,16}){0,15})\|(?:IP|IPV6|IPV4V6|PPP|NON-IP|UNSTRUCTURED)?$/;

const sameKeys = (value, keys) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const have = Object.keys(value).sort();
  return have.length === keys.length && [...keys].sort().every((key, i) => key === have[i]);
};

/** A feature entry, or an APN row that carries no emergency type. */
export function entryAllowed(entry) {
  if (typeof entry !== "string") return false;
  if (FEATURE_ENTRY.test(entry)) return true;
  const apn = APN_ENTRY.exec(entry);
  return apn !== null && !apn[1].split(",").includes("emergency");
}

/** True only for a report of exactly the closed shape, for this or the last ISO week at `nowMs`. */
export function reportAllowed(report, nowMs) {
  if (!sameKeys(report, ["schema", "schema_version", "week", "app_version", "device", "carrier", "results"])) return false;
  if (report.schema !== "ocd-week-report" || report.schema_version !== 1) return false;
  if (typeof report.week !== "string" || !WEEK.test(report.week)) return false;
  if (report.week !== weekFrom(nowMs, 0) && report.week !== weekFrom(nowMs, -1)) return false;
  if (typeof report.app_version !== "string" || !APP_VERSION.test(report.app_version)) return false;
  const { device } = report;
  if (!sameKeys(device, ["model", "rom_family", "android_major", "ims_stack"])) return false;
  if (typeof device.model !== "string" || !MODEL.test(device.model)) return false;
  if (!ROM_FAMILIES.includes(device.rom_family) || !IMS_STACKS.includes(device.ims_stack)) return false;
  if (!Number.isInteger(device.android_major) || device.android_major < 10 || device.android_major > 40) return false;
  if (typeof report.carrier !== "string" || !CARRIER.test(report.carrier)) return false;
  const { results } = report;
  if (!Array.isArray(results) || results.length < 1 || results.length > MAX_RESULTS) return false;
  const allowed = CALIBRATED_STACKS.includes(device.ims_stack) ? RESULTS : UNCALIBRATED_RESULTS;
  const seen = new Set();
  for (const item of results) {
    if (!sameKeys(item, ["entry", "result"])) return false;
    if (!entryAllowed(item.entry) || !allowed.includes(item.result)) return false;
    if (seen.has(item.entry)) return false;
    seen.add(item.entry);
  }
  return true;
}

/**
 * The relay never keeps an open value. Model, carrier and entry are stored and
 * served only as this digest, so its public read can carry no words or number
 * anyone typed. The publish step turns digests back into values by digesting
 * OCD's public lists, so what is on no list cannot be read at all.
 */
export async function digestOf(kind, value) {
  const bytes = new TextEncoder().encode(`ocd-week-report/1\n${kind}\n${value}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const CELL = new RegExp(
  `^([0-9a-f]{32})\\.([0-9a-f]{32})\\.(${ROM_FAMILIES.join("|")})\\.([0-9]{2})\\.(${IMS_STACKS.join("|")})\\.([0-9a-f]{32})\\.(${RESULTS.join("|")})$`,
);

/** The counter keys of a report, one per entry. */
export async function cellsOf(report) {
  const { device } = report;
  const model = await digestOf("device", device.model);
  const carrier = await digestOf("carrier", report.carrier);
  return Promise.all(
    report.results.map(async ({ entry, result }) =>
      [model, carrier, device.rom_family, device.android_major, device.ims_stack, await digestOf("entry", entry), result].join("."),
    ),
  );
}

/** A counter key's parts; null when the text is no counter key. */
export function parseCell(cell) {
  const match = typeof cell === "string" ? CELL.exec(cell) : null;
  if (!match) return null;
  const [, device, carrier, rom_family, android_major, ims_stack, entry, result] = match;
  return { device, carrier, rom_family, android_major: Number(android_major), ims_stack, entry, result };
}
