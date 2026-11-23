import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { captureSite } from './capture.mjs';
import { createNativeFig } from './convert.mjs';
import { startBrowserProxy } from './egress.mjs';
import { createControlRanker } from './ai-planner.mjs';

const host = process.env.H2F_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4318);
const token = process.env.H2F_TOKEN || '';
const allowedLocalOrigin = process.env.H2F_ALLOW_LOCAL_ORIGIN || undefined;
const rankControls = createControlRanker();
const localHosts = new Set();
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']).has(host);
if (!loopback && token.length < 32) {
  throw Error('Для сетевого доступа задайте H2F_TOKEN длиной не менее 32 символов');
}
if (allowedLocalOrigin && !loopback) throw Error('Локальный источник доступен лишь в локальном режиме');

const allowedOrigins = new Set();
for (const value of (process.env.H2F_ALLOWED_ORIGIN || '').split(',').map(item => item.trim()).filter(Boolean)) {
  const origin = new URL(value);
  if (origin.protocol !== 'https:' || origin.origin !== value) throw Error('H2F_ALLOWED_ORIGIN принимает HTTPS origin без пути');
  allowedOrigins.add(value);
}

const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/example.html', ['example.html', 'text/html; charset=utf-8']],
  ['/studio.css', ['studio.css', 'text/css; charset=utf-8']],
  ['/studio.js', ['studio.js', 'text/javascript; charset=utf-8']]
]);
const jobs = new Map();
const maxRequestSize = 1_200_000;
const ttlMs = 30 * 60_000;
let activeJob;
let stopping = false;

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers
  });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });
}

function authorize(req) {
  if (!token) return true;
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readInput(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw Error('Ожидается application/json');
  let length = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxRequestSize) throw Error('Размер запроса превышает 1,2 МБ');
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Error('Некорректный JSON'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Ожидается объект JSON');
  const html = typeof input.html === 'string' ? input.html : '';
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!html.trim() && !url) throw Error('Укажите URL или HTML');
  if (!html.trim()) {
    try {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error();
    } catch {
      throw Error('Укажите HTTP(S)-ссылку без логина и пароля');
    }
  }
  return {
    html, url, width: input.width, maxNodes: input.maxNodes,
    maxStates: input.explore === true ? input.maxStates ?? 12 : 1,
    explore: input.explore === true,
    animationDelayMs: input.animationDelayMs,
    fullPage: input.fullPage !== false,
    includeReference: input.includeReference !== false,
    aiAssist: input.explore === true && input.aiAssist === true
  };
}

function publicJob(job) {
  const { id, status, progress, result, error } = job;
  return { id, status, progress, result, error };
}

function removeExpiredJobs() {
  for (const [id, job] of jobs) {
    if (job.finished && Date.now() - job.finished > ttlMs) jobs.delete(id);
  }
}

async function runJob(job, input) {
  job.status = 'running';
  let proxy;
  try {
    proxy = await startBrowserProxy({ allowedLocalOrigin, workerPort: server.address().port });
    const captured = await captureSite({
      ...input,
      browserProxy: { server: proxy.server },
      rankControls: input.aiAssist ? rankControls : undefined,
      onProgress: update => {
        const { stage, captures, attemptedActions } = update;
        job.progress = { stage, captures, attemptedActions };
      }
    });
    job.progress = { ...job.progress, stage: 'exporting' };
    const first = captured.states[0];
    let figError;
    let output;
    try {
      output = await createNativeFig(captured, { includeReference: input.includeReference });
    } catch (error) {
      figError = String(error.message || error).slice(0, 500);
    }
    job.fig = output?.bytes;
    job.captured = captured;
    job.result = {
      title: first.title,
      width: first.width,
      height: first.height,
      editable: captured.states.reduce((total, state) => total + state.items.length, 0),
      images: output?.images ?? captured.states.reduce((total, state) => total + Object.keys(state.assets).length, 0),
      figReady: Boolean(job.fig), figError,
      states: captured.states.map(({ id, title, url, action, path, width, height, items }) =>
        ({ id, title, url, action, path, width, height, editable: items.length })),
      report: captured.report
    };
    job.status = 'done';
    job.progress = { ...job.progress, stage: 'done' };
  } catch (error) {
    job.status = 'failed';
    job.error = String(error.message || error).slice(0, 600);
  } finally {
    try { await proxy?.close(); }
    finally {
      job.finished = Date.now();
      activeJob = undefined;
    }
  }
}

