import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';

const defaultAnimationDelay = 550;
const pngBudget = 36_000_000;
const maxCandidates = 80;
const maxFramePixels = 12_000_000;
const embeddedProtocols = new Set(['data:', 'blob:', 'about:']);

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? Math.round(parsed) : fallback));
}

const inspectPage = ({ maxNodes, fullPage }) => {
  const skipped = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'TITLE', 'HEAD', 'TEMPLATE']);
  const semantic = new Set(['HEADER', 'NAV', 'MAIN', 'SECTION', 'ARTICLE', 'ASIDE', 'FOOTER', 'FORM', 'DIALOG']);
  const doc = document.documentElement;
  const documentWidth = Math.max(innerWidth, doc.scrollWidth, document.body.scrollWidth);
  const documentHeight = Math.max(innerHeight, doc.scrollHeight, document.body.scrollHeight);
  const width = fullPage ? Math.min(2640, documentWidth) : innerWidth;
  const height = fullPage ? Math.min(14000, Math.floor(12_000_000 / width), documentHeight) : innerHeight;
  const items = [];
  let nodesClipped = false;
  let sequence = 0;

  const finite = (value, fallback = 0) => Number.parseFloat(value) || fallback;
  const transparent = value => !value || value === 'transparent' || /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(value);
  const rounded = value => Math.round(value * 100) / 100;
  const box = rect => ({
    x: rounded(rect.left + (fullPage ? scrollX : 0)),
    y: rounded(rect.top + (fullPage ? scrollY : 0)),
    w: rounded(rect.width),
    h: rounded(rect.height),
  });
  const inFrame = ({ x, y, w, h }) =>
    w >= 0.8 && h >= 0.8 && x + w > 0 && y + h > 0 && x < width && y < height;
  const add = item => {
    if (items.length >= maxNodes) {
      nodesClipped = true;
      return;
    }
    items.push({ ...item, order: ++sequence });
  };
  const nameOf = element =>
    element.getAttribute('aria-label') || element.getAttribute('alt') || element.tagName.toLowerCase();

  function walk(element, parent, depth = 0) {
    if (items.length >= maxNodes || depth > 48) {
      nodesClipped = true;
      return;
    }
    if (skipped.has(element.tagName)) return;

    const style = getComputedStyle(element);
    if (style.display === 'none' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return;

    const rect = box(element.getBoundingClientRect());
    const tag = element.tagName.toLowerCase();
    const visible = style.visibility === 'visible' && inFrame(rect);
    const name = nameOf(element);
    if (visible && tag !== 'body') {
      const media = element.matches('img,svg,canvas,video,iframe,input,textarea,select');
      const pseudo = which => {
        const content = getComputedStyle(element, which).content;
        return content !== 'none' && content !== 'normal' && content !== '""';
      };
      const transformed = style.transform !== 'none' && !new DOMMatrixReadOnly(style.transform).isIdentity;
      const complex = style.backgroundImage !== 'none' || style.filter !== 'none' ||
        style.clipPath !== 'none' || style.maskImage !== 'none' || transformed ||
        style.backdropFilter !== 'none' || pseudo('::before') || pseudo('::after');
      if (media || complex) {
        add({ kind: 'image', parent, ...rect, name, assetId: String(sequence + 1) });
        return;
      }

      const isGroup = semantic.has(element.tagName) ||
        element.matches('button, a[href], [role="tab"], details, summary') ||
        (element.children.length >= 2 && ['flex', 'grid', 'inline-flex', 'inline-grid'].includes(style.display));
      if (isGroup) {
        const id = sequence + 1;
        add({ kind: 'group', id, parent, ...rect, name, opacity: Number(style.opacity) });
        parent = id;
      }
      const background = transparent(style.backgroundColor) ? null : style.backgroundColor;
      const border = finite(style.borderTopWidth) > 0 && !transparent(style.borderTopColor) &&
        style.borderTopStyle !== 'none' ? style.borderTopColor : null;
      if (background || border) {
        add({
          kind: 'shape', parent, ...rect, name, bg: background, border,
          borderWidth: finite(style.borderTopWidth),
          radius: finite(style.borderTopLeftRadius),
          radii: {
            topLeft: finite(style.borderTopLeftRadius),
            topRight: finite(style.borderTopRightRadius),
            bottomLeft: finite(style.borderBottomLeftRadius),
            bottomRight: finite(style.borderBottomRightRadius),
          },
          opacity: isGroup ? 1 : Number(style.opacity),
        });
      }
    }

    if (style.visibility === 'visible') {
      for (const child of element.childNodes) {
        if (child.nodeType !== Node.TEXT_NODE || !child.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(child);
        const bounds = box(range.getBoundingClientRect());
        if (!inFrame(bounds)) continue;
        let text = style.whiteSpace === 'normal' || style.whiteSpace === 'nowrap'
          ? child.textContent.replace(/\s+/g, ' ').trim()
          : child.textContent.trim();
        if (style.textTransform === 'uppercase') text = text.toLocaleUpperCase();
        if (style.textTransform === 'lowercase') text = text.toLocaleLowerCase();
        const fontSize = finite(style.fontSize, 16);
        add({
          kind: 'text', parent, ...bounds, text,
          color: style.color, fontFamily: style.fontFamily, fontSize, weight: finite(style.fontWeight, 400),
          fontStyle: style.fontStyle, letterSpacing: finite(style.letterSpacing),
          textDecoration: style.textDecorationLine, lineHeight: finite(style.lineHeight, fontSize * 1.25),
          align: style.textAlign,
        });
      }
    }
    for (const child of element.children) walk(child, parent, depth + 1);
  }

  walk(document.body, 0);
  return {
    width, height, truncated: fullPage && (width < documentWidth || height < documentHeight),
    nodesClipped, items,
    pageBg: getComputedStyle(doc).backgroundColor,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    title: document.title || location.hostname || 'HTML document',
    url: location.href,
  };
};

const discoverControls = ({ origin, inputHTML, maxCandidates }) => {
  const selector = 'a[href], area[href], button, summary, input[type="button"], [role="button"], [role="tab"], [role="menuitem"], [role="switch"]';
  const safeControls = [];
  let skipped = 0;
  let excess = false;
  const unsafe = /(^|[^\p{L}\p{N}])(?:delete|remove|save|submit|send|purchase|buy|checkout|pay|subscribe|unsubscribe|logout|log[ -]?out|sign[ -]?(?:out|up|in)|register|upload|download|reset|confirm|accept[ -]?(?:all|payment)|cancel[ -]?(?:order|subscription|payment)|удал\p{L}*|сохран\p{L}*|отправ\p{L}*|купить|покуп\p{L}*|оплат\p{L}*|подписаться|отписаться|войти|выход|выйти|зарегистр\p{L}*|скач\p{L}*|загруз\p{L}*|сброс\p{L}*|подтверд\p{L}*|оформить)(?=$|[^\p{L}\p{N}])/iu;
  const keyFor = element => {
    const parts = [];
    for (let cursor = element; cursor; cursor = cursor.parentElement) {
      if (cursor.id) {
        const id = '#' + CSS.escape(cursor.id);
        if (document.querySelectorAll(id).length === 1) {
          parts.unshift(id);
          break;
        }
      }
      const tag = CSS.escape(cursor.localName);
      let occurrence = 1;
      for (let sibling = cursor.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === cursor.localName) occurrence++;
      }
      parts.unshift(tag + ':nth-of-type(' + occurrence + ')');
    }
    return parts.join(' > ');
  };

  const topDialog = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')]
    .findLast(el => el.getBoundingClientRect().width && getComputedStyle(el).visibility === 'visible');
  const baseTarget = document.querySelector('base[target]')?.getAttribute('target');

  for (const element of document.querySelectorAll(selector)) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!rect.width || !rect.height || style.visibility !== 'visible' || style.pointerEvents === 'none' ||
        element.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]') ||
        element.matches(':disabled') || (topDialog && !topDialog.contains(element))) continue;

    const link = element.matches('a[href], area[href]');
    const label = [
      element.getAttribute('aria-label'),
      element.innerText,
      element.value,
      element.getAttribute('title'),
      element.querySelector('img[alt]')?.getAttribute('alt'),
    ].find(value => value?.trim())?.replace(/\s+/g, ' ').trim() || '';
    const href = link ? element.getAttribute('href').trim() : '';
    const traits = [label, element.id, element.getAttribute('name'), href].join(' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2');
    const formAction = element.matches('input, button') && element.form &&
      !['button'].includes(element.type);
    if (formAction || element.hasAttribute('formaction') || unsafe.test(traits)) {
      skipped++;
      continue;
    }
    if (element.tagName === 'SUMMARY' && element.parentElement?.querySelector(':scope > summary') !== element) continue;
    if (link) {
      const target = element.getAttribute('target') || baseTarget;
      if (element.hasAttribute('download') || (target && target !== '_self') ||
          !href || (inputHTML && !href.startsWith('#'))) {
        skipped++;
        continue;
      }
      let parsed;
      try {
        parsed = new URL(href, document.baseURI);
      } catch {
        if (inputHTML && href.startsWith('#')) parsed = null;
        else {
          skipped++;
          continue;
        }
      }
      const outside = parsed && (inputHTML ? parsed.protocol !== 'about:' : parsed.origin !== origin);
      if (parsed && (outside || parsed.username || parsed.password)) {
        skipped++;
        continue;
      }
    }
    if (safeControls.length >= maxCandidates) {
      excess = true;
      continue;
    }
    const role = element.getAttribute('role');
    if (role === 'tab' && element.getAttribute('aria-selected') === 'true') continue;
    const kind = element.tagName === 'SUMMARY' ? 'summary'
      : ['tab', 'menuitem', 'switch'].includes(role) ? role
      : link ? 'link' : 'button';
    const readBoolean = attribute => element.hasAttribute(attribute) ? element.getAttribute(attribute) === 'true' : null;
    safeControls.push({
      selector: keyFor(element), label: (label || element.id || kind).slice(0, 100), kind, href,
      expanded: readBoolean('aria-expanded'), selected: readBoolean('aria-selected'),
    });
  }

  const route = new URL(location.href);
  if (route.hash) {
    let fragment = route.hash.slice(1);
    try { fragment = decodeURIComponent(fragment); } catch { /* Invalid escapes can be part of a client-side route. */ }
    const anchor = document.getElementById(fragment) || document.getElementsByName(fragment)[0];
    if (anchor) route.hash = '';
  }
  return { controls: safeControls, skipped, excess, route: route.href };
};

