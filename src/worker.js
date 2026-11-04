// The relay: POST one closed week report, add one to each of its counters.
// It keeps counters and nothing else. It has no log line, reads no address or
// header beyond the body's type and length, and holds no GitHub credential.
// Any failure is a non-2xx with an empty body: the phone forgets that week.

import { KEEP_WEEKS, MAX_BODY_BYTES, ROW_CAP, THRESHOLD, WEEK_ROW_CAP, cellsOf, reportAllowed } from "./report.js";
import { isClosed, mondayOfWeek, weekFrom } from "./week.js";

const PAGE = 1000;
const REPORT_PATH = "/v1/week-report";
const CLOSED_PATH = "/v1/closed";
const CLOSED_WEEK = /^\/v1\/closed\/([0-9]{4}-W[0-9]{2})$/;
const AFTER = /^[0-9a-z_.]{1,160}$/;

const empty = (status) => new Response(null, { status, headers: { "cache-control": "no-store" } });
const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** The body as text, or null past the size limit. A body is never read further than that. */
async function readBody(request) {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return null;
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function acceptReport(request, env, nowMs) {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return empty(415);
  const text = await readBody(request);
  if (text === null) return empty(413);
  const report = JSON.parse(text);
  if (!reportAllowed(report, nowMs)) return empty(400);

  // One transaction. A row at its cap stays where it is. A new row needs room
  // under the week's ceiling, and when the row exists its INSERT does nothing.
  const { week } = report;
  const statements = [env.DB.prepare("INSERT OR IGNORE INTO weeks (week) VALUES (?)").bind(week)];
  for (const cell of await cellsOf(report)) {
    statements.push(
      env.DB.prepare("UPDATE cells SET n = n + 1 WHERE week = ? AND cell = ? AND n < ?").bind(week, cell, ROW_CAP),
      env.DB.prepare(
        "INSERT OR IGNORE INTO cells (week, cell, n) SELECT ?, ?, 1 WHERE (SELECT cells FROM weeks WHERE week = ?) < ?",
      ).bind(week, cell, week, WEEK_ROW_CAP),
    );
  }
  await env.DB.batch(statements);
  return empty(204);
}

/** The closed weeks that hold rows. The current and last week can still change, so they are never served. */
async function closedWeeks(env, nowMs) {
  const { results } = await env.DB.prepare("SELECT week FROM weeks ORDER BY week").all();
  return json({
    schema: "ocd-relay-closed",
    schema_version: 1,
    threshold: THRESHOLD,
    row_cap: ROW_CAP,
    weeks: results.map((row) => row.week).filter((week) => isClosed(week, nowMs)),
  });
}

/** One page of a closed week's rows at or above the threshold. */
async function closedCells(env, week, after, nowMs) {
  if (mondayOfWeek(week) === null || !isClosed(week, nowMs)) return empty(404);
  if (after !== null && !AFTER.test(after)) return empty(400);
  const { results } = await env.DB.prepare(
    "SELECT cell, n FROM cells WHERE week = ? AND n >= 3 AND cell > ? ORDER BY cell LIMIT ?",
  ).bind(week, after ?? "", PAGE).all();
  return json({
    schema: "ocd-relay-closed-week",
    schema_version: 1,
    week,
    cells: results.map(({ cell, n }) => ({ cell, n })),
    next: results.length === PAGE ? results[results.length - 1].cell : null,
  });
}

async function route(request, env, nowMs) {
  const url = new URL(request.url);
  if (url.pathname === REPORT_PATH) {
    return request.method === "POST" ? acceptReport(request, env, nowMs) : empty(405);
  }
  if (request.method !== "GET") return empty(405);
  if (url.pathname === CLOSED_PATH) return closedWeeks(env, nowMs);
  const week = CLOSED_WEEK.exec(url.pathname);
  return week ? closedCells(env, week[1], url.searchParams.get("after"), nowMs) : empty(404);
}

/** Rows leave at 8 weeks, published or not. */
export async function expire(env, nowMs) {
  const last = weekFrom(nowMs, -KEEP_WEEKS);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cells WHERE week <= ?").bind(last),
    env.DB.prepare("DELETE FROM weeks WHERE week <= ?").bind(last),
  ]);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env, Date.now());
    } catch (error) {
      // Bad JSON or UTF-8 is the sender's fault. Anything else, D1's daily
      // limit included, closes the route. Neither is logged.
      return empty(error instanceof SyntaxError || error instanceof TypeError ? 400 : 503);
    }
  },

  async scheduled(controller, env) {
    await expire(env, controller.scheduledTime);
  },
};
