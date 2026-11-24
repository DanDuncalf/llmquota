# HTTP API

The Express server on `:8787` serves the text report and the JSON API. For the
product overview and documentation index, see [`../README.md`](../README.md).

## Query it from the terminal (curl)

```bash
curl -s http://127.0.0.1:8787/                            # full grouped report
curl -s 'http://127.0.0.1:8787/?color=1'                  # with ANSI color
curl -s http://127.0.0.1:8787/api/summary                 # alias
curl -s 'http://127.0.0.1:8787/api/quota-state?format=text'
curl -s http://127.0.0.1:8787/api/quota-state | jq '.summary'
curl -s http://127.0.0.1:8787/api/quota-state | jq '.state.provider_models[] | {provider, usage}'
curl -s http://127.0.0.1:8787/ | tail -3                  # "what should I use next?"
```

`Accept: text/plain` (without `application/json`) also returns the text report, so
plain `curl` works with no query param. Browser `fetch` keeps getting JSON.
`format=text|txt|plain` forces text, `format=json` forces JSON; `color=1` adds
ANSI color.

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /` | text report (grouped by risk, ends with the recommended next window) |
| `GET /api/summary` | text report alias |
| `GET /api/quota-state` | `{ state, summary, cards, card_errors }` (text when requested) |
| `GET /api/health` | `ok`, snapshot timestamp, bucket/provider/model/card counts, `card_errors`, `orphan_providers`, `cards_without_data`, `cards_hidden`, `card_dirs` |
| `GET /api/cards` | `{ cards, errors, dirs, writable_dir }` |
| `PUT /api/cards/:id` | create/update a card (id in the path wins; zod-validated) |
| `DELETE /api/cards/:id` | remove that card's JSON file |
| `POST /api/cards/:id/refresh` | re-scrape one card, merge its buckets into `state.json` |

If `state.json` is missing or invalid, `/api/quota-state` and the text routes
return HTTP 503 with a "is the scraper running?" message.

## Card API

Updates are written back to the file the card was loaded from; new cards go to
`data/cards/`. Writes are atomic (`tmp` + `rename`). The card editor in the UI
uses these endpoints — see [`cards.md`](cards.md#managing-cards-in-the-ui).

`POST /api/cards/:id/refresh` merges **buckets only** — usage tables and model
catalogs refresh on the next full daemon tick, and `generated_at` keeps the
daemon's tick time. It is rejected with HTTP 409 when the snapshot is mock data.
