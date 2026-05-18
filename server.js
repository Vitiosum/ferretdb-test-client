import http from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';
import { URL } from 'node:url';
import { MongoClient } from 'mongodb';

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

    // 3. FIND BY _id (500 lookups random)
    const sample = await col.aggregate([{ $sample: { size: 500 } }, { $project: { _id: 1 } }]).toArray();
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
        { $group: { _id: '$kind', cnt: { $sum: 1 }, avg_v: { $avg: '$v' }, max_v: { $max: '$v' } } },
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
    const cols = ['items', 'crud_test', 'agg_test', 'idx_test', 'bulk_test'];
    const out = {};
    for (const c of cols) {
      try { await db.collection(c).drop(); out[c] = 'dropped'; } catch (e) { out[c] = e.codeName || e.message; }
    }
    return out;
  },
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = req.url.split('?')[0];

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

  res.end(JSON.stringify({
    endpoints: Object.keys(routes),
    target: `${MONGO_HOST}:${MONGO_PORT}`,
  }, null, 2));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Listening on :${PORT}, target ${MONGO_HOST}:${MONGO_PORT}`);
});
