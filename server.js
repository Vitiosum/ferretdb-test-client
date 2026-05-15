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

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/health') {
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === '/diag') {
    const out = { host: MONGO_HOST, port: MONGO_PORT };
    try { out.dns_a = await dns.resolve4(MONGO_HOST); } catch (e) { out.dns_a_error = e.message + ' (' + e.code + ')'; }
    try { out.dns_aaaa = await dns.resolve6(MONGO_HOST); } catch (e) { out.dns_aaaa_error = e.message + ' (' + e.code + ')'; }
    try { out.dns_lookup = await dns.lookup(MONGO_HOST, { all: true }); } catch (e) { out.dns_lookup_error = e.message + ' (' + e.code + ')'; }
    out.tcp = await tcpProbe(MONGO_HOST, MONGO_PORT);
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  try {
    const db = await getDb();
    const col = db.collection('items');

    if (req.url === '/test') {
      const doc = { ts: new Date().toISOString(), msg: 'hello from ferretdb-test-client' };
      const ins = await col.insertOne(doc);
      const all = await col.find({}).limit(10).toArray();
      const count = await col.countDocuments();
      res.end(JSON.stringify({ inserted: ins.insertedId, count, last10: all }, null, 2));
      return;
    }

    res.end(JSON.stringify({
      hint: 'GET /test pour insert+find, GET /diag pour réseau, GET /health',
    }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message, name: e.name, code: e.code, cause: e.cause?.message }, null, 2));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Listening on :${PORT}, target ${MONGO_HOST}:${MONGO_PORT}`);
});
