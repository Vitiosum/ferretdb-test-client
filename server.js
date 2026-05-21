import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';
import net from 'node:net';
import { URL } from 'node:url';
import { MongoClient } from 'mongodb';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_JS = fs.readFileSync(path.join(__dirname_, 'dashboard.js'), 'utf8');

const PORT = process.env.PORT || 8080;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('MONGO_URI manquant');
  process.exit(1);
}

const parsedUri = new URL(MONGO_URI.replace('mongodb://', 'http://'));
const MONGO_HOST = parsedUri.hostname;
const MONGO_PORT = parseInt(parsedUri.port || '27017', 10);

let client;
async function getDb() {
  if (!client) {
    client = new MongoClient(MONGO_URI, {
      retryWrites: false,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    client.on('error', e => console.error('Mongo error event:', e));
    await client.connect();
    console.log('✓ Connecté à FerretDB');
  }
  return client.db('test');
}

async function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise(resolve => {
    const s = new net.Socket();
    const t = setTimeout(() => { s.destroy(); resolve({ ok: false, error: 'timeout' }); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve({ ok: true }); });
    s.once('error', e => { clearTimeout(t); resolve({ ok: false, error: e.message, code: e.code }); });
    s.connect(port, host);
  });
}

const routes = {
  '/health': async () => ({ ok: true }),

  '/diag': async () => {
    const out = { host: MONGO_HOST, port: MONGO_PORT };
    try { out.dns_a = await dns.resolve4(MONGO_HOST); } catch (e) { out.dns_a_error = e.message; }
    out.tcp = await tcpProbe(MONGO_HOST, MONGO_PORT);
    return out;
  },

  '/server/info': async () => {
    const db = await getDb();
    return {
      hello: await db.command({ hello: 1 }),
      buildInfo: await db.command({ buildInfo: 1 }),
    };
  },

  '/test': async () => {
    const db = await getDb();
    const col = db.collection('items');
    const doc = { ts: new Date().toISOString(), msg: 'hello from ferretdb-test-client' };
    const ins = await col.insertOne(doc);
    const all = await col.find({}).limit(10).toArray();
    return { inserted: ins.insertedId, count: await col.countDocuments(), last10: all };
  },

  '/test/crud': async () => {
    const db = await getDb();
    const col = db.collection('crud_test');
    await col.deleteMany({});
    const ins = await col.insertMany([
      { name: 'Alice', age: 30, tags: ['admin', 'eng'] },
      { name: 'Bob', age: 25, tags: ['user'] },
      { name: 'Carol', age: 35, tags: ['admin'] },
    ]);
    const upd = await col.updateOne({ name: 'Bob' }, { $set: { age: 26 }, $push: { tags: 'eng' } });
    const found = await col.findOne({ name: 'Bob' });
    const del = await col.deleteOne({ name: 'Alice' });
    const final = await col.find({}, { projection: { _id: 0 } }).sort({ age: 1 }).toArray();
    return { inserted: ins.insertedCount, matched: upd.matchedCount, modified: upd.modifiedCount, bob: found, deleted: del.deletedCount, final };
  },

  '/test/aggregate': async () => {
    const db = await getDb();
    const col = db.collection('agg_test');
    await col.deleteMany({});
    await col.insertMany([
      { dept: 'eng', salary: 70 },
      { dept: 'eng', salary: 80 },
      { dept: 'eng', salary: 90 },
      { dept: 'sales', salary: 60 },
      { dept: 'sales', salary: 100 },
    ]);
    const out = await col.aggregate([
      { $match: { salary: { $gte: 60 } } },
      { $group: { _id: '$dept', total: { $sum: '$salary' }, avg: { $avg: '$salary' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]).toArray();
    return { byDept: out };
  },

  '/test/index': async () => {
    const db = await getDb();
    const col = db.collection('idx_test');
    await col.deleteMany({});
    await col.insertMany(Array.from({ length: 100 }, (_, i) => ({ i, even: i % 2 === 0, name: `item-${i}` })));
    await col.createIndex({ i: 1 });
    await col.createIndex({ name: 1 }, { unique: true });
    const idx = await col.indexes();
    const explain = await col.find({ i: 42 }).explain('executionStats');
    return { indexes: idx, explain };
  },

  '/test/bulk': async () => {
    const db = await getDb();
    const col = db.collection('bulk_test');
    await col.deleteMany({});
    const ops = Array.from({ length: 500 }, (_, i) => ({ insertOne: { document: { i, v: Math.random() } } }));
    const t0 = Date.now();
    const r = await col.bulkWrite(ops, { ordered: false });
    const ms = Date.now() - t0;
    return { inserted: r.insertedCount, ms, throughput_per_sec: Math.round(r.insertedCount / (ms / 1000)) };
  },

  '/bench': async () => {
    const db = await getDb();
    const col = db.collection('bench');
    await col.drop().catch(() => {});

    const stats = (samples) => {
      const s = [...samples].sort((a, b) => a - b);
      const p = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
      const sum = s.reduce((a, b) => a + b, 0);
      return { n: s.length, min: s[0], p50: p(0.5), p95: p(0.95), p99: p(0.99), max: s[s.length - 1], avg_ms: +(sum / s.length).toFixed(3) };
    };

    const report = {};

    // 1. INSERT 5000 docs (bulk by chunks of 500 pour mesurer chaque chunk)
    const N = 5000;
    const insertLatencies = [];
    const t0Insert = Date.now();
    for (let i = 0; i < N; i += 500) {
      const ops = Array.from({ length: 500 }, (_, j) => ({
        insertOne: { document: { i: i + j, kind: ['a', 'b', 'c'][(i + j) % 3], v: Math.random(), payload: 'x'.repeat(200) } },
      }));
      const t0 = Date.now();
      await col.bulkWrite(ops, { ordered: false });
      insertLatencies.push(Date.now() - t0);
    }
    const insertTotalMs = Date.now() - t0Insert;
    report.insert = {
      n_docs: N,
      total_ms: insertTotalMs,
      throughput_docs_per_sec: Math.round(N / (insertTotalMs / 1000)),
      batch_latency_ms: stats(insertLatencies),
    };

    // 2. INDEX creation
    const tIdx = Date.now();
    await col.createIndex({ i: 1 });
    await col.createIndex({ kind: 1, v: 1 });
    report.index_creation_ms = Date.now() - tIdx;

    // 3. FIND BY _id (500 lookups random) — random pick côté JS pour compat FerretDB v1 (pas de $sample)
    const allIds = await col.find({}, { projection: { _id: 1 } }).toArray();
    const sample = [];
    for (let k = 0; k < 500; k++) sample.push(allIds[Math.floor(Math.random() * allIds.length)]);
    const findIdLat = [];
    for (const { _id } of sample) {
      const t = Date.now();
      await col.findOne({ _id });
      findIdLat.push(Date.now() - t);
    }
    report.find_by_id = stats(findIdLat);

    // 4. FIND WITH INDEX (i-based equality, 500 fois)
    const findIdxLat = [];
    for (let k = 0; k < 500; k++) {
      const i = Math.floor(Math.random() * N);
      const t = Date.now();
      await col.findOne({ i });
      findIdxLat.push(Date.now() - t);
    }
    report.find_indexed = stats(findIdxLat);

    // 5. RANGE QUERY (100 fois)
    const rangeLat = [];
    for (let k = 0; k < 100; k++) {
      const start = Math.floor(Math.random() * (N - 100));
      const t = Date.now();
      await col.find({ i: { $gte: start, $lt: start + 100 } }).toArray();
      rangeLat.push(Date.now() - t);
    }
    report.range_100docs = stats(rangeLat);

    // 6. UPDATE (200 fois, $set + $inc)
    const updateLat = [];
    for (let k = 0; k < 200; k++) {
      const i = Math.floor(Math.random() * N);
      const t = Date.now();
      await col.updateOne({ i }, { $set: { touched: new Date() }, $inc: { hits: 1 } });
      updateLat.push(Date.now() - t);
    }
    report.update = stats(updateLat);

    // 7. AGGREGATION pipeline
    const aggLat = [];
    for (let k = 0; k < 50; k++) {
      const t = Date.now();
      await col.aggregate([
        { $match: { v: { $lt: 0.5 } } },
        { $group: { _id: '$kind', cnt: { $sum: 1 }, total_v: { $sum: '$v' } } },
        { $sort: { cnt: -1 } },
      ]).toArray();
      aggLat.push(Date.now() - t);
    }
    report.aggregation = stats(aggLat);

    // 8. DELETE (cleanup, single shot)
    const tDel = Date.now();
    const del = await col.deleteMany({});
    report.delete_all = { n: del.deletedCount, ms: Date.now() - tDel };

    return report;
  },

  '/test/cleanup': async () => {
    const db = await getDb();
    const cols = ['items', 'crud_test', 'agg_test', 'idx_test', 'bulk_test', 'bench', 'dashboard', 'bench_quick'];
    const out = {};
    for (const c of cols) {
      try { await db.collection(c).drop(); out[c] = 'dropped'; } catch (e) { out[c] = e.codeName || e.message; }
    }
    return out;
  },

  '/api/status': async () => {
    const t0 = Date.now();
    const db = await getDb();
    const hello = await db.command({ hello: 1 });
    const buildInfo = await db.command({ buildInfo: 1 });
    const ping_ms = Date.now() - t0;
    const col = db.collection('dashboard');
    const docs_count = await col.countDocuments();

    // Détection v1 / v2 via la présence de buildInfo.ferretdb (exposé seulement par v2)
    const isV2 = !!buildInfo.ferretdb;
    let ferretdb_version, backend;
    if (isV2) {
      ferretdb_version = buildInfo.ferretdb.version;
      backend = buildInfo.ferretdb.package?.includes('eval')
        ? 'PG embarqué (image eval, self-hosted)'
        : 'PG self-hosted (split)';
    } else {
      ferretdb_version = 'v1.24.x';
      backend = 'PG add-on managé Clever Cloud';
    }

    return {
      ok: true,
      ping_ms,
      target: `${MONGO_HOST}:${MONGO_PORT}`,
      wire_version: hello.maxWireVersion,
      mongo_compat: 'MongoDB ' + buildInfo.version,
      ferretdb_version,
      backend,
      docs_in_dashboard: docs_count,
    };
  },

  '/api/insert': async () => {
    const db = await getDb();
    const col = db.collection('dashboard');
    const t0 = Date.now();
    const r = await col.insertOne({
      ts: new Date(),
      msg: 'doc inséré via dashboard',
      tag: ['alpha', 'beta', 'gamma'][Math.floor(Math.random() * 3)],
      value: Math.floor(Math.random() * 1000),
    });
    return { ok: true, _id: String(r.insertedId), latency_ms: Date.now() - t0 };
  },

  '/api/find': async () => {
    const db = await getDb();
    const col = db.collection('dashboard');
    const t0 = Date.now();
    const docs = await col.find({}).sort({ ts: -1 }).limit(20).toArray();
    return { ok: true, latency_ms: Date.now() - t0, count: docs.length };
  },

  '/api/aggregate': async () => {
    const db = await getDb();
    const col = db.collection('dashboard');
    const t0 = Date.now();
    const out = await col.aggregate([
      { $group: { _id: '$tag', count: { $sum: 1 }, sum_value: { $sum: '$value' } } },
      { $sort: { count: -1 } },
    ]).toArray();
    return { ok: true, latency_ms: Date.now() - t0, byTag: out };
  },

  '/api/quickbench': async () => {
    const db = await getDb();
    const col = db.collection('bench_quick');
    await col.drop().catch(() => {});

    const lat = { insert: [], find: [], update: [] };

    const t0i = Date.now();
    for (let i = 0; i < 500; i += 100) {
      const ops = Array.from({ length: 100 }, (_, j) => ({
        insertOne: { document: { i: i + j, v: Math.random() } },
      }));
      const t = Date.now();
      await col.bulkWrite(ops, { ordered: false });
      lat.insert.push(Date.now() - t);
    }
    const insert_total_ms = Date.now() - t0i;

    await col.createIndex({ i: 1 });

    for (let k = 0; k < 200; k++) {
      const i = Math.floor(Math.random() * 500);
      const t = Date.now();
      await col.findOne({ i });
      lat.find.push(Date.now() - t);
    }

    for (let k = 0; k < 100; k++) {
      const i = Math.floor(Math.random() * 500);
      const t = Date.now();
      await col.updateOne({ i }, { $set: { touched: new Date() } });
      lat.update.push(Date.now() - t);
    }

    const stat = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      return {
        p50: s[Math.floor(s.length * 0.5)],
        p95: s[Math.floor(s.length * 0.95)],
        p99: s[Math.floor(s.length * 0.99)],
        avg: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2),
      };
    };

    return {
      ok: true,
      insert: { ...stat(lat.insert), n_docs: 500, total_ms: insert_total_ms, throughput: Math.round(500000 / insert_total_ms) },
      find: { ...stat(lat.find), n: 200 },
      update: { ...stat(lat.update), n: 100 },
    };
  },

  '/api/latency': async () => {
    const db = await getDb();
    const col = db.collection('dashboard');
    const doc = await col.findOne({}); // need at least 1 doc; if none, create
    let id = doc?._id;
    if (!id) {
      const ins = await col.insertOne({ probe: true, ts: new Date() });
      id = ins.insertedId;
    }

    const stat = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      return { min: s[0], p50: s[Math.floor(s.length * 0.5)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1], avg: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2) };
    };

    // Mongo ping (test-client ↔ FerretDB) — pas de PG impliqué côté FerretDB
    const pingLat = [];
    for (let k = 0; k < 15; k++) {
      const t = Date.now();
      await db.command({ ping: 1 });
      pingLat.push(Date.now() - t);
    }

    // findOne par _id — full pipeline test-client → FerretDB → PG → reply
    const findLat = [];
    for (let k = 0; k < 15; k++) {
      const t = Date.now();
      await col.findOne({ _id: id });
      findLat.push(Date.now() - t);
    }

    // hello — léger côté FerretDB (pas de PG)
    const helloLat = [];
    for (let k = 0; k < 15; k++) {
      const t = Date.now();
      await db.command({ hello: 1 });
      helloLat.push(Date.now() - t);
    }

    const p = stat(pingLat);
    const f = stat(findLat);
    const h = stat(helloLat);
    return {
      ok: true,
      narrative: 'Décomposition du RTT en mesures réelles : ping/hello côté FerretDB-only vs findOne qui touche PG',
      hops: {
        mongo_ping: { ...p, hop: 'test-client → FerretDB (Mongo wire, no PG)' },
        mongo_hello: { ...h, hop: 'test-client → FerretDB (hello, no PG)' },
        full_findOne: { ...f, hop: 'test-client → FerretDB → PG addon (full pipeline)' },
        pg_hop_estimate: { avg: +(f.avg - p.avg).toFixed(2), hop: 'FerretDB → PG addon (estimated = findOne - ping)' },
      },
    };
  },

  '/api/drop_dashboard': async () => {
    const db = await getDb();
    try { await db.collection('dashboard').drop(); return { ok: true, dropped: 'dashboard' }; } catch (e) { return { ok: false, error: e.message }; }
  },

  // ─── Tests de compatibilité honnêtes : chaque endpoint exécute RÉELLEMENT l'opérateur annoncé ───
  '/api/compat/crud': async () => {
    const db = await getDb();
    const col = db.collection('compat_crud');
    await col.drop().catch(() => {});
    const ins = await col.insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const found = await col.findOne({ n: 2 });
    const upd = await col.updateOne({ n: 2 }, { $set: { touched: true } });
    const del = await col.deleteOne({ n: 1 });
    await col.drop().catch(() => {});
    return { ok: true, inserted: ins.insertedCount, found: !!found, modified: upd.modifiedCount, deleted: del.deletedCount };
  },

  '/api/compat/index_simple': async () => {
    const db = await getDb();
    const col = db.collection('compat_idx_simple');
    await col.drop().catch(() => {});
    await col.insertMany([{ v: 1 }, { v: 2 }, { v: 3 }]);
    await col.createIndex({ v: 1 });
    const idxs = await col.indexes();
    await col.drop().catch(() => {});
    return { ok: true, indexes: idxs.length };
  },

  '/api/compat/index_unique': async () => {
    const db = await getDb();
    const col = db.collection('compat_idx_unique');
    await col.drop().catch(() => {});
    await col.createIndex({ email: 1 }, { unique: true });
    await col.insertOne({ email: 'a@x.com' });
    let collided = false;
    try { await col.insertOne({ email: 'a@x.com' }); } catch (e) { collided = e.code === 11000; }
    await col.drop().catch(() => {});
    return { ok: collided, collided };
  },

  '/api/compat/index_compound': async () => {
    const db = await getDb();
    const col = db.collection('compat_idx_compound');
    await col.drop().catch(() => {});
    await col.createIndex({ kind: 1, ts: -1 });
    await col.insertMany(Array.from({ length: 50 }, (_, i) => ({ kind: i % 3, ts: i })));
    const idxs = await col.indexes();
    await col.drop().catch(() => {});
    return { ok: true, count: idxs.length };
  },

  '/api/compat/group_sum': async () => {
    const db = await getDb();
    const col = db.collection('compat_agg');
    await col.drop().catch(() => {});
    await col.insertMany([{ k: 'a', v: 10 }, { k: 'a', v: 20 }, { k: 'b', v: 5 }]);
    const r = await col.aggregate([{ $group: { _id: '$k', total: { $sum: '$v' } } }, { $sort: { total: -1 } }]).toArray();
    await col.drop().catch(() => {});
    return { ok: true, result: r };
  },

  '/api/compat/group_avg': async () => {
    const db = await getDb();
    const col = db.collection('compat_agg');
    await col.drop().catch(() => {});
    await col.insertMany([{ k: 'a', v: 10 }, { k: 'a', v: 20 }, { k: 'b', v: 5 }]);
    const r = await col.aggregate([{ $group: { _id: '$k', avg: { $avg: '$v' } } }]).toArray();
    await col.drop().catch(() => {});
    return { ok: true, result: r };
  },

  '/api/compat/group_max_min': async () => {
    const db = await getDb();
    const col = db.collection('compat_agg');
    await col.drop().catch(() => {});
    await col.insertMany([{ k: 'a', v: 10 }, { k: 'a', v: 20 }, { k: 'b', v: 5 }]);
    const r = await col.aggregate([{ $group: { _id: '$k', mx: { $max: '$v' }, mn: { $min: '$v' } } }]).toArray();
    await col.drop().catch(() => {});
    return { ok: true, result: r };
  },

  '/api/compat/sample': async () => {
    const db = await getDb();
    const col = db.collection('compat_sample');
    await col.drop().catch(() => {});
    await col.insertMany(Array.from({ length: 50 }, (_, i) => ({ i })));
    const r = await col.aggregate([{ $sample: { size: 5 } }]).toArray();
    await col.drop().catch(() => {});
    return { ok: true, picked: r.length };
  },

  '/api/compat/lookup': async () => {
    const db = await getDb();
    const users = db.collection('compat_users');
    const orders = db.collection('compat_orders');
    await users.drop().catch(() => {});
    await orders.drop().catch(() => {});
    await users.insertMany([{ _id: 1, name: 'Alice' }, { _id: 2, name: 'Bob' }]);
    await orders.insertMany([{ uid: 1, item: 'book' }, { uid: 1, item: 'pen' }, { uid: 2, item: 'cup' }]);
    const r = await users.aggregate([
      { $lookup: { from: 'compat_orders', localField: '_id', foreignField: 'uid', as: 'orders' } },
    ]).toArray();
    await users.drop().catch(() => {});
    await orders.drop().catch(() => {});
    return { ok: true, joined: r };
  },

  '/api/compat/regex': async () => {
    const db = await getDb();
    const col = db.collection('compat_regex');
    await col.drop().catch(() => {});
    await col.insertMany([{ name: 'Apple' }, { name: 'apricot' }, { name: 'banana' }]);
    const r = await col.find({ name: { $regex: '^a', $options: 'i' } }).toArray();
    await col.drop().catch(() => {});
    return { ok: r.length === 2, matched: r.length };
  },

  '/api/compat/bulk_write': async () => {
    const db = await getDb();
    const col = db.collection('compat_bulk');
    await col.drop().catch(() => {});
    const r = await col.bulkWrite([
      { insertOne: { document: { a: 1 } } },
      { insertOne: { document: { a: 2 } } },
      { updateOne: { filter: { a: 1 }, update: { $set: { b: 'x' } } } },
      { deleteOne: { filter: { a: 2 } } },
    ]);
    await col.drop().catch(() => {});
    return { ok: true, inserted: r.insertedCount, modified: r.modifiedCount, deleted: r.deletedCount };
  },

  '/api/compat/text_search': async () => {
    const db = await getDb();
    const col = db.collection('compat_text');
    await col.drop().catch(() => {});
    await col.insertMany([{ d: 'the quick brown fox' }, { d: 'jumps over' }, { d: 'lazy dog' }]);
    await col.createIndex({ d: 'text' });
    const r = await col.find({ $text: { $search: 'fox dog' } }).toArray();
    await col.drop().catch(() => {});
    return { ok: true, matched: r.length };
  },

  '/api/compat/transaction': async () => {
    const db = await getDb();
    const col = db.collection('compat_tx');
    await col.drop().catch(() => {});
    const sess = client.startSession();
    try {
      await sess.withTransaction(async () => {
        await col.insertOne({ a: 1 }, { session: sess });
        await col.insertOne({ a: 2 }, { session: sess });
      });
      return { ok: true };
    } finally {
      try { await col.drop(); } catch {}
      sess.endSession();
    }
  },

  // ─── Patterns MongoDB réels — au-delà des opérateurs, des cas d'usage app concrets ───
  '/api/pattern/schema_flex': async () => {
    const db = await getDb();
    const col = db.collection('pat_products');
    await col.drop().catch(() => {});
    await col.insertOne({ name: 'Mug', price: 12 });
    await col.insertOne({ name: 'T-shirt', price: 25, color: 'navy', size: 'L', weight_g: 180 });
    await col.insertOne({ title: 'Box subscription', monthly_price: 39, includes: ['mug', 'tshirt'], options: { gift_wrap: true, eta_days: 3 } });
    const docs = await col.find({}).toArray();
    return { ok: true, narrative: '3 documents, schémas totalement différents, même collection. Aucun ALTER TABLE.', docs };
  },

  '/api/pattern/list_paginate': async () => {
    const db = await getDb();
    const col = db.collection('pat_paginate');
    await col.drop().catch(() => {});
    const seed = Array.from({ length: 50 }, (_, i) => ({ i, price: Math.floor(Math.random() * 200) + 10, name: 'item-' + i }));
    await col.insertMany(seed);
    await col.createIndex({ price: -1 });
    const PAGE_SIZE = 5, PAGE = 3;
    const t0 = Date.now();
    const rows = await col.find({ price: { $gte: 50 } }).sort({ price: -1 }).skip(PAGE_SIZE * (PAGE - 1)).limit(PAGE_SIZE).toArray();
    const total = await col.countDocuments({ price: { $gte: 50 } });
    await col.drop().catch(() => {});
    return {
      ok: true,
      narrative: `find({price:{$gte:50}}).sort({price:-1}).skip(${PAGE_SIZE * (PAGE - 1)}).limit(${PAGE_SIZE})`,
      total_matching: total,
      page: PAGE,
      page_size: PAGE_SIZE,
      latency_ms: Date.now() - t0,
      rows: rows.map(r => ({ i: r.i, name: r.name, price: r.price })),
    };
  },

  '/api/pattern/nested_update': async () => {
    const db = await getDb();
    const col = db.collection('pat_nested');
    await col.drop().catch(() => {});
    await col.insertOne({ name: 'Alice', address: { city: 'Lyon', street: '12 rue X', zip: '69001' }, age: 30 });
    const before = await col.findOne({ name: 'Alice' });
    await col.updateOne({ name: 'Alice' }, { $set: { 'address.city': 'Paris', 'address.zip': '75001' } });
    const after = await col.findOne({ name: 'Alice' });
    await col.drop().catch(() => {});
    return {
      ok: true,
      narrative: "$set: { 'address.city': 'Paris', 'address.zip': '75001' } — modifie 2 champs imbriqués sans toucher le reste",
      before, after,
    };
  },

  '/api/pattern/array_ops': async () => {
    const db = await getDb();
    const col = db.collection('pat_array');
    await col.drop().catch(() => {});
    await col.insertOne({ name: 'doc', tags: ['alpha', 'beta'] });
    const steps = [];
    steps.push({ op: 'initial', tags: (await col.findOne({ name: 'doc' })).tags });
    await col.updateOne({ name: 'doc' }, { $push: { tags: 'gamma' } });
    steps.push({ op: "$push 'gamma'", tags: (await col.findOne({ name: 'doc' })).tags });
    await col.updateOne({ name: 'doc' }, { $addToSet: { tags: 'beta' } });
    steps.push({ op: "$addToSet 'beta' (doublon ignoré)", tags: (await col.findOne({ name: 'doc' })).tags });
    await col.updateOne({ name: 'doc' }, { $pull: { tags: 'alpha' } });
    steps.push({ op: "$pull 'alpha'", tags: (await col.findOne({ name: 'doc' })).tags });
    await col.drop().catch(() => {});
    return { ok: true, narrative: 'Manipulation directe du tableau tags sans le ré-écrire entièrement', steps };
  },

  '/api/pattern/upsert': async () => {
    const db = await getDb();
    const col = db.collection('pat_upsert');
    await col.drop().catch(() => {});
    const r1 = await col.updateOne({ sku: 'XYZ-001' }, { $set: { name: 'Widget', price: 99 }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    const r2 = await col.updateOne({ sku: 'XYZ-001' }, { $set: { price: 79, lastUpdate: new Date() } }, { upsert: true });
    const finalDoc = await col.findOne({ sku: 'XYZ-001' });
    await col.drop().catch(() => {});
    return {
      ok: true,
      narrative: "updateOne(..., { upsert: true }) — premier appel crée, deuxième met à jour. Idempotent.",
      first_call: { matched: r1.matchedCount, upserted: !!r1.upsertedId, id: r1.upsertedId ? String(r1.upsertedId) : null },
      second_call: { matched: r2.matchedCount, modified: r2.modifiedCount, upserted: !!r2.upsertedId },
      final: finalDoc,
    };
  },

  '/api/pattern/distinct': async () => {
    const db = await getDb();
    const col = db.collection('pat_distinct');
    await col.drop().catch(() => {});
    await col.insertMany([
      { category: 'books', title: 'A' },
      { category: 'tools', title: 'B' },
      { category: 'books', title: 'C' },
      { category: 'food',  title: 'D' },
      { category: 'tools', title: 'E' },
    ]);
    const t0 = Date.now();
    const cats = await col.distinct('category');
    const latency_ms = Date.now() - t0;
    await col.drop().catch(() => {});
    return { ok: true, narrative: "col.distinct('category') — valeurs uniques (utile pour filtres UI)", categories: cats.sort(), latency_ms };
  },

  '/api/pattern/operators': async () => {
    const db = await getDb();
    const col = db.collection('pat_ops');
    await col.drop().catch(() => {});
    await col.insertMany([
      { name: 'Alice', age: 30, role: 'admin', city: 'Paris' },
      { name: 'Bob', age: 25, role: 'user', city: 'Lyon' },
      { name: 'Carol', age: 35, role: 'admin', city: 'Paris' },
      { name: 'Dan', age: 40, role: 'user' },
      { name: 'Eve', age: 28, role: 'guest', city: 'Marseille' },
    ]);
    const q = { $and: [{ role: { $in: ['admin', 'user'] } }, { $or: [{ city: 'Paris' }, { age: { $gte: 40 } }] }, { city: { $exists: true } }] };
    const matched = await col.find(q).toArray();
    await col.drop().catch(() => {});
    return {
      ok: true,
      narrative: '$and + $or + $in + $exists + $gte combinés en un seul filtre',
      query: q,
      matched_count: matched.length,
      results: matched.map(d => ({ name: d.name, role: d.role, city: d.city, age: d.age })),
    };
  },

  '/api/explain': async () => {
    const db = await getDb();
    const col = db.collection('explain_target');
    await col.drop().catch(() => {});
    await col.insertMany(Array.from({ length: 200 }, (_, i) => ({ i, kind: ['a', 'b', 'c'][i % 3], v: Math.random() })));
    await col.createIndex({ kind: 1, v: 1 });
    const explain = await col.find({ kind: 'a', v: { $gte: 0.5 } }).explain('executionStats');
    await col.drop().catch(() => {});
    return {
      ok: true,
      narrative: "200 docs · find({kind:'a', v:{$gte:0.5}}).explain() — PostgreSQL choisit un Seq Scan car la table est trop petite pour justifier l'index",
      doc_count: 200,
      explain,
    };
  },

  '/api/explain/by_id': async () => {
    const db = await getDb();
    const col = db.collection('explain_target_by_id');
    await col.drop().catch(() => {});
    const N = 10000;
    const t0 = Date.now();
    for (let i = 0; i < N; i += 1000) {
      const ops = Array.from({ length: 1000 }, (_, j) => ({ insertOne: { document: { i: i + j, v: Math.random() } } }));
      await col.bulkWrite(ops, { ordered: false });
    }
    const insertMs = Date.now() - t0;
    // Pick a random _id at the middle of the table
    const sample = await col.findOne({ i: N / 2 });
    const t1 = Date.now();
    const explain = await col.find({ _id: sample._id }).explain('executionStats');
    const explainMs = Date.now() - t1;
    await col.drop().catch(() => {});
    return {
      ok: true,
      narrative: `${N} docs · findOne({_id: ObjectId(...)}).explain() — l'index B-tree natif PG sur _id est utilisé → Index Scan`,
      doc_count: N,
      seed_ms: insertMs,
      explain_ms: explainMs,
      explain,
    };
  },

  '/api/explain/large': async () => {
    const db = await getDb();
    const col = db.collection('explain_target_large');
    await col.drop().catch(() => {});
    const N = 10000;
    const t0 = Date.now();
    for (let i = 0; i < N; i += 1000) {
      const ops = Array.from({ length: 1000 }, (_, j) => ({
        insertOne: { document: { i: i + j, kind: ['a', 'b', 'c', 'd', 'e'][(i + j) % 5], v: Math.random() } },
      }));
      await col.bulkWrite(ops, { ordered: false });
    }
    await col.createIndex({ kind: 1, v: 1 });
    const insertMs = Date.now() - t0;
    const t1 = Date.now();
    const explain = await col.find({ kind: 'a', v: { $gte: 0.5 } }).explain('executionStats');
    const explainMs = Date.now() - t1;
    await col.drop().catch(() => {});
    return {
      ok: true,
      narrative: `${N} docs · find({kind:'a', v:{$gte:0.5}}).explain() — table assez grande pour que PG utilise (ou pas) un Index Scan`,
      doc_count: N,
      seed_ms: insertMs,
      explain_ms: explainMs,
      explain,
    };
  },

  '/api/compat/change_stream': async () => {
    const db = await getDb();
    const col = db.collection('compat_cs');
    await col.drop().catch(() => {});
    await col.insertOne({ init: true }); // collection exists
    let cs;
    try { cs = col.watch(); } catch (e) { throw e; }
    const got = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ received: false, reason: 'timeout' }), 3000);
      cs.on('change', ev => { clearTimeout(timer); resolve({ received: true, op: ev.operationType }); });
      cs.on('error', e => { clearTimeout(timer); resolve({ received: false, reason: e.codeName || e.message }); });
    });
    // insert un doc après avoir ouvert le stream → l'event doit arriver
    await new Promise(r => setTimeout(r, 200));
    await col.insertOne({ probe: 'change-event' });
    const result = await got;
    try { await cs.close(); } catch {}
    try { await col.drop(); } catch {}
    if (!result.received) return { ok: false, error: 'change stream silencieux (' + result.reason + ')', codeName: 'NotImplemented' };
    return { ok: true, ...result };
  },
};

