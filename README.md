# FerretDB Live Dashboard — Clever Cloud

> Visual live dashboard, real-time compatibility matrix, and benchmark for **FerretDB** (MongoDB API on PostgreSQL) running on Clever Cloud.

Live demo: <https://app-704f18f0-cac3-482c-b548-3a27b19a40f1.cleverapps.io/>

---

## What it does

A single-file Node.js app that connects to a FerretDB instance via the MongoDB driver and:

- Displays connection metadata (wire protocol, FerretDB version, backend) **with live polling every 2s**
- Lets you trigger real Mongo operations (insert, find, aggregate, bulk) from the UI
- Runs **14 real compatibility tests** against MongoDB features, each calling the operator it claims to test
- Demonstrates **7 real-world MongoDB patterns** (schema flexibility, pagination, nested updates, array operators, upsert, distinct, query operators)
- Surfaces the **underlying PostgreSQL query plan** via `explain()`
- Runs a configurable **micro-benchmark** (insert / find / update with p50/p95/p99 percentiles)
- Shows a **compatibility scorecard** with breakdown by category (CRUD, Indexing, Aggregation, Advanced)

The dashboard is styled with the *Aura* theme (dark, blue accent, Inter + DM Mono + Newsreader fonts) — designed to be presentable in front of clients.

---

## Architecture

```
┌──────────────────────────┐
│ ferretdb-test-client     │  Node.js + Express-less http
│ Single server.js file    │  Embedded HTML/CSS/JS dashboard
│ Driver: mongodb 6.x      │
└───────┬──────────────────┘
        │ Mongo wire :27017 over Network Group (WireGuard)
        ▼
┌──────────────────────────┐
│ FerretDB v1 or v2        │
│ (proxy MongoDB ↔ SQL)    │
└───────┬──────────────────┘
        │ PostgreSQL wire + TLS
        ▼
┌──────────────────────────┐
│ Managed PG add-on        │  (or self-hosted PG with DocumentDB
│ on Clever Cloud           │   extension if running FerretDB v2)
└──────────────────────────┘
```

---

## Endpoints

### Pages

| Path          | What                                          |
|---------------|-----------------------------------------------|
| `/`           | Dashboard HTML (Aura theme)                   |
| `/server/info`| Raw `hello` + `buildInfo` from FerretDB       |
| `/diag`       | DNS + TCP probe of the FerretDB NG hostname   |
| `/health`     | `{ok:true}`                                   |
| `/bench`      | Full benchmark (5k inserts + 500 finds + ...) |

### Dashboard internal API

| Path                          | What                                                       |
|-------------------------------|------------------------------------------------------------|
| `/api/status`                 | Live status (ping, version, backend, doc count)            |
| `/api/insert`                 | Insert one doc with random tag + value                     |
| `/api/find`                   | Find last 20 docs sorted by `ts` desc                      |
| `/api/aggregate`              | `$group` by tag                                            |
| `/api/quickbench`             | 500 inserts + 200 finds + 100 updates with percentiles     |
| `/api/drop_dashboard`         | Drop the `dashboard` collection                            |

### Compatibility tests (each test the actual operator it claims)

`/api/compat/<test>` — runs the test, returns `{ok:true}` or `{ok:false, codeName, error}`:

- `crud` — insertMany + findOne + updateOne + deleteOne
- `index_simple` / `index_unique` / `index_compound`
- `group_sum` / `group_avg` / `group_max_min`
- `sample` / `lookup`
- `regex` / `bulk_write`
- `text_search`
- `transaction` (multi-doc) / `change_stream` (must receive an actual change event)

### Pattern demos (real-world MongoDB usage)

`/api/pattern/<name>` — runs the pattern, returns structured data with a narrative:

- `schema_flex` — 3 docs of totally different shapes in the same collection
- `list_paginate` — filter + sort + skip + limit
- `nested_update` — `$set` on a sub-document field
- `array_ops` — `$push` / `$addToSet` / `$pull` step-by-step
- `upsert` — `updateOne(..., {upsert:true})` showing create then update
- `distinct` — list unique values of a field
- `operators` — `$and` + `$or` + `$in` + `$exists` + `$gte` combined

### SQL plan

`/api/explain` — returns FerretDB's `explain('executionStats')` output, which is the actual **PostgreSQL query plan** under the hood.

---

## Environment Variables

| Variable     | Required | Example |
|--------------|:--------:|---------|
| `MONGO_URI`  | ✅       | `mongodb://<ferretdb-host>:27017/test?retryWrites=false` |
| `PORT`       | auto     | Injected by Clever Cloud (default 8080) |

`retryWrites=false` is mandatory for FerretDB (it does not implement Mongo retryable writes).

---

## Deploy on Clever Cloud

Prerequisite: a running FerretDB instance reachable from this app via a Network Group.

1. Fork this repo
2. In the Clever Cloud console, create a **Node.js** application — connect the fork
3. Add it to the **Network Group** containing your FerretDB instance
4. Set `MONGO_URI` to point at FerretDB via its internal NG hostname:
   `mongodb://app_<id>.m.ng_<id>.cc-ng.cloud:27017/test?retryWrites=false`
5. Push → Clever Cloud builds and deploys

That's it. No add-on required for the dashboard itself — it consumes FerretDB only.

---

## Local Development

```bash
git clone https://github.com/Vitiosum/ferretdb-test-client
cd ferretdb-test-client
npm install
export MONGO_URI="mongodb://localhost:27017/test?retryWrites=false"
npm start
# → http://localhost:8080
```

You need a FerretDB instance reachable at the URL. Quick Docker compose:

```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: pass
  ferretdb:
    image: ghcr.io/ferretdb/ferretdb:1
    environment:
      FERRETDB_POSTGRESQL_URL: postgresql://postgres:pass@postgres:5432/postgres
    ports: ["27017:27017"]
    depends_on: [postgres]
```

---

## Stack

| Layer    | Technology |
|----------|------------|
| Runtime  | Node.js 20 |
| HTTP     | stdlib `node:http` |
| Driver   | `mongodb` 6.10 |
| UI       | Embedded HTML + CSS + vanilla JS (no framework) |
| Fonts    | Inter, DM Mono, Newsreader (Google CDN) |
| Theme    | *Aura* — dark `hsl(0,0%,9%)`, blue accent `#3b82f6` |

---

## Companion repos

- [`demo-nodejs-ferretdb`](https://github.com/Vitiosum/demo-nodejs-ferretdb) — same CRUD demo as `demo-nodejs-postgresql`, but with the MongoDB driver and FerretDB backend
- [`demo-nodejs-postgresql`](https://github.com/Vitiosum/demo-nodejs-postgresql) — the original Express + native PostgreSQL demo

---

## License

MIT
