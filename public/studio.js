const $ = id => document.getElementById(id);
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const localInterface = loopback.has(location.hostname);
const defaultWorker = localInterface ? location.origin : 'http://127.0.0.1:4318';
const formats = ['fig', 'png', 'json'];
const stageLabels = {
  queued: 'Задача в очереди',
  loading: 'Chromium открывает страницу',
  exploring: 'Обходчик проверяет элементы интерфейса',
  capturing: 'Chromium сохраняет состояние',
  exporting: 'Собираем фреймы и записываем .fig',
  done: 'Собираем результаты захвата',
};
const limitLabels = {
  states: 'число состояний',
  actions: 'число действий',
  depth: 'глубина обхода',
  time: 'время обхода',
  controls: 'число элементов управления',
  frameDimensions: 'размер снимка',
  assets: 'число или размер изображений',
  nodes: 'число слоёв',
  outputBytes: 'размер результата',
};
const errorCounts = {
  attemptedActions: 'Действий проверено',
  skippedControls: 'Элементов пропущено',
  duplicateStates: 'Повторяющихся состояний',
  failedActions: 'Действий с ошибкой',
};

let source = 'url';
let currentJob = null;
let checkedWorker = null;
let busy = false;

$('worker').value = defaultWorker;
if (!localInterface) {
  $('connectionHint').textContent = 'Запустите Studio на своём компьютере и разрешите доступ к локальной сети, если браузер его запросит. Можно указать адрес своего HTTPS-сервера обработки.';
}

function setSource(value) {
  source = value;
  const usingUrl = value === 'url';
  $('urlbox').hidden = !usingUrl;
  $('htmlbox').hidden = usingUrl;
  $('url').disabled = !usingUrl;
  $('html').disabled = usingUrl;
  $('html').required = !usingUrl;
  $('tabUrl').setAttribute('aria-pressed', String(usingUrl));
  $('tabHtml').setAttribute('aria-pressed', String(!usingUrl));
}

function syncExploration() {
  const active = $('explore').checked;
  $('delay').disabled = !active;
  $('maxStates').disabled = !active;
  $('aiAssist').disabled = !active || !checkedWorker?.aiAvailable;
  if ($('aiAssist').disabled) $('aiAssist').checked = false;
}

function status(text, error = false) {
  if ($('status').textContent !== text) $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function workerStatus(state, message = '') {
  $('workerStatus').classList.toggle('ready', state === 'ready');
  $('workerStatus').classList.toggle('error', state === 'error');
  $('workerLabel').textContent = {
    idle: 'Подключить Chromium',
    checking: 'Проверка Chromium…',
    ready: 'Chromium подключён',
    error: 'Chromium недоступен',
  }[state];
  $('connectionStatus').textContent = message;
  $('connectionStatus').classList.toggle('error', state === 'error');
}

function workerConfig() {
  let address;
  try {
    address = new URL($('worker').value.trim());
  } catch {
    throw new Error('Укажите адрес сервера обработки, например http://127.0.0.1:4318.');
  }
  if (!['https:', 'http:'].includes(address.protocol) || (address.protocol === 'http:' && !loopback.has(address.hostname))) {
    throw new Error('Удалённому серверу обработки нужен адрес HTTPS.');
  }
  if (address.username || address.password || address.search || address.hash || address.pathname !== '/') {
    throw new Error('Введите адрес сервера без пути, учётных данных или параметров.');
  }
  return { origin: address.origin, token: $('token').value.trim() };
}

function request(worker, path, options = {}, timeout = 12_000) {
  const headers = new Headers(options.headers);
  if (worker.token) headers.set('Authorization', `Bearer ${worker.token}`);
  return fetch(worker.origin + path, {
    ...options,
    headers,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
  });
}

async function expectJson(response) {
  const json = response.headers.get('Content-Type')?.includes('application/json');
  const data = json ? await response.json() : {};
  if (!response.ok) throw new Error(data.error || `Сервер обработки ответил HTTP ${response.status}.`);
  if (!json) throw new Error('По этому адресу не отвечает сервер HTML → FIG Studio.');
  return data;
}

const sameWorker = (first, second) => first?.origin === second.origin && first?.token === second.token;

function changeWorker() {
  checkedWorker = null;
  $('aiSettings').hidden = true;
  syncExploration();
  workerStatus('idle');
}

async function checkWorker(config) {
  $('checkWorker').disabled = true;
  workerStatus('checking', 'Проверяем доступ к серверу обработки…');
  try {
    const result = await expectJson(await request(config, '/api/health', {}, 8000));
    if (result.status !== 'ok') throw new Error('Сервер обработки не готов.');
    if (sameWorker(config, workerConfig())) {
      checkedWorker = { ...config, aiAvailable: result.aiAvailable === true };
      $('aiSettings').hidden = !checkedWorker.aiAvailable;
      syncExploration();
      workerStatus('ready', 'Сервер готов к захвату.');
    }
  } catch (error) {
    let configUnchanged = false;
    try { configUnchanged = sameWorker(config, workerConfig()); } catch { /* Address was edited during the check. */ }
    const message = error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name)
      ? 'Не удалось связаться с Chromium. Проверьте адрес, запустите сервер обработки и разрешите доступ к локальной сети, если браузер запросил его.'
      : error.message;
    if (configUnchanged) {
      changeWorker();
      workerStatus('error', message);
    }
    throw new Error(message);
  } finally {
    $('checkWorker').disabled = false;
  }
}

