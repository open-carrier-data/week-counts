# week-counts

The relay and the published counts of Open Carrier Data's automatic path ([OCD](https://github.com/open-carrier-data/open-carrier-data), rule round 48).

A ROM install of OCD Android can send one closed week report per SIM, only after the person said yes to one question. This repository holds everything that happens after the phone: the Cloudflare Worker that counts the reports, its database schema, the Action that publishes the counts, and the published file. [OCD's privacy page](https://github.com/open-carrier-data/open-carrier-data/blob/main/docs/privacy.md) says what is sent and who is responsible.

The counts here are **automatic, reported by phones, not checked by OCD, and counts can be faked**. They set nothing. Phones and ROM builds never read this repository, the app has no address for it, and nothing here reaches OCD's data, `observed/` folder or manifest. A person or an agent may read a count and open a source review by hand. Nothing does that by itself.

**Status:** not deployed. Sending stays closed until OCD's `relay_open` is true.

## The path

```
phone --POST closed report--> Worker --counters--> D1
                              Worker <--public GET-- publish Action --> results/automatic.json
```

- **The Worker** checks the closed schema ([`schemas/ocd-week-report.schema.json`](schemas/ocd-week-report.schema.json)) and adds one to a counter per week and cell. Anything else is refused whole.
- **It stores counters only.** No report body, IP address, hash of an address, header, country or time. It has no log line, and Cloudflare's logs, Logpush and traces stay off in [`wrangler.toml`](wrangler.toml).
- **It keeps no open text.** Model, carrier and entry are stored and served only as a SHA-256 digest of the value. So its public GET can carry no word or phone number that someone posted. The publish step digests OCD's public lists and can only read back what is on them.
- **It holds no GitHub credential.** Nothing on the relay path can write to OCD's dataset. The publish Action pulls instead, with this repository's own token.
- **Rows leave at 8 weeks,** published or not, through a daily cron.

## Flooding and fakes

There is no account, so fakes cannot be stopped. They are bounded and made worthless:

| Limit | What happens |
|---|---|
| A counter row stops at 500 a week | A row at the cap is not published that week. That also covers a row that jumps from nothing to the cap |
| A week stops at 50,000 rows | New rows are dropped until the week ends, and existing rows still count |
| At most 4096 bytes and 16 results a report | Longer is refused |
| A week can be named only in that week and the next | A week closes for good after that |
| Values must be on OCD's public lists | Anything else is dropped at publishing |

**At Cloudflare's free limits the relay fails closed.** Workers Free takes 100,000 requests a day, then answers Error 1027. D1 Free takes 100,000 written rows and 5 million read rows a day, then its queries fail, and the Worker answers 503. Both reset at 00:00 UTC. A report writes up to 16 rows, so a day holds about 6,000 full reports. On any non-2xx a phone drops that week's report, keeps no queue and retries nothing. The account has no payment method, so no bill is possible. Storage is bounded too: at most 50,000 rows a week for about 10 weeks.

## What is published

[`results/automatic.json`](results/automatic.json), as device > carrier > plan, by month:

- a row, meaning device, carrier, ROM family, Android major, stack, entry and result, appears only with at least 3 reports in one ISO week;
- smaller rows are never served or published, and leave at 8 weeks;
- a month is published once, after its last week has closed. A week closes when no report can still name it, which is 14 days after it began;
- plan is always `unknown`, because reports carry no plan;
- each row reads "automatic, reported by phones, not checked by OCD, counts can be faked";
- `reports` counts weekly reports. Two SIMs on one phone are two reports. A count is not a number of phones or people, and it is never added to the reports in OCD's `observed/`.

[`status.txt`](status.txt) holds one line from the last run. The line is what keeps GitHub's schedule alive: a public repository with no activity for 60 days loses its schedules.

## Erasing a published value

Unlike OCD's `main`, this repository's `main` can be rewritten. Keep it free of force-push protection.

1. Delete the row from `results/automatic.json`, and from every commit: rewrite the branch and force-push.
2. If the value matters, ask GitHub Support to purge the old commits. A commit that was force-pushed away can stay reachable by its SHA until they do.
3. If the row may come back, wait: rows on the relay leave at 8 weeks, and a published month is never rebuilt.

## Deploying

Only the account's owner creates the Cloudflare account and saves the token. Everything after that runs here:

1. Save the token as the Actions secret `CLOUDFLARE_API_TOKEN` of this repository. It needs Workers Scripts: Edit and D1: Edit, on one free account with no payment method.
2. Run the `Deploy the relay` workflow. [`scripts/deploy.sh`](scripts/deploy.sh) creates the database, applies [`migrations/`](migrations/), deploys, runs [`scripts/smoke.sh`](scripts/smoke.sh) and records the address in `relay-url.txt`.

An account with no `workers.dev` name gets `open-carrier-week`, or the Actions variable `RELAY_SUBDOMAIN`. If the account already has one, check that it carries nobody's name. The address is compiled into the app, so it must be final before the app's build.

## Tests

```bash
npm ci
npm test
```

The tests run the Worker in workerd, the runtime Cloudflare runs, with a local D1. Nothing here has run on Cloudflare yet.