function resizePNG(png, limit) {
  const scale = Math.min(1, limit / Math.max(png.width, png.height));
  const width = Math.max(1, Math.round(png.width * scale));
  const height = Math.max(1, Math.round(png.height * scale));
  const reduced = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(png.height - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(png.width - 1, Math.floor((x + 0.5) / scale));
      const source = (sourceY * png.width + sourceX) * 4;
      png.data.copy(reduced.data, (y * width + x) * 4, source, source + 4);
    }
  }
  return reduced;
}

function cropAssets(items, pixels, addLimit, budget) {
  const assets = {};
  let total = 0;
  for (const item of items) {
    if (item.kind !== 'image') continue;
    const x = Math.max(0, Math.floor(item.x));
    const y = Math.max(0, Math.floor(item.y));
    const width = Math.min(pixels.width, Math.ceil(item.x + item.w)) - x;
    const height = Math.min(pixels.height, Math.ceil(item.y + item.h)) - y;
    if (width < 1 || height < 1 || Object.keys(assets).length >= 60 || width * height > maxFramePixels) {
      addLimit('assets');
      continue;
    }
    const crop = new PNG({ width, height });
    PNG.bitblt(pixels, crop, x, y, width, height, 0, 0);
    const data = PNG.sync.write(crop);
    const thumbnail = PNG.sync.write(resizePNG(crop, 320));
    if (total + data.length + thumbnail.length > budget) {
      addLimit('assets');
      continue;
    }
    Object.assign(item, { x, y, w: width, h: height });
    assets[item.assetId] = { data: data.toString('base64'), thumbnail: thumbnail.toString('base64'), width, height };
    total += data.length + thumbnail.length;
  }
  return { assets, total };
}