function imagePath(id, format, index) {
  return `/api/download/${encodeURIComponent(id)}/${format}?state=${index}`;
}

function resetResult() {
  currentJob?.observer?.disconnect();
  for (const url of currentJob?.imageUrls?.values() ?? []) URL.revokeObjectURL(url);
  currentJob = null;
  $('image').removeAttribute('src');
  $('image').hidden = true;
  $('empty').hidden = false;
  $('emptyText').textContent = 'Здесь появится снимок браузера';
  $('resultBody').hidden = true;
  $('states').replaceChildren();
  $('report').replaceChildren();
  $('stateNumber').textContent = '';
  for (const format of formats) $(format).disabled = true;
}

function jobProgress(job) {
  const { stage, captures = 0, attemptedActions = 0 } = job.progress || {};
  const label = stageLabels[stage] || stageLabels[job.status] || 'Chromium обрабатывает страницу';
  const counts = captures || attemptedActions ? ` Снимков: ${captures}, действий: ${attemptedActions}.` : '';
  status(`${label}…${counts}`);
}

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForJob(worker, id) {
  const deadline = Date.now() + 8 * 60_000;
  let failures = 0;
  while (Date.now() < deadline) {
    await pause(failures ? 1500 : 750);
    let job;
    try {
      job = await expectJson(await request(worker, `/api/jobs/${encodeURIComponent(id)}`));
      failures = 0;
    } catch (error) {
      const transient = error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name);
      if (!transient || ++failures >= 3) throw error;
      continue;
    }
    if (job.status === 'done') return job.result;
    if (job.status === 'failed') throw new Error(job.error || 'Захват не удался.');
    jobProgress(job);
  }
  throw new Error('Сервер слишком долго обрабатывает эту задачу.');
}

