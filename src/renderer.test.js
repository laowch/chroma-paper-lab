import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceTransform, hexToRgb, SHAPES } from './renderer.js';
import { initialState, makePigments, PRESETS, INKS } from './presets.js';

test('distance transform measures axial and diagonal capillary distances', () => {
  const field = new Float32Array(25).fill(100);
  field[12] = 0;
  distanceTransform(field, 5);
  assert.equal(field[12], 0);
  assert.equal(field[7], 1);
  assert.equal(field[2], 2);
  assert.ok(Math.abs(field[6] - Math.SQRT2) < .00001);
  assert.ok(Math.abs(field[0] - Math.SQRT2 * 2) < .00001);
  assert.equal(field[0], field[24]);
});

test('distance transform preserves empty and fully covered masks', () => {
  const empty = new Float32Array(16).fill(4);
  const covered = new Float32Array(16);
  assert.deepEqual(distanceTransform(empty, 4), new Float32Array(16).fill(4));
  assert.deepEqual(distanceTransform(covered, 4), new Float32Array(16));
});

test('pigments have independent component-specific mobilities', () => {
  const pigments = makePigments(INKS[0].pigments);
  assert.equal(new Set(pigments.map(p => p.mobility)).size, 3);
  assert.ok(pigments[0].mobility > pigments[1].mobility);
  assert.ok(pigments[1].mobility > pigments[2].mobility);
  pigments[0].opacity = 0;
  assert.notEqual(pigments[1].opacity, 0);
});

test('initial states are isolated and every preset has a supported shape and ink', () => {
  const a = initialState(), b = initialState();
  a.pigments[0].color = '#ffffff';
  a.layers[0] = false;
  a.drops.push({ x: .5, y: .5, age: 0 });
  assert.notEqual(a.pigments[0].color, b.pigments[0].color);
  assert.equal(b.layers[0], true);
  assert.equal(b.drops.length, 0);
  for (const preset of PRESETS) {
    assert.ok(SHAPES.includes(preset.shape));
    assert.ok(INKS[preset.inkIndex]);
  }
});

test('default pigments pair a narrow outer front with broader inner bands', () => {
  const [outer, middle, inner] = initialState().pigments;
  assert.ok(outer.mobility > middle.mobility && middle.mobility > inner.mobility);
  assert.ok(outer.spread < middle.spread && outer.spread < inner.spread);
  assert.ok(outer.opacity > middle.opacity);
  for (const ink of INKS) {
    for (const component of makePigments(ink.pigments)) {
      assert.match(component.color, /^#[0-9a-f]{6}$/i);
      assert.ok(component.opacity > 0 && component.opacity <= 1);
      assert.ok(component.mobility > 0 && component.mobility <= 1.5);
    }
  }
});

test('the initial ring and Quiet bloom use the same calibrated geometry', () => {
  const state = initialState();
  for (const key of ['shape', 'seed', 'mode', 'size', 'stroke', 'amount', 'inkIndex']) {
    assert.equal(state[key], PRESETS[0][key], key);
  }
});

test('hex colors are mapped to normalized input channels', () => {
  assert.deepEqual(hexToRgb('#ff8000'), [1, 128 / 255, 0]);
  assert.deepEqual(hexToRgb('#000000'), [0, 0, 0]);
});
