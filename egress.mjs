import { lookup } from 'node:dns/promises';
import http from 'node:http';
import { BlockList, connect, isIP } from 'node:net';
import { once } from 'node:events';

const deniedV4 = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) deniedV4.addSubnet(address, bits, 'ipv4');

const publicV6 = new BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');
const deniedV6 = new BlockList();
for (const [address, bits] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) deniedV6.addSubnet(address, bits, 'ipv6');

function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !deniedV4.check(address, 'ipv4');
  if (family === 6) return publicV6.check(address, 'ipv6') && !deniedV6.check(address, 'ipv6');
  return false;
}

const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const hopByHop = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
]);
const deniedMessage = 'Network destination is blocked by the capture worker.';

function endConnect(socket, status) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function cleanHeaders(headers) {
  const nominated = new Set(String(headers.connection || '').toLowerCase().split(',').map(value => value.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !hopByHop.has(name) && !nominated.has(name)));
}

function parseLocalOrigin(origin, workerPort) {
  if (!origin) return null;
  const url = new URL(origin);
  const address = new Map([['localhost', '127.0.0.1'], ['127.0.0.1', '127.0.0.1'], ['[::1]', '::1']]).get(url.hostname);
  if (url.protocol !== 'http:' || url.origin !== origin || !address || !url.port || Number(url.port) === Number(workerPort)) {
    throw new Error('H2F_ALLOW_LOCAL_ORIGIN должен быть точным HTTP-адресом loopback с отдельным портом.');
  }
  return { origin, address, port: Number(url.port) };
}

function parseDestination(raw, connectRequest) {
  if (connectRequest) {
    if (!/^(?:\[[a-f\d:.]+\]|[a-z\d.-]+):443$/i.test(raw)) return null;
    return new URL(`https://${raw}`);
  }
  if (!raw.startsWith('http://')) return null;
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password) return null;
  return parsed;
}

async function resolveDestination(url, local, tls) {
  if (!url) return null;
  if (!tls && local?.origin === url.origin) {
    return { ...local, family: isIP(local.address) };
  }
  if (url.port) return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  if (!family && !hostname.includes('.')) return null;
  const entries = family
    ? [{ address: hostname, family }]
    : await lookup(`${hostname.replace(/\.$/, '')}.`, { all: true, order: 'ipv4first' });
  if (!entries.length || entries.some(({ address }) => !publicAddress(address))) return null;
  return { ...entries[0], port: tls ? 443 : 80 };
}

export async function startBrowserProxy({ allowedLocalOrigin, workerPort } = {}) {
  const local = parseLocalOrigin(allowedLocalOrigin, workerPort);
  const sockets = new Set();
  function track(socket) {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(30_000, () => socket.destroy());
    return socket;
  }

  const proxy = http.createServer({ headersTimeout: 10_000, requestTimeout: 15_000 }, async (req, res) => {
    const deny = () => {
      res.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end(deniedMessage);
    };
    try {
      if (!readMethods.has(req.method) || req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0) return deny();
      const url = parseDestination(req.url, false);
      const destination = await resolveDestination(url, local, false);
      if (!destination) return deny();
      if (res.destroyed) return;
      const upstream = http.request({
        hostname: destination.address, family: destination.family, port: destination.port,
        path: url.pathname + url.search, method: req.method, agent: false,
        headers: { ...cleanHeaders(req.headers), host: url.host, connection: 'close' },
      }, response => {
        res.writeHead(response.statusCode, cleanHeaders(response.headers));
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      upstream.on('socket', track);
      upstream.on('error', () => {
        if (res.destroyed) return;
        if (res.headersSent) res.destroy();
        else { res.writeHead(502); res.end('Could not connect to the target.'); }
      });
      res.once('close', () => upstream.destroy());
      upstream.end();
    } catch {
      if (!res.destroyed) deny();
    }
  });
  proxy.maxConnections = 128;
  proxy.on('connection', track);
  proxy.on('upgrade', (_req, socket) => endConnect(socket, '403 Forbidden'));
  proxy.on('connect', async (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const deny = () => endConnect(socket, '403 Forbidden');
    try {
      const url = parseDestination(req.url, true);
      const destination = await resolveDestination(url, local, true);
      if (!destination) return deny();
      if (socket.destroyed) return;
      const upstream = track(connect({ host: destination.address, family: destination.family, port: destination.port }));
      let established = false;
      socket.once('close', () => upstream.destroy());
      upstream.on('error', () => {
        if (established) socket.destroy();
        else endConnect(socket, '502 Bad Gateway');
      });
      upstream.once('close', () => socket.end());
      upstream.once('connect', () => {
        established = true;
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
    } catch {
      deny();
    }
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
  };
  const { port } = proxy.address();
  if (local?.port === port) {
    await close();
    throw new Error('The local capture origin conflicts with the proxy port.');
  }
  return { server: `http://127.0.0.1:${port}`, close };
}