function renderReport(report = {}) {
  const entries = [];
  for (const [key, label] of Object.entries(errorCounts)) {
    if (Number.isFinite(report[key])) entries.push(`${label}: ${report[key]}`);
  }
  if (Array.isArray(report.limitsReached) && report.limitsReached.length) {
    entries.push(`Достигнутые ограничения: ${report.limitsReached.map(key => limitLabels[key] || key).join(', ')}`);
  }
  if (report.aiUsed === true) entries.push('ИИ помог выбрать порядок действий.');
  if (report.aiUnavailable || report.aiFallback) entries.push('Обход продолжился по правилам интерфейса.');
  $('report').replaceChildren(...entries.map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  $('diagnostics').hidden = !entries.length;
}

function stateImage(job, index, format) {
  const key = `${format}:${index}`;
  if (!job.images.has(key)) {
    const load = request(job.worker, imagePath(job.id, format, index), {}, 20_000).then(async response => {
      if (!response.ok) throw new Error('Снимок недоступен.');
      const blob = await response.blob();
      if (currentJob !== job) throw new Error('Выбран другой результат.');
      const url = URL.createObjectURL(blob);
      job.imageUrls.set(key, url);
      return url;
    });
    job.images.set(key, load);
    load.catch(() => job.images.delete(key));
  }
  return job.images.get(key);
}

function selectState(job, index) {
  if (currentJob !== job) return;
  job.selected = index;
  const state = job.result.states[index];
  for (const button of $('states').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.index) === index));
  }
  const path = Array.isArray(state.path) && state.path.length ? state.path.join(' → ') : '';
  $('stateNumber').textContent = `${index + 1} / ${job.result.states.length}`;
  $('stateInfo').textContent = [
    path || state.action,
    state.url?.startsWith('http') ? state.url : '',
    state.width && state.height ? `${state.width} × ${state.height} px` : '',
  ].filter(Boolean).join(' · ');
  $('image').hidden = true;
  $('empty').hidden = false;
  $('emptyText').textContent = 'Загружаем снимок…';
  stateImage(job, index, 'png').catch(() => stateImage(job, index, 'thumbnail')).then(url => {
    if (currentJob !== job || job.selected !== index) return;
    $('image').src = url;
    $('image').alt = `Снимок состояния «${state.action || state.title || index + 1}»`;
    $('image').hidden = false;
    $('empty').hidden = true;
  }).catch(() => {
    if (currentJob === job && job.selected === index) $('emptyText').textContent = 'Предпросмотр недоступен. Попробуйте скачать PNG.';
  });
}

function renderResult(worker, id, result) {
  if (!Array.isArray(result?.states) || !result.states.length) throw new Error('Сервер не вернул захваченные состояния.');
  const job = { worker, id, result, selected: 0, images: new Map(), imageUrls: new Map() };
  currentJob = job;
  const loadListThumb = image => stateImage(job, Number(image.dataset.index), 'thumbnail').then(url => {
    image.src = url;
  }).catch(() => {});
  if ('IntersectionObserver' in window) {
    job.observer = new IntersectionObserver(entries => {
      for (const { isIntersecting, target } of entries) {
        if (!isIntersecting) continue;
        job.observer.unobserve(target);
        loadListThumb(target);
      }
    }, { root: $('states') });
  }
  result.states.forEach((state, index) => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    const image = document.createElement('img');
    const label = document.createElement('span');
    image.alt = '';
    image.dataset.index = index;
    label.textContent = [state.title, state.action].filter(Boolean).join(' · ') || `Состояние ${index + 1}`;
    button.type = 'button';
    button.dataset.index = index;
    button.title = label.textContent;
    button.append(image, label);
    button.addEventListener('click', () => selectState(job, index));
    row.append(button);
    $('states').append(row);
    if (job.observer) job.observer.observe(image);
    else loadListThumb(image);
  });
  $('statesCount').textContent = result.states.length;
  $('nodes').textContent = result.editable ?? '—';
  $('assets').textContent = result.images ?? '—';
  $('resultBody').hidden = false;
  $('fig').disabled = !result.figReady;
  $('png').disabled = false;
  $('json').disabled = false;
  selectState(job, 0);
  renderReport(result.report);
  if (result.figReady) {
    const limits = result.report?.limitsReached?.length ? ' Обход остановился на заданных ограничениях.' : '';
    status(`Файл .fig готов к скачиванию.${limits}`);
  } else {
    status(`Не удалось собрать .fig. ${result.figError || ''} Снимки и данные захвата доступны для скачивания.`, true);
  }
}

