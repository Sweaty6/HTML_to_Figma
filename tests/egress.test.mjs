import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';
import { startBrowserProxy } from '../egress.mjs';

async function through(proxy, url, { method = 'GET', headers } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(proxy, { path: url, method, headers }, async response => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() });
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
    request.end();
  });
}

async function tunnel(proxy, destination) {
  const socket = connect(Number(new URL(proxy).port), '127.0.0.1');
  const chunks = [];
  socket.write(`CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n\r\n`);
  for await (const chunk of socket) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test('browser proxy rejects nonpublic addresses, credentials, and nonstandard ports', async t => {
  const proxy = await startBrowserProxy();
  t.after(proxy.close);
  for (const url of [
    'http://127.0.0.1', 'http://2130706433', 'http://[::ffff:127.0.0.1]',
    'http://169.254.169.254/', 'http://192.168.2.5/', 'http://100.64.0.1/',
    'http://[fd00:42::1]/', 'http://[2002:7f00:1::1]/',
    'http://user:pass@8.8.8.8/', 'http://8.8.8.8:81/',
  ]) {
    assert.equal((await through(proxy.server, url)).status, 403, url);
  }
  assert.match(await tunnel(proxy.server, '127.0.0.1:443'), /^HTTP\/1.1 403 Forbidden/);
  assert.match(await tunnel(proxy.server, '8.8.8.8:444'), /^HTTP\/1.1 403 Forbidden/);
});

test('browser proxy permits one explicitly configured loopback origin for development', async t => {
  let hits = 0;
  const target = http.createServer((req, res) => {
    hits++;
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://127.0.0.1:9752/private' });
      return res.end();
    }
    res.end(`${req.method} ${req.url} ${req.headers.host}`);
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  t.after(() => new Promise(resolve => target.close(resolve)));
  const { port } = target.address();
  const origin = `http://127.0.0.1:${port}`;
  await assert.rejects(startBrowserProxy({ allowedLocalOrigin: origin, workerPort: port }), /H2F_ALLOW_LOCAL_ORIGIN/);
  const proxy = await startBrowserProxy({ allowedLocalOrigin: origin });
  t.after(proxy.close);
  const allowed = await through(proxy.server, `${origin}/design?q=layout`, { headers: { Host: 'other.example' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body, `GET /design?q=layout 127.0.0.1:${port}`);
  assert.equal((await through(proxy.server, origin, { method: 'POST' })).status, 403);
  assert.equal((await through(proxy.server, `http://localhost:${port}/`)).status, 403);
  const redirect = await through(proxy.server, `${origin}/redirect`);
  assert.equal(redirect.status, 302);
  assert.equal((await through(proxy.server, redirect.headers.location)).status, 403);
  assert.equal(hits, 2);
});
