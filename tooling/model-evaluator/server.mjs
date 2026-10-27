import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configuration, discover } from './connection.mjs';
import { Evaluation } from './evaluation.mjs';

export async function startServer({ port = 51130, directory = join(homedir(), '.model-evaluator') } = {}) {
  const evaluator = new Evaluation(directory);
  await evaluator.initialize();
  const token = randomBytes(32).toString('hex');
  const files = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
  const pending = new Set();
  const server = createServer(async (req, res) => {
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
      res.end(type === 'application/json' ? JSON.stringify(data) : data);
    };
    try {
      if (req.headers.host !== `127.0.0.1:${server.address().port}` ||
          (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${server.address().port}`)) return send(403, { error: 'Access denied.' });
      const url = new URL(req.url, 'http://127.0.0.1');
      const file = files.get(url.pathname);
      if (req.method === 'GET' && file) return send(200, await readFile(new URL(file[0], import.meta.url), 'utf8'), file[1]);
      const provided = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (Buffer.byteLength(provided) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) return send(401, { error: 'Open the access URL printed by this evaluator process.' });
      if (req.method === 'GET' && url.pathname === '/api/reports') return send(200, evaluator.list());
      if (req.method === 'GET' && url.pathname.startsWith('/api/report/')) {
        const report = evaluator.reports.get(url.pathname.slice('/api/report/'.length));
        return report ? send(200, report) : send(404, { error: 'Report not found.' });
      }
      if (req.method !== 'POST') return send(404, { error: 'Not found.' });
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 32768) return send(413, { error: 'Request too large.' }); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (url.pathname === '/api/models') {
        if (pending.size >= 2) throw Error('Model discovery is busy.');
        const abort = new AbortController(); pending.add(abort);
        const onClose = () => abort.abort(); res.once('close', onClose);
        try { return send(200, await discover(configuration(input), abort.signal)); }
        finally { res.off('close', onClose); pending.delete(abort); }
      }
      if (url.pathname === '/api/start') return send(200, { id: await evaluator.start(configuration(input)) });
      if (url.pathname === '/api/cancel') { evaluator.cancel(input.id); return send(200, { ok: true }); }
      if (url.pathname === '/api/delete') { await evaluator.delete(input.id); return send(200, { ok: true }); }
      return send(404, { error: 'Not found.' });
    } catch(error) { return send(400, { error: error instanceof Error ? error.message : 'Request failed.' }); }
  });
  server.requestTimeout = 30000;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, token, evaluator, async close() {
    for(const abort of pending) abort.abort();
    await evaluator.close(); server.closeAllConnections();
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  } };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const instance = await startServer({ port: Number(process.env.MODEL_EVALUATOR_PORT ?? 51130),
    directory: process.env.MODEL_EVALUATOR_DATA_DIR || join(homedir(), '.model-evaluator') });
  console.log(`Model Evaluator: ${instance.url}/#token=${instance.token}`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (closing) return; closing = true;
    void instance.close().catch(error => { console.error(error.message); process.exitCode = 1; });
  });
}
