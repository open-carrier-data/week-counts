// The scheduled publish step. Reads the relay's public GET and OCD's public
// lists, writes results/automatic.json and always status.txt. It holds no
// secret. On any doubt it publishes nothing and says so in the status line:
// that commit is also what keeps GitHub's schedule alive.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RESULTS_FILE, Refused, STATUS_FILE, addMonth, checkIndex, checkPage, digestTables, emptyDocument, monthRows, monthsDue, readLists, render } from "./lib.mjs";
import { weeksOfMonth } from "../src/week.js";

const DATA_REPOSITORY = "https://github.com/open-carrier-data/open-carrier-data";
const RAW = "https://raw.githubusercontent.com/open-carrier-data/open-carrier-data";
const RELAY_URL = /^https:\/\/week-counts\.[a-z0-9-]+\.workers\.dev$/;
const MAX_LIST_BYTES = 96 * 1024 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_PAGES = 60;

async function getText(url, maxBytes) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Refused(`${new URL(url).hostname} answered ${response.status}`);
  const text = await response.text();
  if (text.length > maxBytes) throw new Refused(`${new URL(url).hostname} sent too much`);
  return text;
}

/** main's four lists, read anonymously at one commit. */
async function fetchLists() {
  const line = execFileSync("git", ["ls-remote", DATA_REPOSITORY, "refs/heads/main"], { encoding: "utf8" });
  const commit = line.slice(0, 40);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Refused("main has no commit");
  const read = (path) => getText(`${RAW}/${commit}/${path}`, MAX_LIST_BYTES);
  const [android, profiles, index, xml] = await Promise.all([
    read("generated/devices/android.json"),
    read("generated/ocd-dataset/profiles.json"),
    read("generated/ocd-dataset/apn-index.json"),
    read("generated/android/apns-conf.xml"),
  ]);
  return { android: JSON.parse(android), profiles: JSON.parse(profiles), index: JSON.parse(index), xml };
}

async function readWeek(relay, week) {
  const cells = [];
  let after = null;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const query = after === null ? "" : `?after=${encodeURIComponent(after)}`;
    const page = JSON.parse(await getText(`${relay}/v1/closed/${week}${query}`, MAX_PAGE_BYTES));
    cells.push(...checkPage(page, week));
    if (page.next === null) return cells;
    after = page.next;
  }
  throw new Refused("the relay sent more pages than a week can hold");
}

/** One run in `root`. Returns the status line it wrote. */
export async function publish({ root, nowMs, relay, lists = fetchLists }) {
  const path = join(root, RESULTS_FILE);
  let document = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : emptyDocument();
  const day = new Date(nowMs).toISOString().slice(0, 10);
  let status;
  try {
    if (relay === null) {
      status = "no relay deployed yet";
    } else {
      if (!relay.startsWith("http://127.0.0.1:") && !RELAY_URL.test(relay)) throw new Refused("relay-url.txt is not the relay's address");
      const closed = checkIndex(JSON.parse(await getText(`${relay}/v1/closed`, MAX_PAGE_BYTES)), nowMs);
      const { due, missed, waiting } = monthsDue(closed, document.months, nowMs);
      const parts = [`${closed.length} closed week(s)`, `${waiting.length} month(s) still open`];
      if (missed.length > 0) parts.push(`missed past 8 weeks: ${missed.join(" ")}`);
      if (due.length > 0) {
        const held = readLists(await lists());
        const tables = await digestTables(held);
        for (const month of due) {
          const weeks = await Promise.all(weeksOfMonth(month).filter((week) => closed.includes(week)).map((week) => readWeek(relay, week)));
          const { rows, tally } = monthRows(month, weeks, tables, held);
          document = addMonth(document, month, rows);
          parts.push(`${month}: ${tally.rows} row(s), ${tally.held_at_cap} held at the cap, ${tally.not_on_a_list} not on a list, ${tally.privacy} failed the privacy scan`);
        }
        writeFileSync(path, render(document));
      }
      status = parts.join("; ");
    }
  } catch (error) {
    // Only the rule that stopped the run, never text the relay sent.
    status = `nothing published: ${error instanceof Refused ? error.message : "a read failed"}`;
  }
  const line = `${day} ${status}\n`;
  writeFileSync(join(root, STATUS_FILE), line);
  return line;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const file = join(root, "relay-url.txt");
  const relay = existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  process.stdout.write(await publish({ root, nowMs: Date.now(), relay: relay || null }));
}
