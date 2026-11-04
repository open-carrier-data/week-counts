#!/usr/bin/env bash
# Checks a live relay with made-up values: a bad body is refused, a good one is
# counted, and the public read answers. 99999 is on none of OCD's lists, so
# the made-up cell can never be published and leaves at 8 weeks.
set -euo pipefail

url="$1"
week="$(date -u +%G-W%V)"
good="{\"schema\":\"ocd-week-report\",\"schema_version\":1,\"week\":\"$week\",\"app_version\":\"0.0\",\"device\":{\"model\":\"other\",\"rom_family\":\"other\",\"android_major\":10,\"ims_stack\":\"not_known\"},\"carrier\":\"99999\",\"results\":[{\"entry\":\"volte:on\",\"result\":\"not_possible\"}]}"

status() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }
expect() {
  if [ "$2" != "$3" ]; then
    echo "$1: answered $2, expected $3" >&2
    exit 1
  fi
  echo "$1: $2"
}

# The relay may need a moment after a first deploy of its workers.dev name.
for _ in 1 2 3 4 5 6; do
  [ "$(status "$url/v1/closed")" = 200 ] && break
  sleep 10
done
expect "public read" "$(status "$url/v1/closed")" 200
expect "bad body" "$(status -X POST -H 'content-type: application/json' --data "${good%\}},\"extra\":1}" "$url/v1/week-report")" 400
expect "good body" "$(status -X POST -H 'content-type: application/json' --data "$good" "$url/v1/week-report")" 204
