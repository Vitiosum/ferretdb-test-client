import http from 'node:http';
import { MongoClient } from 'mongodb';

const PORT = process.env.PORT || 8080;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('MONGO_URI manquant');
  process.exit(1);
}

let client;
async function getDb() {
  if (!client) {
    client = new MongoClient(MONGO_URI, { retryWrites: false });
    await client.connect();
    console.log('✓ Connecté à FerretDB');
  }
  return client.db('test');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const db = await getDb();
    const col = db.collection('items');

    if (req.url === '/health') {
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === '/test') {
      const doc = { ts: new Date().toISOString(), msg: 'hello from ferretdb-test-client' };
      const ins = await col.insertOne(doc);
      const all = await col.find({}).limit(10).toArray();
      const count = await col.countDocuments();
      res.end(JSON.stringify({ inserted: ins.insertedId, count, last10: all }, null, 2));
      return;
    }

    res.end(JSON.stringify({
      hint: 'GET /test pour insert+find, GET /health pour health check',
      mongo_uri_set: true,
    }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message, stack: e.stack }, null, 2));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Listening on :${PORT}`);
});
