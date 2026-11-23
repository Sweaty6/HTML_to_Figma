import { createHash } from 'node:crypto';
import {
  assembleCanvasFig, createEmptyFigDoc, createFigZip, cssColorToFigColor,
  encodeFigParts, nodeId, parseFig,
} from 'openfig-core';
import zstdModule from 'zstd-codec';

const zstdReady = new Promise((resolve) => {
  zstdModule.ZstdCodec.run(zstd => resolve(new zstd.Simple()));
});

const FRAME_GAP = 120;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const DETACHED_STYLE = { guid: { sessionID: 0xffffffff, localID: 0xffffffff } };

const clamp = (value, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, Number(value) || 0));
const size = (x, y) => ({ x: clamp(x, 1, 16000), y: clamp(y, 1, 16000) });
const matrix = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const clean = (value, limit = 75) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
const position = (i) => '!' + String(i).padStart(6, '0');

function color(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object' && Number.isFinite(value.r)) {
    return { r: clamp(value.r / 255), g: clamp(value.g / 255), b: clamp(value.b / 255), a: clamp(value.a ?? 1) };
  }
  try {
    return cssColorToFigColor(value);
  } catch {
    return fallback;
  }
}

function composite(overlay, base) {
  if (!overlay) return base;
  const { r, g, b, a } = overlay;
  return {
    r: a * r + (1 - a) * base.r,
    g: a * g + (1 - a) * base.g,
    b: a * b + (1 - a) * base.b,
    a: 1,
  };
}

const solidPaint = (color) => ({
  type: 'SOLID', color: { ...color, a: 1 }, opacity: color.a,
  visible: true, blendMode: 'NORMAL',
});

function rectangleCorners(item) {
  const radius = Math.max(0, Number(item.radius) || 0);
  return {
    cornerRadius: radius,
    rectangleTopLeftCornerRadius: item.radii?.topLeft ?? radius,
    rectangleTopRightCornerRadius: item.radii?.topRight ?? radius,
    rectangleBottomLeftCornerRadius: item.radii?.bottomLeft ?? radius,
    rectangleBottomRightCornerRadius: item.radii?.bottomRight ?? radius,
  };
}

function readPng(data) {
  const bytes = Buffer.from(String(data || '').replace(/^data:image\/png;base64,/, ''), 'base64');
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width && height ? { bytes, width, height } : null;
}

function imagePaint(png, thumbnail, images) {
  const attachImage = ({ bytes }) => {
    const hash = createHash('sha1').update(bytes).digest();
    const name = hash.toString('hex');
    if (!images.has(name)) images.set(name, bytes);
    return { hash, name };
  };

  return {
    type: 'IMAGE', opacity: 1, visible: true, blendMode: 'NORMAL',
    transform: matrix(0, 0),
    image: attachImage(png),
    imageThumbnail: attachImage(thumbnail || png),
    imageScaleMode: 'FILL', scale: 1,
    originalImageWidth: png.width, originalImageHeight: png.height,
    thumbHash: new Uint8Array(0), altText: '',
  };
}

function imageLayer(png, thumbnail, geometry, images) {
  return {
    type: 'ROUNDED_RECTANGLE', strokeWeight: 0, proportionsConstrained: true,
    ...geometry, fillPaints: [imagePaint(png, thumbnail, images)],
  };
}

const GENERIC_FONTS = new Map([
  ['sans-serif', 'Arial'], ['system-ui', 'Arial'], ['-apple-system', 'Arial'],
  ['serif', 'Times New Roman'], ['monospace', 'Courier New'],
]);

const KNOWN_POSTSCRIPT = {
  Arial: ['ArialMT', 'Arial-BoldMT', 'Arial-ItalicMT', 'Arial-BoldItalicMT'],
  'Times New Roman': ['TimesNewRomanPSMT', 'TimesNewRomanPS-BoldMT', 'TimesNewRomanPS-ItalicMT', 'TimesNewRomanPS-BoldItalicMT'],
  'Courier New': ['CourierNewPSMT', 'CourierNewPS-BoldMT', 'CourierNewPS-ItalicMT', 'CourierNewPS-BoldItalicMT'],
};

