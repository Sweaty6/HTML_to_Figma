import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { nodeId, parseFig } from 'openfig-core';
import { createNativeFig } from '../convert.mjs';

const redAsset = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQUDAAAACkAGE0Zn1yAAAAAElFTkSuQmCC';
const blueAsset = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNwCEgAAAHEAPExJbXoAAAAAElFTkSuQmCC';
const thumbnail = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const preview = await readFile(new URL('../demo/demo-preview.png', import.meta.url));
const screenshot = preview.toString('base64');
const digest = (base64) => createHash('sha1').update(Buffer.from(base64, 'base64')).digest('hex');

function capture(asset, attributes = {}) {
  return {
    title: 'Демо',
    width: 1440,
    height: 900,
    thumbnail,
    preview: screenshot,
    assets: { '1': { data: asset, thumbnail } },
    items: [
      { kind: 'group', id: 7, parent: 0, order: 1, name: 'Меню', x: 16, y: 20, w: 200, h: 90 },
      { kind: 'text', parent: 7, order: 2, text: 'Детали', x: 22, y: 25, w: 81, h: 16,
        color: 'rgba(36, 48, 64, 0.5)', fontFamily: 'Arial', weight: 700, fontStyle: 'italic' },
      { kind: 'image', assetId: '1', parent: 7, order: 3, x: 22, y: 48, w: 16, h: 16 },
    ],
    ...attributes,
  };
}

test('exports editable state frames and exact screenshot bytes in a native .fig archive', async () => {
  const result = await createNativeFig({
    states: [
      capture(redAsset),
      capture(blueAsset, { path: ['Тарифы', 'Подробнее'] }),
    ],
  });
  assert.equal(result.frames, 2);
  assert.equal(result.references, 2);
  assert.equal(result.images, 4);

  const doc = parseFig(result.bytes);
  assert.equal(doc.header.prelude, 'fig-kiwi');
  const page = doc.nodes.find(node => node.type === 'CANVAS' && !node.internalOnly);
  const children = (node) => doc.childrenMap.get(nodeId(node));
  const [first, firstReference, second, secondReference] = children(page);
  assert.ok(children(page).every(node => node.type === 'FRAME'));
  assert.match(second.name, /Тарифы → Подробнее/);
  assert.ok(firstReference.transform.m02 > first.transform.m02 + first.size.x);
  assert.ok(second.transform.m02 > firstReference.transform.m02 + firstReference.size.x);

  const [group] = children(first);
  assert.equal(group.name, 'Меню');
  assert.equal(group.resizeToFit, true);
  const [text, firstImage] = children(group);
  assert.equal(text.type, 'TEXT');
  assert.equal(text.textData.characters, 'Детали');
  assert.equal(text.fontName.postscript, 'Arial-BoldItalicMT');
  assert.equal(text.transform.m02, 6);
  assert.equal(text.transform.m12, 5);
  assert.equal(text.fillPaints[0].opacity, 0.5);
  assert.equal(text.fillPaints[0].color.a, 1);

  const [secondGroup] = children(second);
  const [, secondImage] = children(secondGroup);
  assert.equal(firstImage.fillPaints[0].image.name, digest(redAsset));
  assert.equal(secondImage.fillPaints[0].image.name, digest(blueAsset));
  for (const reference of [firstReference, secondReference]) {
    const [pngLayer] = children(reference);
    const fill = pngLayer.fillPaints[0];
    assert.deepEqual(reference.size, { x: 1440, y: 900 });
    assert.equal(fill.imageThumbnail.name, digest(thumbnail));
    assert.deepEqual(Buffer.from(doc.images.get(fill.image.name)), preview);
  }
});

test('preserves editable-only export for a single capture or an explicit opt out', async () => {
  const state = capture(redAsset, { preview: undefined });
  for (const result of [
    await createNativeFig(state),
    await createNativeFig({ states: [state] }, { includeReference: false }),
  ]) {
    assert.equal(result.frames, 1);
    assert.equal(result.references, 0);
    assert.equal(result.images, 2);
    assert.equal(parseFig(result.bytes).nodes.filter(n => n.type === 'TEXT').length, 1);
  }
});
