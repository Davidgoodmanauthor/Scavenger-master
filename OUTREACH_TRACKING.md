# Outreach click tracking

Lightweight `?ref=` hits. Does **not** turn on billing. Does **not** change hunt create.

## Links

Use a short code in emails:

- `https://scavenger-master.fyi/?ref=captain`
- `https://scavenger-master.fyi/host?ref=captain`

Allowed `ref`: letters, numbers, `_`, `-`, 1–64 characters. Anything else is ignored.

Each page load with a valid `ref` writes one row: `ref`, `path`, UTC `ts`, truncated user-agent.

## Stats

Set env **`OUTREACH_STATS_KEY`** on the Netlify site (functions / runtime). Then:

```
GET https://scavenger-master.fyi/.netlify/functions/outreach-stats?key=YOUR_KEY
```

JSON looks like:

```json
{ "ok": true, "total": 2, "byRef": [{ "ref": "test_click", "clicks": 2, "last_ts": "2026-09-18T03:00:00.000Z" }] }
```

Wrong or missing key → 401.

## Test

1. Open `/host?ref=test_click`
2. Open it again
3. Stats for `test_click` should show `clicks: 2`

Storage is Neon (`outreach_clicks`).
