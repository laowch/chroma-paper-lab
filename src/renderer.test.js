import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromatographyRenderer, distanceTransform, hexToRgb, SHAPES } from './renderer.js';
import {
  initialState, makePigments, PRESETS, INKS, MAX_PIGMENTS,
  hexToHsl, hslToHex, mixedInk, variationSeeds,
} from './presets.js';

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

test('makePigments produces finite independent components for counts one through six', () => {
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff'];
  for (let count = 1; count <= 6; count += 1) {
    const input = Object.freeze(colors.slice(0, count));
    const pigments = makePigments(input);
    assert.equal(pigments.length, count);
    assert.deepEqual(pigments.map(p => p.color), input);
    assert.equal(new Set(pigments).size, count);
    for (const [index, pigment] of pigments.entries()) {
      for (const key of ['mobility', 'spread', 'opacity', 'saturation', 'direction']) {
        assert.ok(Number.isFinite(pigment[key]), `${count} pigments: ${index}.${key}`);
      }
      assert.ok(pigment.mobility > 0);
      assert.ok(pigment.spread > 0 && pigment.spread <= 1);
      assert.ok(pigment.opacity > 0 && pigment.opacity <= 1);
      assert.equal(pigment.saturation, 1);
      assert.equal(pigment.direction, 0);
    }
    pigments[0].color = '#000000';
    assert.deepEqual(input, colors.slice(0, count));
    assert.equal(makePigments(input)[0].color, colors[0]);
  }
});

test('makePigments caps counts at six without changing color order or input', () => {
  assert.equal(MAX_PIGMENTS, 6);
  const colors = Object.freeze(INKS.flatMap(ink => ink.pigments));
  const pigments = makePigments(colors);
  assert.equal(pigments.length, 6);
  assert.deepEqual(pigments, makePigments(colors.slice(0, 6)));
  assert.deepEqual(pigments.map(p => p.color), colors.slice(0, 6));
  assert.deepEqual(makePigments([]), []);
});

test('all three original pigment calibrations remain unchanged for every ink', () => {
  for (const ink of INKS) {
    assert.deepEqual(makePigments(ink.pigments), [
      { color: ink.pigments[0], mobility: 1.02, spread: .18, opacity: .76, saturation: 1, direction: 0 },
      { color: ink.pigments[1], mobility: .65, spread: .42, opacity: .60, saturation: 1, direction: 0 },
      { color: ink.pigments[2], mobility: .36, spread: .34, opacity: .58, saturation: 1, direction: 0 },
    ]);
  }
});

test('initial state retains the calibrated geometry and diffusion defaults', () => {
  const state = initialState();
  const defaults = {
    shape: 'ring', size: 760, stroke: 23, ink: '#282925', inkIndex: 0,
    mode: 'radial', direction: 90, amount: .92, separation: .90,
    fiber: .58, grain: .34, retention: .96, progress: .88, seed: 2847,
    layers: [true, true, true], drops: [], text: 'a', keepSource: true, paths: [], imported: null,
  };
  for (const [key, value] of Object.entries(defaults)) assert.deepEqual(state[key], value, key);
  assert.deepEqual(state.pigments.map(p => p.color), ['#f16dad', '#5d7eae', '#d5c36d']);
});

test('hex and HSL round trips preserve black, white, grays, primaries, and ink colors', () => {
  const colors = [
    '#000000', '#ffffff', '#010101', '#404040', '#808080', '#bfbfbf', '#fefefe',
    '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#AbCdEf',
    ...INKS.flatMap(ink => [ink.color, ...ink.pigments]),
  ];
  for (const color of colors) {
    const hsl = hexToHsl(color);
    assert.ok(Number.isFinite(hsl.h) && hsl.h >= 0 && hsl.h < 360, color);
    assert.ok(Number.isFinite(hsl.s) && hsl.s >= 0 && hsl.s <= 100, color);
    assert.ok(Number.isFinite(hsl.l) && hsl.l >= 0 && hsl.l <= 100, color);
    assert.equal(hslToHex(hsl), color.toLowerCase(), color);
  }
  for (const [color, h] of [
    ['#ff0000', 0], ['#ffff00', 60], ['#00ff00', 120],
    ['#00ffff', 180], ['#0000ff', 240], ['#ff00ff', 300],
  ]) {
    const hsl = Object.freeze({ h, s: 100, l: 50 });
    assert.deepEqual(hexToHsl(color), hsl);
    assert.deepEqual(hexToHsl(hslToHex(hsl)), hsl);
  }
  for (const [color, channel] of [['#000000', 0], ['#808080', 128], ['#ffffff', 255]]) {
    assert.deepEqual(hexToHsl(color), { h: 0, s: 0, l: channel / 255 * 100 });
  }
});

test('HSL hue 360 wraps to zero including achromatic endpoints', () => {
  for (const [s, l, color] of [
    [100, 50, '#ff0000'], [0, 50, '#808080'], [100, 0, '#000000'], [100, 100, '#ffffff'],
  ]) {
    const wrapped = hslToHex({ h: 360, s, l });
    assert.equal(wrapped, color);
    assert.equal(wrapped, hslToHex({ h: 0, s, l }));
    assert.equal(hslToHex(hexToHsl(wrapped)), wrapped);
  }
});

