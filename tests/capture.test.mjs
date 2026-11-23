import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { PNG } from 'pngjs';
import { captureSite } from '../capture.mjs';

test('captures navigated pages and nested UI states after transitions', async t => {
  const unexpected = [];
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/') {
      res.end(`<!doctype html><title>Портал</title>
        <h1>Начало</h1>
        <a href="/catalog">Каталог</a>
        <a href="/alternate">Альтернативный адрес</a>
        <a href="/download" download>Файл</a>
        <a href="/new-window" target="_blank">Новое окно</a>
        <button onclick="fetch('/write',{method:'POST'})">Проверка</button>
        <button id="detail" aria-controls="panel">Меню</button>
        <button onclick="fetch('/delete')">Удалить</button>
        <form action="/submit"><button>Продолжить</button></form>
        <dialog id="panel"><h2>Раскрытое меню</h2><button id="submenu">Показать вкладку</button>
          <p id="extra" hidden>Детали вкладки</p><button id="dismiss">Закрыть</button></dialog>
        <script>
          detail.onclick = () => setTimeout(() => panel.showModal(), 65);
          submenu.onclick = () => setTimeout(() => { extra.hidden = false; }, 65);
          dismiss.onclick = () => panel.close();
        </script>`);
    } else if (req.url === '/catalog') {
      res.writeHead(302, { Location: '/product' }).end();
    } else if (req.url === '/product' || req.url === '/alternate') {
      res.end(`<!doctype html><title>Каталог</title><h1>Товары</h1>
        <main style="height:1500px;background:linear-gradient(white,navy)">Градиент</main>`);
    } else {
      if (req.url !== '/favicon.ico') unexpected.push(req.url);
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const rankControls = ({ controls }) => {
    const link = controls.findIndex(control => control.kind === 'link');
    return [999, link, link];
  };
  const result = await captureSite({
    url: `http://127.0.0.1:${server.address().port}`,
    width: 420, animationDelayMs: 100, maxStates: 8, maxActions: 10, timeoutMs: 25_000, rankControls,
  });
  const strings = state => state.items.filter(item => item.kind === 'text').map(item => item.text);
  assert.equal(result.states[0].action, 'Входная страница');
  assert.deepEqual(result.states[1].path, ['Каталог']);
  assert.equal(new URL(result.states[1].url).pathname, '/product');
  assert.ok(strings(result.states[1]).includes('Товары'));
  assert.ok(result.states.some(state => new URL(state.url).pathname === '/alternate'));
  const preview = PNG.sync.read(Buffer.from(result.states[1].preview, 'base64'));
  assert.ok(preview.height > 1500);
  assert.equal(preview.height, result.states[1].height);
  assert.ok(Object.values(result.states[1].assets).some(asset => asset.thumbnail));
  const nested = result.states.find(state => state.path.join('/') === 'Меню/Показать вкладку');
  assert.ok(nested);
  assert.ok(strings(nested).includes('Детали вкладки'));
  assert.ok(result.report.skippedControls >= 4);
  assert.ok(result.report.duplicateStates >= 1);
  assert.equal(result.report.aiUsed, true);
  assert.equal(result.report.aiFallback, true);
  assert.deepEqual(unexpected, []);
});