async function settle(page, delayMs) {
  if (delayMs) await page.waitForTimeout(delayMs);
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter(animation =>
      animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.race([
      Promise.allSettled([document.fonts.ready, ...finite.map(animation => animation.finished)]),
      new Promise(resolve => setTimeout(resolve, 750)),
    ]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function primeLazyImages(page) {
  await page.evaluate(async maximumPixels => {
    for (const image of document.querySelectorAll('img[loading="lazy"]')) {
      if (image.getBoundingClientRect().top < maximumPixels) image.loading = 'eager';
    }
    const height = Math.min(document.documentElement.scrollHeight, 8_000);
    const step = Math.max(500, Math.round(innerHeight * 0.9));
    for (let offset = step; offset < height; offset += step) {
      window.scrollTo({ top: offset, left: 0, behavior: 'instant' });
      await new Promise(resolve => setTimeout(resolve, 55));
    }
    if (scrollX === 0 && scrollY === 0 && height <= step) return;
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    await new Promise(resolve => setTimeout(resolve, 100));
  }, maxFramePixels / page.viewportSize().width);
}

async function describeState(page, options) {
  if (options.fullPage) await primeLazyImages(page);
  const data = await page.evaluate(inspectPage, options);
  const preview = await page.screenshot({
    type: 'png', fullPage: options.fullPage, animations: 'disabled', timeout: 10_000,
    ...(options.fullPage && { clip: { x: 0, y: 0, width: data.width, height: data.height } }),
  });
  const pixels = PNG.sync.read(preview);
  const thumbnail = resizePNG(pixels, 320);
  return { data, preview, pixels, thumbnail };
}

async function prioritize(controls, rankControls, ms) {
  if (!rankControls || controls.length < 2 || ms <= 0) return { controls };
  const abort = new AbortController();
  let timer;
  try {
    const ranked = await Promise.race([
      Promise.resolve().then(() => rankControls({
        controls: controls.map(({ label, kind, expanded, selected }) => ({ label, kind, expanded, selected })),
        signal: abort.signal,
      })),
      new Promise(resolve => {
        timer = setTimeout(() => {
          abort.abort();
          resolve(null);
        }, ms);
      }),
    ]);
    if (!Array.isArray(ranked)) return { controls, aiFallback: true };
    const indices = new Set(ranked.filter(index => Number.isInteger(index) && index >= 0 && index < controls.length));
    if (!indices.size) return { controls, aiFallback: true };
    for (let i = 0; i < controls.length; i++) indices.add(i);
    return { controls: [...indices].map(index => controls[index]), aiUsed: true };
  } catch {
    return { controls, aiFallback: true };
  } finally {
    clearTimeout(timer);
  }
}

function validURL(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Укажите полный адрес с http:// или https://.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Укажите адрес http:// или https:// без логина и пароля.');
  }
  return parsed.href;
}

export async function captureSite({
  url = '', html = '', width = 1440, maxNodes = 750, fullPage = true, maxStates = 12,
  animationDelayMs = defaultAnimationDelay, maxActions = 42, maxDepth = 4, timeoutMs = 120_000,
  authorizeRequest, browserProxy, rankControls, onProgress, executablePath,
} = {}) {
  width = boundedInt(width, 1440, 320, 1920);
  maxNodes = boundedInt(maxNodes, 750, 100, 1500);
  animationDelayMs = boundedInt(animationDelayMs, defaultAnimationDelay, 0, 5_000);
  maxStates = boundedInt(maxStates, 12, 1, 30);
  maxActions = boundedInt(maxActions, 42, 0, 90);
  maxDepth = boundedInt(maxDepth, 4, 0, 8);
  timeoutMs = boundedInt(timeoutMs, 120_000, 5_000, 180_000);
  const inputHTML = typeof html === 'string' && !!html.trim();
  const entryURL = inputHTML ? '' : validURL(url);
  const report = {
    stage: 'loading', captures: 0, attemptedActions: 0, skippedControls: 0,
    duplicateStates: 0, failedActions: 0, replayClicks: 0, limitsReached: [],
    aiUsed: false, aiFallback: false,
  };
  const progress = stage => {
    report.stage = stage;
    onProgress?.({ ...report, limitsReached: [...report.limitsReached] });
  };
  const addLimit = name => {
    if (!report.limitsReached.includes(name)) report.limitsReached.push(name);
  };

  progress('loading');
  const browser = await chromium.launch({
    headless: true,
    executablePath: executablePath || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    timeout: 20_000,
    proxy: browserProxy,
    args: [
      '--disable-dev-shm-usage',
      ...(browserProxy ? ['--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : []),
    ],
  });
  const endTime = Date.now() + timeoutMs;
  const timer = setTimeout(() => {
    addLimit('time');
    void browser.close().catch(() => {});
  }, timeoutMs);
  const states = [];
  const seen = new Set();
  const queue = [];
  let capturedBytes = 0;
  let entryOrigin;
  let canonicalEntry = entryURL;

  async function openPage() {
    const context = await browser.newContext({
      viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light',
      ignoreHTTPSErrors: false, serviceWorkers: 'block', acceptDownloads: false,
    });
    let page;
    let loading = true;
    try {
      await context.routeWebSocket('**/*', socket => socket.close());
      await context.route('**/*', async route => {
        const request = route.request();
        try {
          const parsed = new URL(request.url());
          if (embeddedProtocols.has(parsed.protocol)) return route.continue();
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
              !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.abort();
          if (request.isNavigationRequest() && page) {
            const frame = request.frame();
            if (frame.page() !== page) return route.abort();
            if (frame === page.mainFrame() && (inputHTML || (!loading && parsed.origin !== entryOrigin))) {
              return route.abort();
            }
          }
          if (authorizeRequest && await authorizeRequest(parsed.href) === false) return route.abort();
          if (authorizeRequest && !browserProxy) {
            // route() does not intercept a redirected URL. Never let Chromium follow
            // a Location header unless the configured outbound proxy validates each connection.
            const response = await route.fetch({ maxRedirects: 0, timeout: 10_000 });
            if (response.status() >= 300 && response.status() < 400) return route.abort();
            return route.fulfill({ response });
          }
          return route.continue();
        } catch {
          return route.abort().catch(() => {});
        }
      });
      page = await context.newPage();
      context.on('page', candidate => {
        if (candidate !== page) void candidate.close().catch(() => {});
      });
      page.setDefaultTimeout(2_000);
      if (inputHTML) {
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      } else {
        const response = await page.goto(canonicalEntry, { waitUntil: 'domcontentloaded', timeout: 18_000 });
        if (response?.status() >= 400) throw new Error(`Сайт вернул HTTP ${response.status()}.`);
        const landed = new URL(validURL(page.url()));
        if (entryOrigin && landed.origin !== entryOrigin) throw new Error('Начальная страница сменила источник.');
        entryOrigin = landed.origin;
        canonicalEntry = landed.href;
      }
      loading = false;
      await settle(page, animationDelayMs);
      return { page, context };
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }

  async function availableControls(page) {
    return page.evaluate(discoverControls, { origin: entryOrigin, inputHTML, maxCandidates });
  }

  async function explore(path) {
    const { page, context } = await openPage();
    try {
      for (const [index, step] of path.entries()) {
        if (fullPage) await primeLazyImages(page);
        const { controls } = await availableControls(page);
        const current = controls.find(control =>
          step.selector === control.selector && step.kind === control.kind && step.label === control.label && step.href === control.href);
        if (!current) throw new Error('Кнопка изменилась при повторном прохождении действий.');
        // Avoid bypassing overlays and other normal user-facing hit testing.
        await page.locator(current.selector).click({ timeout: 3_000 });
        await page.mouse.move(-100, -100);
        if (index + 1 < path.length) report.replayClicks++;
        await settle(page, animationDelayMs);
        if (!inputHTML && new URL(page.url()).origin !== entryOrigin) {
          throw new Error('Действие выводит за пределы исходного сайта.');
        }
      }

      if (!inputHTML && new URL(page.url()).origin !== entryOrigin) {
        throw new Error('Страница вышла за пределы исходного сайта.');
      }
      progress('capturing');
      const snapshot = await describeState(page, { maxNodes, fullPage });
      const { data, preview, pixels, thumbnail } = snapshot;
      const found = await availableControls(page);
      const signature = createHash('sha256')
        .update(JSON.stringify([found.route, data.width, data.height, data.items, found.controls]))
        .update(thumbnail.data).digest('hex');
      if (seen.has(signature)) {
        report.duplicateStates++;
        return;
      }
      if (data.truncated) addLimit('frameDimensions');
      if (data.nodesClipped) addLimit('nodes');
      const thumbnailBytes = PNG.sync.write(thumbnail);
      const remaining = pngBudget - capturedBytes - preview.length - thumbnailBytes.length;
      if (remaining < 0) {
        addLimit('outputBytes');
        return;
      }
      seen.add(signature);
      const { assets, total } = cropAssets(data.items, pixels, addLimit, Math.min(remaining, 6_000_000));
      capturedBytes += preview.length + thumbnailBytes.length + total;
      const labels = path.map(step => step.label);
      states.push({
        ...data, width: pixels.width, height: pixels.height,
        id: `state-${states.length + 1}`, action: labels.at(-1) || 'Входная страница', path: labels,
        thumbnail: thumbnailBytes.toString('base64'), preview: preview.toString('base64'), assets,
      });
      report.captures = states.length;

      report.skippedControls += found.skipped;
      if (found.excess) addLimit('controls');
      if (!found.controls.length) return;
      if (states.length >= maxStates || path.length >= maxDepth) {
        if (states.length >= maxStates) addLimit('states');
        if (path.length >= maxDepth) addLimit('depth');
        return;
      }
      const ranked = await prioritize(found.controls, rankControls, Math.min(4_000, endTime - Date.now()));
      report.aiUsed ||= Boolean(ranked.aiUsed);
      report.aiFallback ||= Boolean(ranked.aiFallback);
      for (const candidate of ranked.controls) queue.push([...path, candidate]);
    } finally {
      await context.close().catch(() => {});
    }
  }

  try {
    await explore([]);
    while (queue.length && states.length < maxStates && report.attemptedActions < maxActions && Date.now() < endTime &&
           !report.limitsReached.includes('outputBytes')) {
      const path = queue.shift();
      report.attemptedActions++;
      progress('exploring');
      try {
        await explore(path);
      } catch {
        if (!report.limitsReached.includes('time')) report.failedActions++;
      }
    }
    if (queue.length && states.length >= maxStates) addLimit('states');
    if (queue.length && report.attemptedActions >= maxActions) addLimit('actions');
    if (Date.now() >= endTime) addLimit('time');
    if (!states.length) throw new Error('Не удалось получить первый снимок страницы.');
    progress('done');
    return { states, report };
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => {});
  }
}

export async function capturePage(options) {
  const { states } = await captureSite({ ...options, maxStates: 1 });
  return states[0];
}