test('mixedInk produces valid darkened colors for one and six pigments without mutation', () => {
  const cases = [
    [['#000000'], '#000000'], [['#ffffff'], '#a3a3a3'],
    [['#ff8000'], '#a35200'],
    [['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff'], '#525252'],
    [Array(6).fill('#ffffff'), '#a3a3a3'], [Array(6).fill('#000000'), '#000000'],
  ];
  for (const [colors, expected] of cases) {
    const pigments = Object.freeze(makePigments(colors).map(p => Object.freeze(p)));
    const result = mixedInk(pigments);
    assert.match(result, /^#[0-9a-f]{6}$/);
    assert.equal(result, expected);
    assert.equal(mixedInk([...pigments].reverse()), result);
  }
});

test('variationSeeds returns ten unique deterministic integers in the four-digit range', () => {
  for (const seed of [-10000, -1, 0, 999, 1000, 2847, 9999, 10000, 4294967295]) {
    const seeds = variationSeeds(seed);
    assert.equal(seeds.length, 10);
    assert.equal(new Set(seeds).size, 10);
    assert.deepEqual(variationSeeds(seed), seeds);
    assert.notEqual(variationSeeds(seed), seeds);
    for (const value of seeds) assert.ok(Number.isInteger(value) && value >= 1000 && value <= 9999);
    if (seed >= 1000 && seed <= 9999) assert.ok(!seeds.includes(seed));
  }
  assert.notDeepEqual(variationSeeds(2847), variationSeeds(2848));
});

test('initial states have isolated marks and offsets', () => {
  const a = initialState(), b = initialState();
  assert.deepEqual(a.marks, []);
  assert.deepEqual(a.offset, { x: 0, y: 0 });
  assert.equal(a.generated, false);
  assert.notEqual(a.marks, b.marks);
  assert.notEqual(a.offset, b.offset);
  a.marks.push({ type: 'dot', x: .25, y: .75, radius: .1 });
  a.offset.x = .2;
  a.offset.y = -.3;
  a.generated = true;
  assert.deepEqual(b.marks, []);
  assert.deepEqual(b.offset, { x: 0, y: 0 });
  assert.equal(b.generated, false);
  assert.deepEqual(initialState().marks, []);
  assert.deepEqual(initialState().offset, { x: 0, y: 0 });
});

test('imported texture filtering preserves premultiplied color and restores upload flags', () => {
  const calls = [];
  const gl = Object.fromEntries(['TEXTURE0', 'TEXTURE1', 'TEXTURE_2D', 'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER', 'LINEAR', 'RGBA', 'RG32F', 'RG', 'FLOAT', 'UNSIGNED_BYTE', 'UNPACK_FLIP_Y_WEBGL', 'UNPACK_PREMULTIPLY_ALPHA_WEBGL'].map(key => [key, key]));
  for (const method of ['activeTexture', 'bindTexture', 'texParameteri', 'pixelStorei', 'texImage2D']) {
    gl[method] = (...args) => calls.push([method, ...args]);
  }
  const data = new Uint8ClampedArray(768 * 768 * 4);
  data.set([255, 255, 255, 128], (384 * 768 + 384) * 4);
  const canvas = { getContext: () => ({ getImageData: () => ({ data }) }) };
  const renderer = Object.assign(Object.create(ChromatographyRenderer.prototype), { gl, mask: 'mask', source: 'source' });
  renderer.setMask(canvas, canvas, true);
  const uploads = calls.filter(([name]) => name === 'texImage2D');
  const field = uploads[0].at(-1);
  assert.ok(field[(384 * 768 + 384) * 2] < 0, 'a translucent white source still releases pigment');
  assert.ok(Math.abs(field[(384 * 768 + 384) * 2 + 1] - 128 / 255 * 1.6) < 1e-6);
  assert.equal(field[1], 0, 'transparent paper has no pigment');
  assert.equal(uploads[1].at(-1), canvas);
  assert.deepEqual(calls.filter(([name]) => name === 'pixelStorei'), [
    ['pixelStorei', gl.UNPACK_FLIP_Y_WEBGL, true],
    ['pixelStorei', gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true],
    ['pixelStorei', gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false],
    ['pixelStorei', gl.UNPACK_FLIP_Y_WEBGL, false],
  ]);
  assert.deepEqual(calls.filter(([name]) => name === 'texParameteri'), [
    ['texParameteri', gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR],
    ['texParameteri', gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR],
  ]);
});

test('reference palettes extend the existing inks without changing their indices', () => {
  assert.deepEqual(INKS.slice(0, 6).map(ink => ink.name), ['Carbon black', 'Midnight blue', 'Burnt umber', 'Aubergine', 'Persimmon', 'Forest green']);
  assert.deepEqual(INKS.slice(6).map(ink => ink.pigments), [
    ['#ff3864', '#1888ff', '#ffbd2e'],
    ['#0a2a8a', '#ff4ca5', '#31d9c3'],
    ['#6320ee', '#f72585', '#4cc9f0'],
    ['#101010', '#2f68ff', '#ff5d20'],
    ['#00543d', '#ee7b30', '#992f73'],
  ]);
  for (const palette of INKS.slice(6)) assert.equal(palette.color, mixedInk(makePigments(palette.pigments)));
});
