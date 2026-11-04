import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { cellsOf } from "../src/report.js";
import { weekFrom } from "../src/week.js";

/** The relay in workerd, the runtime Cloudflare runs, with a local D1 and the migration applied. */
export async function startRelay() {
  const mf = new Miniflare({
    modules: true,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    scriptPath: "src/worker.js",
    compatibilityDate: "2026-07-01",
    d1Databases: { DB: "week-counts-test" },
    host: "127.0.0.1",
    port: 0,
  });
  const url = (await mf.ready).toString().replace(/\/$/, "");
  const db = await mf.getD1Database("DB");
  const sql = readFileSync("migrations/0001_counters.sql", "utf8").replace(/^--.*$/gm, "");
  // A trigger's body holds semicolons, so statements split on blank lines.
  for (const statement of sql.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean)) await db.prepare(statement).run();
  return { mf, url, db };
}

export function report(overrides = {}) {
  return {
    schema: "ocd-week-report",
    schema_version: 1,
    week: weekFrom(Date.now(), 0),
    app_version: "0.5",
    device: { model: "SM-G981B", rom_family: "lineageos", android_major: 16, ims_stack: "aosp_imsstack" },
    carrier: "open.26203.0123456789ab",
    results: [
      { entry: "volte:on", result: "signed_in" },
      { entry: "apn:internet|default,supl|IPV4V6", result: "works" },
    ],
    ...overrides,
  };
}

export const post = (url, body, headers = { "content-type": "application/json" }) =>
  fetch(`${url}/v1/week-report`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

/** Counters of an old week straight into D1: no report can name a closed week. */
export async function seed(db, week, value, n) {
  await db.prepare("INSERT OR IGNORE INTO weeks (week) VALUES (?)").bind(week).run();
  for (const cell of await cellsOf(value)) {
    await db.prepare("INSERT INTO cells (week, cell, n) VALUES (?, ?, ?)").bind(week, cell, n).run();
  }
}
