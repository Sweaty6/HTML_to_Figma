import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { parseFig } from 'openfig-core';

const origin = 'https://sweaty6.github.io';

async function waitForJob(base, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await fetch(`${base}/api/jobs/${id}`);
    assert.equal(response.status, 200);
    const job = await response.json();
    if (job.status === 'done' || job.status === 'failed') return job;
    await delay(150);
  }
  assert.fail('Worker did not finish the conversion');
}

test('worker scans an interactive URL and exports editable FIG frames and per-state PNGs', { timeout: 55_000 }, async t => {
  let writes = 0;
  const fixture = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/write') writes++;
    if (req.url === '/details') return res.end('<title>Details page</title><main><h1>Details route</h1></main>');
    res.end(`<!doctype html><title>Fixture</title><style>.fade { animation: appear .24s ease both } @keyframes appear { from { opacity:0 } to { opacity:1 } }</style>
      <main><h1>Start screen</h1><a href="/details">Details page</a>
      <button aria-expanded="false" onclick="this.setAttribute('aria-expanded', 'true'); panel.hidden=false">Open menu</button>
      <section hidden id="panel" class="fade"><h2>Menu content</h2><details><summary>Read more</summary><p>Nested information</p></details></section>
      <form action="/write" method="POST"><button>Submit purchase</button></form></main>`);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: {
      ...process.env,
      PORT: '0',
      H2F_HOST: '127.0.0.1',
      H2F_TOKEN: '',
      H2F_ALLOWED_ORIGIN: origin,
      H2F_ALLOW_LOCAL_ORIGIN: fixtureOrigin
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
  });
  let serverLog = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { serverLog += chunk; });
  const base = await new Promise((resolve, reject) => {
    const startupTimeout = setTimeout(() => reject(Error(`Worker did not start: ${serverLog}`)), 5000);
    t.after(() => clearTimeout(startupTimeout));
    child.once('error', reject);
    child.once('exit', code => reject(Error(`Worker exited (${code}): ${serverLog}`)));
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(startupTimeout);
        resolve(match[0]);
      }
    });
  });

  const preflight = await fetch(`${base}/api/convert`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type',
      'Access-Control-Request-Private-Network': 'true'
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
  const rejected = await fetch(`${base}/api/health`, { headers: { Origin: 'https://unconfigured.example' } });
  assert.equal(rejected.status, 403);
  const ui = await fetch(base);
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /HTML.*FIG/i);

  const response = await fetch(`${base}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ url: fixtureOrigin, width: 390, explore: true, maxStates: 6, animationDelayMs: 300, fullPage: false })
  });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  const job = await waitForJob(base, id);
  assert.equal(job.status, 'done', job.error);
  assert.ok(job.result.figReady, job.result.figError);
  assert.ok(job.result.states.length >= 4);
  assert.ok(job.result.states.some(state => state.url.endsWith('/details')));
  assert.equal(writes, 0);

  const fig = await fetch(`${base}/api/download/${id}/fig`);
  assert.equal(fig.status, 200);
  const document = parseFig(new Uint8Array(await fig.arrayBuffer()));
  const texts = document.nodes.filter(node => node.type === 'TEXT').map(node => node.textData?.characters);
  for (const text of ['Start screen', 'Details route', 'Menu content', 'Nested information']) {
    assert.ok(texts.includes(text), `Missing layer: ${text}`);
  }
  const png = await fetch(`${base}/api/download/${id}/png?state=1`);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await png.arrayBuffer()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const invalidState = await fetch(`${base}/api/download/${id}/png?state=999`);
  assert.equal(invalidState.status, 404);
});