function setBusy(active) {
  busy = active;
  $('convert').disabled = active;
  $('preview').setAttribute('aria-busy', String(active));
  $('btnIcon').classList.toggle('spinner', active);
  $('btnIcon').classList.toggle('arrow', !active);
  $('btnText').textContent = active ? 'Выполняется захват…' : 'Собрать .fig';
}

function downloadName(job, format, index) {
  const title = String(job.result.title || 'site').normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 64);
  return `${title || 'site'}${format === 'png' ? `-state-${index + 1}` : ''}.${format}`;
}

async function download(format) {
  const job = currentJob;
  if (!job) return;
  const state = job.selected;
  $(format).disabled = true;
  try {
    const path = `/api/download/${encodeURIComponent(job.id)}/${format}${format === 'png' ? `?state=${state}` : ''}`;
    const response = await request(job.worker, path, {}, 90_000);
    if (!response.ok) await expectJson(response);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = downloadName(job, format, state);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (error) {
    if (job === currentJob) status(`Не удалось скачать файл. ${error.message}`, true);
  } finally {
    if (job === currentJob) $(format).disabled = false;
  }
}

$('tabUrl').addEventListener('click', () => setSource('url'));
$('tabHtml').addEventListener('click', () => setSource('html'));
$('explore').addEventListener('change', syncExploration);
$('worker').addEventListener('input', changeWorker);
$('token').addEventListener('input', changeWorker);
$('checkWorker').addEventListener('click', async () => {
  let config;
  try {
    config = workerConfig();
  } catch (error) {
    workerStatus('error', error.message);
    return;
  }
  try { await checkWorker(config); } catch { /* The check updates connection status. */ }
});
$('workerStatus').addEventListener('click', () => {
  $('settings').open = true;
  $('settings').scrollIntoView({ block: 'nearest' });
  $('checkWorker').focus({ preventScroll: true });
});
$('demo').addEventListener('click', async () => {
  $('demo').disabled = true;
  try {
    const response = await fetch('./example.html');
    if (!response.ok) throw new Error('Демо не удалось загрузить.');
    $('html').value = await response.text();
    setSource('html');
    $('explore').checked = true;
    syncExploration();
    status('Демо загружено. Нажмите «Собрать .fig», чтобы проверить обход.');
  } catch (error) {
    status(error.message, true);
  } finally {
    $('demo').disabled = false;
  }
});

$('source').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  let worker;
  try {
    worker = workerConfig();
    if (source === 'url' && !['http:', 'https:'].includes(new URL($('url').value.trim()).protocol)) {
      throw new Error('Укажите ссылку с http:// или https://.');
    }
    if (source === 'html' && !$('html').value.trim()) throw new Error('Вставьте HTML-код страницы.');
  } catch (error) {
    status(error.message, true);
    if (!worker) {
      $('settings').open = true;
      $('worker').focus();
    }
    return;
  }
  const explore = $('explore').checked;
  const input = {
    url: source === 'url' ? $('url').value.trim() : '',
    html: source === 'html' ? $('html').value : '',
    width: Number($('viewport').value),
    maxNodes: Number($('limit').value),
    maxStates: explore ? Number($('maxStates').value) : 1,
    animationDelayMs: explore ? Number($('delay').value) : 850,
    fullPage: true,
    explore,
    includeReference: $('reference').checked,
    aiAssist: explore && Boolean(checkedWorker?.aiAvailable && sameWorker(checkedWorker, worker) && $('aiAssist').checked),
  };

  resetResult();
  setBusy(true);
  status('Подключаемся к Chromium…');
  try {
    if (!sameWorker(checkedWorker, worker)) await checkWorker(worker);
    const job = await expectJson(await request(worker, '/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }));
    if (!job.id) throw new Error('Сервер не выдал номер задачи.');
    jobProgress(job);
    renderResult(worker, job.id, await waitForJob(worker, job.id));
  } catch (error) {
    status(error.message, true);
  } finally {
    setBusy(false);
  }
});

for (const format of formats) $(format).addEventListener('click', () => download(format));
if (localInterface) checkWorker({ origin: defaultWorker, token: '' }).catch(() => {});