function fontName(item) {
  let family = clean(item.fontFamily, 80).split(',')[0].replace(/['"]/g, '').trim() || 'Arial';
  family = GENERIC_FONTS.get(family.toLowerCase()) || family;
  const bold = (Number(item.weight) || 400) >= 600;
  const italic = /^(italic|oblique)/.test(item.fontStyle || '');
  const variant = Number(bold) + 2 * Number(italic);
  const style = ['Regular', 'Bold', 'Italic', 'Bold Italic'][variant];
  const postscript = Object.hasOwn(KNOWN_POSTSCRIPT, family)
    ? KNOWN_POSTSCRIPT[family][variant]
    : `${family.replace(/\s+/g, '')}-${style.replace(' ', '')}`;
  return { family, style, postscript };
}

function textLayer(item, geometry) {
  const characters = String(item.text || '').slice(0, 5000);
  if (!characters.trim()) return null;

  const fontSize = clamp(Number(item.fontSize) || 16, 1, 512);
  const align = item.align === 'center' ? 'CENTER' : item.align === 'right' || item.align === 'end' ? 'RIGHT' : 'LEFT';
  const decoration = (item.textDecoration || '').split(' ');
  const layer = {
    ...geometry, type: 'TEXT', name: clean(characters), size: size(item.w + 2, item.h + 2),
    textData: { characters }, fontName: fontName(item), fontSize,
    lineHeight: { value: clamp((Number(item.lineHeight) || fontSize * 1.25) / fontSize, 0.2, 8), units: 'RAW' },
    styleIdForText: DETACHED_STYLE,
    textAutoResize: 'HEIGHT', textAlignHorizontal: align, textAlignVertical: 'TOP',
    fillPaints: [solidPaint(color(item.color, BLACK))], strokeWeight: 0,
  };
  if (Number.isFinite(item.letterSpacing)) {
    layer.letterSpacing = { value: item.letterSpacing, units: 'PIXELS' };
  }
  if (decoration.includes('underline')) layer.textDecoration = 'UNDERLINE';
  else if (decoration.includes('line-through')) layer.textDecoration = 'STRIKETHROUGH';
  return layer;
}

function shapeLayer(item, geometry) {
  const fill = color(item.bg);
  const stroke = color(item.border);
  if (!fill && !stroke) return null;
  return {
    ...geometry, ...rectangleCorners(item),
    type: 'ROUNDED_RECTANGLE', name: clean(item.name || 'Блок'),
    fillPaints: fill ? [solidPaint(fill)] : [],
    strokePaints: stroke ? [solidPaint(stroke)] : [],
    strokeWeight: stroke ? clamp(item.borderWidth, 0, 20) : 0,
    strokeAlign: 'INSIDE', strokeJoin: 'MITER',
  };
}

function stateName(state, index, multiple) {
  const title = clean(state.title || state.url || 'Импорт HTML');
  if (!multiple) return title;
  const action = clean(state.path?.join(' → ') || state.action || 'Входная страница', 110);
  return `${String(index + 1).padStart(2, '0')} · ${title} · ${action}`;
}

function appendEditableLayers(state, frame, append, images) {
  const parents = new Map([[0, { guid: frame.guid, x: 0, y: 0 }]]);
  const items = [...(state.items || [])].sort((a, b) => a.order - b.order);
  const readAssets = new Map();
  for (const item of items) {
    const parent = parents.get(item.parent) || parents.get(0);
    const geometry = {
      size: size(item.w, item.h),
      transform: matrix(item.x - parent.x, item.y - parent.y),
      opacity: clamp(item.opacity ?? 1),
    };

    let layer;
    switch (item.kind) {
      case 'group': {
        const group = append({
          ...geometry, type: 'FRAME', name: clean(item.name || 'Группа'),
          fillPaints: [], frameMaskDisabled: false, resizeToFit: true, strokeWeight: 0,
        }, parent.guid);
        parents.set(item.id, { guid: group.guid, x: item.x, y: item.y });
        break;
      }
      case 'text':
        layer = textLayer(item, geometry);
        break;
      case 'shape':
        layer = shapeLayer(item, geometry);
        break;
      case 'image': {
        if (!readAssets.has(item.assetId)) {
          const asset = state.assets?.[item.assetId];
          readAssets.set(item.assetId, {
            png: readPng(asset?.data), thumbnail: readPng(asset?.thumbnail),
          });
        }
        const { png, thumbnail } = readAssets.get(item.assetId);
        if (png) {
          layer = imageLayer(png, thumbnail, {
            ...geometry, ...rectangleCorners(item), name: clean(item.name || 'Изображение'),
          }, images);
        }
        break;
      }
    }
    if (layer) append(layer, parent.guid);
  }
}

export async function createNativeFig(capture, { includeReference = Array.isArray(capture.states) } = {}) {
  const multiple = Array.isArray(capture.states);
  const states = multiple ? capture.states : [capture];
  if (!states.length) throw new Error('Нет состояний для экспорта в .fig');

  const doc = createEmptyFigDoc();
  const changes = doc.message.nodeChanges;
  const page = changes.find(n => n.type === 'CANVAS' && !n.internalOnly && n.phase !== 'REMOVED');
  if (!page) throw new Error('В шаблоне отсутствует страница CANVAS');
  page.name = 'Импорт сайта';

  let nextId = Math.max(...changes.map(n => n.guid.localID)) + 1;
  const siblings = new Map();
  const append = (data, parentGuid) => {
    const key = `${parentGuid.sessionID}:${parentGuid.localID}`;
    const index = siblings.get(key) || 0;
    siblings.set(key, index + 1);
    const node = {
      guid: { sessionID: 1, localID: nextId++ }, phase: 'CREATED', visible: true, opacity: 1,
      parentIndex: { guid: parentGuid, position: position(index) }, ...data,
    };
    changes.push(node);
    return node;
  };

  const images = new Map();
  const roots = [];
  const references = [];
  const columns = Math.ceil(Math.sqrt(states.length));
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const [index, state] of states.entries()) {
    const name = stateName(state, index, multiple);
    const dimensions = size(state.width, state.height);
    const background = composite(color(state.bodyBg), composite(color(state.pageBg), WHITE));
    const root = append({
      type: 'FRAME', name, size: dimensions, transform: matrix(x, y),
      frameMaskDisabled: false, fillPaints: [solidPaint(background)], strokeWeight: 0,
    }, page.guid);
    roots.push(root);
    appendEditableLayers(state, root, append, images);

    let pairWidth = dimensions.x;
    let pairHeight = dimensions.y;
    if (includeReference) {
      const png = readPng(state.preview);
      if (!png) throw new Error(`Нет снимка PNG для состояния «${name}»`);
      const thumbnail = readPng(state.previewThumbnail || state.thumbnail);
      const referenceSize = { x: png.width, y: png.height };
      const reference = append({
        type: 'FRAME', name: `${name} · Снимок браузера`, size: referenceSize,
        transform: matrix(x + dimensions.x + FRAME_GAP, y),
        frameMaskDisabled: false, fillPaints: [], strokeWeight: 0,
      }, page.guid);
      references.push(reference);
      append(imageLayer(png, thumbnail, {
        name: 'Снимок PNG', size: referenceSize, transform: matrix(0, 0), locked: true,
      }, images), reference.guid);
      pairWidth += FRAME_GAP + png.width;
      pairHeight = Math.max(pairHeight, png.height);
    }

    rowHeight = Math.max(rowHeight, pairHeight);
    x += pairWidth + FRAME_GAP;
    if ((index + 1) % columns === 0) {
      x = 0;
      y += rowHeight + FRAME_GAP;
      rowHeight = 0;
    }
  }

  const parts = encodeFigParts(doc);
  const zstd = await zstdReady;
  const canvasFig = assembleCanvasFig({
    ...parts, messageCompressed: zstd.compress(parts.messageRaw, 3),
  });
  const first = states[0];
  const thumbnail = readPng(first.thumbnail || first.preview);
  const result = createFigZip({
    canvasFig, meta: { ...doc.meta, file_name: clean(first.title || 'Импорт HTML', 120) },
    thumbnail: thumbnail?.bytes, images,
  });

  // Check archive integrity and the written node hierarchy before handing it to Figma.
  const verified = parseFig(result);
  const exportedFrames = verified.childrenMap.get(nodeId(page)) || [];
  const expectedFrames = new Set([...roots, ...references].map(nodeId));
  if (exportedFrames.length !== expectedFrames.size
    || exportedFrames.some(frame => frame.type !== 'FRAME' || !expectedFrames.has(nodeId(frame)))
    || verified.images.size !== images.size) {
    throw new Error('Структурная проверка .fig не пройдена');
  }

  return {
    bytes: Buffer.from(result.buffer, result.byteOffset, result.byteLength),
    nodes: changes.length, images: images.size, frames: roots.length, references: references.length,
  };
}