const DASHBOARD_HTML = `<!doctype html>
<html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FerretDB Live — Clever Cloud</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Newsreader:ital,wght@1,300;1,400&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{font-family:'Inter',sans-serif;background:hsl(0,0%,9%);color:hsl(0,0%,98%);min-height:100vh;overflow-x:hidden}
.orbs{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.orb{position:absolute;border-radius:50%;filter:blur(80px);opacity:0.5}
.orb-1{width:500px;height:500px;background:radial-gradient(circle,#3b82f6 0%,transparent 70%);top:-150px;right:-100px}
.orb-2{width:350px;height:350px;background:radial-gradient(circle,#8b5cf6 0%,transparent 70%);bottom:-100px;left:-80px}
.orb-3{width:250px;height:250px;background:radial-gradient(circle,#06b6d4 0%,transparent 70%);top:45%;left:40%}
.wrap{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:0 24px}
.nav{display:flex;align-items:center;justify-content:space-between;padding:14px 28px;background:rgba(23,23,23,0.75);backdrop-filter:blur(16px);border-bottom:1px solid hsl(0,0%,20%);position:sticky;top:0;z-index:10;margin:0 -24px}
.nav-logo{font-size:14px;font-weight:700;letter-spacing:-0.02em}
.nav-logo span{color:#3b82f6}
.nav-pill{display:inline-flex;align-items:center;gap:6px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.2);border-radius:99px;padding:5px 12px;font-size:10px;color:#60a5fa;font-weight:600;letter-spacing:0.06em;text-transform:uppercase}
.nav-dot{width:5px;height:5px;background:#3b82f6;border-radius:50%;animation:pulse 1.5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
.hero{padding:60px 0 30px}
.live-badge{display:inline-flex;align-items:center;gap:8px;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.2);border-radius:99px;color:#60a5fa;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;padding:5px 16px;margin-bottom:18px}
.live-dot{width:6px;height:6px;background:#3b82f6;border-radius:50%;animation:pulse 1.5s ease-in-out infinite}
h1{font-size:clamp(2.5rem,7vw,4rem);font-weight:700;letter-spacing:-0.05em;line-height:1.05;margin-bottom:8px}
.hero-serif{display:block;font-family:'Newsreader',serif;font-style:italic;font-weight:300;font-size:clamp(1.4rem,4vw,2.2rem);color:hsl(0,0%,65%);letter-spacing:-0.02em;margin-bottom:14px}
.hero-sub{color:hsl(0,0%,55%);font-size:14px;letter-spacing:-0.01em;max-width:600px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin:36px 0}
.card{background:hsl(0,0%,11%);border:1px solid hsl(0,0%,20%);border-radius:12px;padding:18px;position:relative;overflow:hidden;transition:border-color 0.3s}
.card:hover{border-color:hsl(0,0%,30%)}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;border-radius:12px 12px 0 0;background:var(--accent)}
.card-status{--accent:linear-gradient(90deg,#22c55e,#16a34a)}
.card-version{--accent:linear-gradient(90deg,#3b82f6,#2563eb)}
.card-backend{--accent:linear-gradient(90deg,#8b5cf6,#7c3aed)}
.card-ping{--accent:linear-gradient(90deg,#fbbf24,#f59e0b)}
.card-docs{--accent:linear-gradient(90deg,#06b6d4,#0891b2)}
.card-wire{--accent:linear-gradient(90deg,#ec4899,#db2777)}
.card-label{font-size:9px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:hsl(0,0%,55%);margin-bottom:10px}
.card-value{font-family:'DM Mono',monospace;font-size:1.7rem;font-weight:300;line-height:1;margin-bottom:4px;font-variant-numeric:tabular-nums;letter-spacing:-0.02em;word-break:break-all}
.card-sub{font-size:10px;color:hsl(0,0%,45%);letter-spacing:0.02em;margin-top:8px}
.flash{animation:flash 0.6s ease-out}
@keyframes flash{0%{color:#3b82f6}100%{color:hsl(0,0%,98%)}}
.section{margin:36px 0}
.section-title{font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:hsl(0,0%,55%);margin-bottom:14px;display:flex;align-items:center;gap:8px}
.section-title::before{content:'';width:3px;height:14px;background:#3b82f6;border-radius:2px}
.actions{display:flex;flex-wrap:wrap;gap:10px}
button{background:hsl(0,0%,14%);border:1px solid hsl(0,0%,22%);color:hsl(0,0%,98%);padding:10px 18px;border-radius:8px;font-family:inherit;font-size:12px;font-weight:500;cursor:pointer;letter-spacing:-0.01em;transition:all 0.2s}
button:hover{background:hsl(0,0%,18%);border-color:#3b82f6}
button:disabled{opacity:0.5;cursor:not-allowed}
button.primary{background:#3b82f6;border-color:#3b82f6;color:white}
button.primary:hover{background:#2563eb}
button.danger{border-color:hsl(0,75%,50%,0.4);color:#fca5a5}
button.danger:hover{background:hsl(0,75%,50%,0.1)}
.feed{background:hsl(0,0%,11%);border:1px solid hsl(0,0%,20%);border-radius:12px;max-height:400px;overflow:auto;font-family:'DM Mono',monospace;font-size:11px}
.feed-row{padding:10px 16px;border-bottom:1px solid hsl(0,0%,14%);display:flex;gap:14px;align-items:flex-start;animation:slideIn 0.3s ease-out}
.feed-row:last-child{border-bottom:none}
@keyframes slideIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
.feed-time{color:hsl(0,0%,40%);min-width:65px;font-size:10px}
.feed-tag{color:#3b82f6;font-weight:600;min-width:80px;font-size:10px;text-transform:uppercase;letter-spacing:0.05em}
.feed-tag.ok{color:#22c55e}
.feed-tag.err{color:#ef4444}
.feed-msg{color:hsl(0,0%,80%);flex:1;word-break:break-word}
.feed-empty{padding:30px;text-align:center;color:hsl(0,0%,40%);font-family:inherit;font-size:13px}
.bench-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:14px}
.bench-card{background:hsl(0,0%,11%);border:1px solid hsl(0,0%,20%);border-radius:10px;padding:14px}
.bench-card h4{font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:hsl(0,0%,60%);margin-bottom:10px}
.bench-row{display:flex;justify-content:space-between;padding:4px 0;font-size:12px}
.bench-row .k{color:hsl(0,0%,55%)}
.bench-row .v{font-family:'DM Mono',monospace;color:hsl(0,0%,95%);font-variant-numeric:tabular-nums}
.compat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-top:14px}
.compat-pill{display:flex;align-items:center;justify-content:space-between;background:hsl(0,0%,11%);border:1px solid hsl(0,0%,20%);border-radius:8px;padding:10px 12px;font-size:11px}
.compat-name{color:hsl(0,0%,80%);font-weight:500}
.compat-state{font-size:10px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase}
.compat-state.ok{color:#22c55e}
.compat-state.err{color:#ef4444}
.compat-state.pending{color:hsl(0,0%,50%)}
.scorecard{display:grid;grid-template-columns:200px 1fr;gap:24px;background:hsl(0,0%,11%);border:1px solid hsl(0,0%,20%);border-radius:12px;padding:22px 24px;margin-bottom:16px;align-items:center}
.score-main{text-align:center}
.score-big{font-family:'DM Mono',monospace;font-size:3.2rem;font-weight:300;line-height:1;color:#3b82f6;letter-spacing:-0.04em}
.score-label{font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:hsl(0,0%,55%);margin-top:8px}
.score-bars{display:flex;flex-direction:column;gap:10px}
.score-bar{display:grid;grid-template-columns:140px 1fr 70px;gap:14px;align-items:center;font-size:12px}
.score-bar-name{color:hsl(0,0%,75%);font-weight:500}
.score-bar-track{height:8px;background:hsl(0,0%,16%);border-radius:4px;overflow:hidden;position:relative}
.score-bar-fill{position:absolute;left:0;top:0;bottom:0;width:0;background:linear-gradient(90deg,#3b82f6,#2563eb);border-radius:4px;transition:width 0.5s ease-out}
.score-bar-val{font-family:'DM Mono',monospace;color:hsl(0,0%,85%);font-size:11px;text-align:right;font-variant-numeric:tabular-nums}
@media(max-width:680px){.scorecard{grid-template-columns:1fr}.score-bar{grid-template-columns:1fr 1fr 60px}.score-bar-name{font-size:11px}}
.pattern-out{background:hsl(0,0%,11%);border:1px solid hsl(0,0%,20%);border-radius:12px;padding:16px;min-height:80px;margin-top:14px;font-size:12px;overflow-x:auto}
.pattern-narrative{color:#60a5fa;font-size:11px;margin-bottom:12px;padding:8px 12px;background:rgba(59,130,246,0.06);border-radius:6px;border-left:2px solid #3b82f6}
.pattern-block{background:hsl(0,0%,8%);border:1px solid hsl(0,0%,16%);border-radius:8px;padding:12px;margin-bottom:8px;font-family:'DM Mono',monospace;font-size:11px;color:hsl(0,0%,85%);white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto}
.pattern-block.tight{padding:8px 12px;font-size:11px}
.pattern-doc-row{display:grid;grid-template-columns:auto 1fr;gap:10px;padding:4px 0;border-bottom:1px solid hsl(0,0%,14%)}
.pattern-doc-row:last-child{border-bottom:none}
.pattern-doc-key{color:hsl(0,0%,50%);font-family:'DM Mono',monospace;font-size:10px}
.pattern-doc-val{color:hsl(0,0%,90%);font-family:'DM Mono',monospace;font-size:11px;word-break:break-word}
.pattern-step{display:grid;grid-template-columns:160px 1fr;gap:14px;padding:6px 0;border-bottom:1px dotted hsl(0,0%,18%)}
.pattern-step:last-child{border-bottom:none}
.pattern-step-op{color:#60a5fa;font-family:'DM Mono',monospace;font-size:11px}
.pattern-step-val{color:hsl(0,0%,90%);font-family:'DM Mono',monospace;font-size:11px}
.pattern-table{width:100%;border-collapse:collapse;font-family:'DM Mono',monospace;font-size:11px}
.pattern-table th{text-align:left;padding:6px 10px;border-bottom:1px solid hsl(0,0%,20%);color:hsl(0,0%,55%);font-weight:500;font-size:10px;text-transform:uppercase;letter-spacing:0.05em}
.pattern-table td{padding:6px 10px;border-bottom:1px solid hsl(0,0%,14%);color:hsl(0,0%,85%)}
.pattern-table tr:last-child td{border-bottom:none}
.diff-old{background:rgba(239,68,68,0.08);color:#fca5a5}
.diff-new{background:rgba(34,197,94,0.08);color:#86efac}
footer{padding:40px 0 60px;color:hsl(0,0%,40%);font-size:11px;text-align:center}
footer a{color:#60a5fa;text-decoration:none}
.muted{color:hsl(0,0%,50%);font-size:11px;margin-left:8px}
</style></head><body>
<div class="orbs"><div class="orb orb-1"></div><div class="orb orb-2"></div><div class="orb orb-3"></div></div>
<div class="wrap">
<nav class="nav"><div class="nav-logo">Ferret<span>DB</span> on Clever Cloud</div><div class="nav-pill"><span class="nav-dot"></span><span id="nav-status">Connecting…</span></div></nav>
<section class="hero">
<div class="live-badge"><span class="live-dot"></span>Live demo</div>
<h1>FerretDB</h1>
<div class="hero-serif">MongoDB API on Postgres, on Clever Cloud</div>
<p class="hero-sub">Cette page parle Mongo wire protocol à FerretDB via le Network Group, qui parle SQL/TLS à un add-on PostgreSQL managé. Polling auto toutes les 2 secondes.</p>
</section>
<div class="section-title">État de la connexion</div>
<div class="grid">
<div class="card card-status"><div class="card-label">Status</div><div class="card-value" id="m-status">—</div><div class="card-sub" id="m-status-sub">…</div></div>
<div class="card card-ping"><div class="card-label">Ping</div><div class="card-value" id="m-ping">—</div><div class="card-sub">via Network Group</div></div>
<div class="card card-wire"><div class="card-label">Wire protocol</div><div class="card-value" id="m-wire">—</div><div class="card-sub" id="m-wire-sub">MongoDB compat</div></div>
<div class="card card-version"><div class="card-label">FerretDB version</div><div class="card-value" id="m-version">—</div><div class="card-sub">binary version</div></div>
<div class="card card-backend"><div class="card-label">Backend</div><div class="card-value" id="m-backend" style="font-size:1.1rem">—</div><div class="card-sub" id="m-target">…</div></div>
<div class="card card-docs"><div class="card-label">Docs dashboard</div><div class="card-value" id="m-docs">—</div><div class="card-sub">collection « dashboard »</div></div>
</div>
<section class="section">
<div class="section-title">Actions interactives</div>
<div class="actions">
<button class="primary" id="btn-insert">+ Insérer un doc</button>
<button id="btn-find">Find latest 20</button>
<button id="btn-aggregate">Aggregation $group</button>
<button id="btn-bench">⚡ Quick bench (800 ops)</button>
<button class="danger" id="btn-drop">Drop dashboard collection</button>
</div>
</section>
<section class="section">
<div class="section-title">Activity feed</div>
<div class="feed" id="feed"><div class="feed-empty">Pas encore d'activité — clique sur une action ci-dessus</div></div>
</section>
<section class="section">
<div class="section-title">Patterns MongoDB réels — cas d'usage app concrets</div>
<div class="actions">
<button id="pat-schema">Schema flexibility (3 shapes même collection)</button>
<button id="pat-paginate">Filter + sort + paginate</button>
<button id="pat-nested">Update champ imbriqué ($set 'address.city')</button>
<button id="pat-array">Array ops ($push / $addToSet / $pull)</button>
<button id="pat-upsert">Upsert idempotent</button>
<button id="pat-distinct">distinct('category')</button>
<button id="pat-operators">$and + $or + $in + $exists</button>
</div>
<div class="pattern-out" id="pattern-out"><div class="feed-empty" style="padding:30px;text-align:center;color:hsl(0,0%,40%)">Clique sur un pattern pour voir le résultat ici</div></div>
</section>

<section class="section">
<div class="section-title">Latency budget — où va le temps</div>
<p class="muted" style="margin:0 0 12px 0">3 mesures réelles (15 itérations chacune) pour décomposer le RTT entre les couches</p>
<div class="actions"><button id="btn-latency">Mesurer les hops</button></div>
<div class="pattern-out" id="latency-out" style="margin-top:14px"></div>
</section>

<section class="section">
<div class="section-title">Plan SQL sous le capot</div>
<p class="muted" style="margin:0 0 12px 0">FerretDB traduit chaque requête Mongo en SQL côté PostgreSQL. <code>explain()</code> retourne le plan PG, preuve directe.</p>
<div class="actions">
<button id="btn-explain-small">Plan PG · petite table (200 docs)</button>
<button id="btn-explain-large">Plan PG · 10k docs, filtre sur champ</button>
<button id="btn-explain-byid">Plan PG · 10k docs, lookup par _id (Index Scan ✓)</button>
</div>
<div class="pattern-out" id="explain-out" style="margin-top:14px"></div>
</section>

<section class="section" id="bench-section" style="display:none">
<div class="section-title">Dernier quick bench</div>
<div class="bench-grid" id="bench-grid"></div>
</section>
<section class="section">
<div class="section-title">Compatibilité MongoDB testée live</div>
<div class="scorecard" id="scorecard">
  <div class="score-main">
    <div class="score-big" id="score-big">—</div>
    <div class="score-label">features Mongo supportées</div>
  </div>
  <div class="score-bars">
    <div class="score-bar" data-cat="crud"><span class="score-bar-name">CRUD &amp; queries</span><span class="score-bar-track"><span class="score-bar-fill" id="bar-crud"></span></span><span class="score-bar-val" id="val-crud">…</span></div>
    <div class="score-bar" data-cat="index"><span class="score-bar-name">Indexing</span><span class="score-bar-track"><span class="score-bar-fill" id="bar-index"></span></span><span class="score-bar-val" id="val-index">…</span></div>
    <div class="score-bar" data-cat="agg"><span class="score-bar-name">Aggregation</span><span class="score-bar-track"><span class="score-bar-fill" id="bar-agg"></span></span><span class="score-bar-val" id="val-agg">…</span></div>
    <div class="score-bar" data-cat="adv"><span class="score-bar-name">Advanced</span><span class="score-bar-track"><span class="score-bar-fill" id="bar-adv"></span></span><span class="score-bar-val" id="val-adv">…</span></div>
  </div>
</div>
<div class="compat-grid" id="compat-grid">
<div class="compat-pill"><span class="compat-name">CRUD complet</span><span class="compat-state pending" data-test="crud" data-cat="crud">pending</span></div>
<div class="compat-pill"><span class="compat-name">$regex</span><span class="compat-state pending" data-test="regex" data-cat="crud">pending</span></div>
<div class="compat-pill"><span class="compat-name">bulkWrite</span><span class="compat-state pending" data-test="bulk_write" data-cat="crud">pending</span></div>
<div class="compat-pill"><span class="compat-name">Index simple</span><span class="compat-state pending" data-test="index_simple" data-cat="index">pending</span></div>
<div class="compat-pill"><span class="compat-name">Index unique</span><span class="compat-state pending" data-test="index_unique" data-cat="index">pending</span></div>
<div class="compat-pill"><span class="compat-name">Index composé</span><span class="compat-state pending" data-test="index_compound" data-cat="index">pending</span></div>
<div class="compat-pill"><span class="compat-name">$text search</span><span class="compat-state pending" data-test="text_search" data-cat="index">pending</span></div>
<div class="compat-pill"><span class="compat-name">$group + $sum</span><span class="compat-state pending" data-test="group_sum" data-cat="agg">pending</span></div>
<div class="compat-pill"><span class="compat-name">$group + $avg</span><span class="compat-state pending" data-test="group_avg" data-cat="agg">pending</span></div>
<div class="compat-pill"><span class="compat-name">$group + $max/$min</span><span class="compat-state pending" data-test="group_max_min" data-cat="agg">pending</span></div>
<div class="compat-pill"><span class="compat-name">$sample</span><span class="compat-state pending" data-test="sample" data-cat="agg">pending</span></div>
<div class="compat-pill"><span class="compat-name">$lookup (JOIN)</span><span class="compat-state pending" data-test="lookup" data-cat="agg">pending</span></div>
<div class="compat-pill"><span class="compat-name">Transactions multi-doc</span><span class="compat-state pending" data-test="transaction" data-cat="adv">pending</span></div>
<div class="compat-pill"><span class="compat-name">Change streams</span><span class="compat-state pending" data-test="change_stream" data-cat="adv">pending</span></div>
</div>
<div class="actions" style="margin-top:14px"><button id="btn-compat">Lancer les tests compat</button></div>
</section>
<footer>Vitio1 · par · FerretDB <span id="ft-version">…</span> · target <span id="ft-target">…</span> · <a href="/server/info">/server/info</a> · <a href="/bench">/bench (full)</a> · <a href="/diag">/diag</a></footer>
</div>
<div id="js-debug" style="position:fixed;bottom:10px;right:10px;max-width:520px;max-height:300px;overflow:auto;background:rgba(20,0,0,0.95);border:1px solid #ef4444;border-radius:8px;padding:10px;font-family:monospace;font-size:11px;color:#fca5a5;z-index:9999;display:none">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
<strong style="color:#fef2f2">JS errors (debug)</strong>
<button onclick="document.getElementById('js-debug').style.display='none'" style="background:transparent;border:1px solid #ef4444;color:#fca5a5;padding:2px 8px;cursor:pointer;font-size:10px">✕</button>
</div>
<div id="js-debug-content"></div>
</div>
<script src="/app.js"></script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // HTML dashboard on root
  if (url === '/' || url === '/dashboard') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(DASHBOARD_HTML);
    return;
  }
  // External JS bundle (avoids inline-script blocking by browser extensions / CSP)
  if (url === '/app.js') {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(DASHBOARD_JS);
    return;
  }

  res.setHeader('Content-Type', 'application/json');

  if (routes[url]) {
    try {
      const out = await routes[url]();
      res.end(JSON.stringify(out, null, 2));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message, name: e.name, code: e.code, codeName: e.codeName }, null, 2));
    }
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found', endpoints: Object.keys(routes), dashboard: '/' }, null, 2));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Listening on :${PORT}, target ${MONGO_HOST}:${MONGO_PORT}`);
});