function download(res, job, format, requestURL) {
  if (!job || job.status !== 'done') return json(res, 404, { error: 'Результат пока недоступен или истёк' });
  const name = String(job.result.title || 'design').slice(0, 70).replace(/[^a-z0-9а-яё_-]+/gi, '_') || 'design';
  if (format === 'fig') {
    if (!job.fig) return json(res, 409, { error: job.result.figError || 'Файл .fig не создан' });
    return send(res, 200, job.fig, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.fig`
    });
  }
  if (format === 'json') {
    const { states, report } = job.captured;
    const metadata = states.map(({ preview, thumbnail, assets, ...state }) => ({
      ...state,
      assets: Object.fromEntries(Object.entries(assets).map(([id, { width, height }]) => [id, { width, height }]))
    }));
    return send(res, 200, JSON.stringify({ format: 'h2f-studio-v2', states: metadata, report }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.json`
    });
  }
  const rawIndex = requestURL.searchParams.get('state') ?? '0';
  const index = /^\d+$/.test(rawIndex) ? Number(rawIndex) : -1;
  const state = job.captured.states[index];
  if (!state) return json(res, 404, { error: 'Состояние не найдено' });
  return send(res, 200, Buffer.from(format === 'png' ? state.preview : state.thumbnail, 'base64'), {
    'Content-Type': 'image/png',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}-${index + 1}.png`
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const origin = req.headers.origin;
    if (loopback && !localHosts.has(req.headers.host)) return json(res, 403, { error: 'Недопустимый адрес сервера' });
    if (origin && !allowedOrigins.has(origin)) return json(res, 403, { error: 'Этот сайт не подключён к обработчику' });
    const requestURL = new URL(req.url, 'http://localhost');
    const { pathname } = requestURL;
    const api = pathname.startsWith('/api/');
    if (origin && api) {
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    }
    if (api && req.method === 'OPTIONS' && origin) {
      const headers = {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '300'
      };
      if (req.headers['access-control-request-private-network'] === 'true') {
        headers['Access-Control-Allow-Private-Network'] = 'true';
      }
      return send(res, 204, undefined, headers);
    }
    if (api && !authorize(req)) return json(res, 401, { error: 'Требуется токен обработчика' });

    if (req.method === 'GET' && publicFiles.has(pathname)) {
      const [file, type] = publicFiles.get(pathname);
      return send(res, 200, await readFile(new URL(`./public/${file}`, import.meta.url)), { 'Content-Type': type });
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { status: 'ok', nativeFig: true, aiAvailable: Boolean(rankControls) });
    }
    removeExpiredJobs();
    if (req.method === 'POST' && pathname === '/api/convert') {
      if (stopping || activeJob) return json(res, 429, { error: 'Обработчик занят другой конвертацией' });
      const input = await readInput(req);
      if (stopping || activeJob) return json(res, 429, { error: 'Обработчик занят другой конвертацией' });
      if (input.aiAssist && !rankControls) return json(res, 400, { error: 'Модель ИИ на обработчике не настроена' });
      while (jobs.size >= 3) jobs.delete(jobs.keys().next().value);
      const job = {
        id: randomUUID(), status: 'queued',
        progress: { stage: 'queued', captures: 0, attemptedActions: 0 }
      };
      jobs.set(job.id, job);
      activeJob = job;
      json(res, 202, publicJob(job));
      setImmediate(() => {
        runJob(job, input).catch(() => {});
      });
      return;
    }
    const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})$/);
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      return job ? json(res, 200, publicJob(job)) : json(res, 404, { error: 'Задание не найдено' });
    }
    const fileMatch = pathname.match(/^\/api\/download\/([a-f0-9-]{36})\/(fig|json|png|thumbnail)$/);
    if (req.method === 'GET' && fileMatch) return download(res, jobs.get(fileMatch[1]), fileMatch[2], requestURL);
    return json(res, 404, { error: 'Маршрут не найден' });
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    return json(res, 400, { error: String(error.message || error).slice(0, 500) });
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(port, host, () => {
  const boundPort = server.address().port;
  for (const name of ['127.0.0.1', 'localhost', '[::1]']) {
    const authority = `${name}:${boundPort}`;
    localHosts.add(authority);
    allowedOrigins.add(`http://${authority}`);
  }
  console.log(`HTML → FIG Studio · http://${host}:${boundPort}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    stopping = true;
    server.close(() => process.exit(0));
  });
}
