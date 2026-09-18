import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeededMarks, drawMark, paintMask, scrubState } from './artwork.js';
import { initialState } from './presets.js';

function contextSpy(side = 600) {
  const calls = [];
  const ctx = { canvas: { width: side, height: side } };
  for (const method of ['clearRect', 'beginPath', 'moveTo', 'lineTo', 'arc', 'stroke', 'fill', 'closePath', 'fillText', 'drawImage', 'save', 'translate', 'restore']) {
    ctx[method] = (...args) => {
      for (const value of args) {
        if (typeof value === 'number') assert.ok(Number.isFinite(value), `${method} received ${value}`);
      }
      calls.push([method, ...args]);
    };
  }
  return { ctx, calls };
}

const mark = { type: 'dot', x: .25, y: .75, radius: .1, stroke: 30 };

test('createSeededMarks is deterministic across interleaved seeds with independent nested data', () => {
  const seeds = [0, 1, 2847, 7341, 9999, 4294967295];
  const results = seeds.map(createSeededMarks);
  assert.equal(new Set(results.map(marks => JSON.stringify(marks))).size, seeds.length);
  for (const [index, seed] of seeds.entries()) {
    const repeated = createSeededMarks(seed);
    assert.deepEqual(repeated, results[index], `seed ${seed}`);
    assert.notEqual(repeated, results[index]);
    assert.notEqual(repeated[0], results[index][0]);
    assert.notEqual(repeated[0].points, results[index][0].points);
    assert.notEqual(repeated[0].points[0], results[index][0].points[0]);
    repeated[0].x = -10;
    repeated[0].points[0].y = -10;
    assert.deepEqual(createSeededMarks(seed), results[index]);
  }
});

test('createSeededMarks produces five to nine marks with finite bounded geometry', () => {
  for (const seed of [0, 1, 1000, 2847, 4713, 7341, 9999, 4294967295]) {
    const marks = createSeededMarks(seed);
    assert.ok(marks.length >= 5 && marks.length <= 9);
    for (const generated of marks) {
      assert.ok(['dot', 'ring', 'arc', 'line', 'freehand'].includes(generated.type));
      for (const key of ['x', 'y', 'radius', 'endX', 'endY', 'stroke', 'size']) {
        assert.ok(Number.isFinite(generated[key]), `seed ${seed}: ${key}`);
      }
      for (const key of ['x', 'y', 'endX', 'endY']) assert.ok(generated[key] >= 0 && generated[key] <= 1);
      assert.ok(generated.radius > 0 && generated.radius < 1);
      assert.ok(generated.stroke > 0 && generated.size > 0);
      assert.equal(generated.points.length, 16);
      for (const point of generated.points) {
        assert.ok(Number.isFinite(point.x) && point.x >= 0 && point.x <= 1);
        assert.ok(Number.isFinite(point.y) && point.y >= 0 && point.y <= 1);
      }
      const { ctx, calls } = contextSpy();
      drawMark(ctx, generated, ctx.canvas.width);
      assert.ok(calls.length > 0);
      assert.ok(Number.isFinite(ctx.lineWidth) && ctx.lineWidth > 0);
    }
  }
});

test('scrubState seeks to both endpoints and the midpoint with or without drops', () => {
  for (const drops of [[], [{ x: .2, y: .3, age: 8 }, { x: .7, y: .8, age: 19 }]]) {
    const state = { ...initialState(), drops, marks: createSeededMarks(2847) };
    const before = structuredClone(state);
    const references = [...drops];
    for (const [fraction, progress, age] of [[0, 0, 0], [1, 1.22, 22], [.5, .61, 11], [0, 0, 0]]) {
      scrubState(state, fraction);
      assert.deepEqual(state, {
        ...before, progress, drops: before.drops.map(drop => ({ ...drop, age })),
      });
      assert.equal(state.drops, drops);
      for (const [index, drop] of references.entries()) assert.equal(state.drops[index], drop);
    }
  }
});

test('scrubState is deterministic and history-independent when seeking nonmonotonically', () => {
  const baseline = {
    ...initialState(), marks: createSeededMarks(7341), offset: { x: .1, y: -.2 },
    drops: [{ x: .2, y: .3, age: 7 }, { x: .8, y: .7, age: 2 }],
  };
  const state = structuredClone(baseline);
  const seen = new Map();
  for (const fraction of [.75, .2, 1, 0, .75, .5, .2, 1]) {
    scrubState(state, fraction);
    const direct = structuredClone(baseline);
    scrubState(direct, fraction);
    assert.deepEqual(state, direct, `direct seek to ${fraction}`);
    if (seen.has(fraction)) assert.deepEqual(state, seen.get(fraction), `revisited ${fraction}`);
    seen.set(fraction, structuredClone(state));
    const snapshot = structuredClone(state);
    scrubState(state, fraction);
    assert.deepEqual(state, snapshot, 'seeking to the same fraction is idempotent');
  }
});

test('drawMark scales circular geometry and chooses fill versus stroke', () => {
  for (const side of [600, 1200]) {
    for (const type of ['dot', 'circle', 'ring', 'arc']) {
      const { ctx, calls } = contextSpy(side);
      drawMark(ctx, { ...mark, type }, side);
      assert.equal(ctx.lineWidth, side / 100);
      assert.deepEqual(calls, [
        ['beginPath'],
        ['arc', side / 4, side * .75, side / 10, type === 'arc' ? .72 : 0, type === 'arc' ? Math.PI * 2 - .72 : Math.PI * 2],
        [type === 'dot' || type === 'circle' ? 'fill' : 'stroke'],
      ]);
    }
  }
});

test('drawMark keeps zero-radius circles and zero-length strokes drawable', () => {
  const circle = contextSpy();
  drawMark(circle.ctx, { ...mark, radius: 0 }, 600);
  assert.deepEqual(circle.calls, [['beginPath'], ['arc', 150, 450, .0001, 0, Math.PI * 2], ['fill']]);

  const line = contextSpy();
  drawMark(line.ctx, { ...mark, type: 'line', endX: mark.x, endY: mark.y }, 600);
  assert.deepEqual(line.calls, [
    ['beginPath'], ['moveTo', 150, 450], ['lineTo', 150, 450], ['lineTo', 150.01, 450.01], ['stroke'],
  ]);

  const freehand = contextSpy();
  drawMark(freehand.ctx, { type: 'freehand', stroke: 30, points: [{ x: .25, y: .75 }] }, 600);
  assert.deepEqual(freehand.calls, [['beginPath'], ['moveTo', 150, 450], ['lineTo', 150.01, 450.01], ['stroke']]);
});

test('drawMark scales line endpoints and freehand points without changing their input', () => {
  const line = contextSpy();
  drawMark(line.ctx, { ...mark, type: 'line', endX: .5, endY: .25 }, 600);
  assert.deepEqual(line.calls, [['beginPath'], ['moveTo', 150, 450], ['lineTo', 300, 150], ['stroke']]);

  const freehand = contextSpy();
  const points = Object.freeze([{ x: .25, y: .75 }, { x: .5, y: .25 }, { x: .75, y: .5 }].map(p => Object.freeze(p)));
  drawMark(freehand.ctx, Object.freeze({ type: 'freehand', stroke: 30, points }), 600);
  assert.equal(freehand.ctx.lineWidth, 6);
  assert.deepEqual(freehand.calls, [
    ['beginPath'], ['moveTo', 150, 450], ['lineTo', 300, 150], ['lineTo', 450, 300], ['stroke'],
  ]);
});

test('drawMark centers scaled text and closes and fills a five-vertex polygon', () => {
  const text = contextSpy();
  drawMark(text.ctx, { ...mark, type: 'text', text: 'Ink', size: 600 }, 600);
  assert.equal(text.ctx.font, '120px Georgia, serif');
  assert.equal(text.ctx.textAlign, 'center');
  assert.equal(text.ctx.textBaseline, 'middle');
  assert.deepEqual(text.calls, [['beginPath'], ['fillText', 'Ink', 150, 450, 540]]);

  const polygon = contextSpy();
  drawMark(polygon.ctx, { ...mark, type: 'polygon' }, 600);
  assert.deepEqual(polygon.calls.map(call => call[0]), [
    'beginPath', 'moveTo', 'lineTo', 'lineTo', 'lineTo', 'lineTo', 'closePath', 'fill',
  ]);
  for (const [index, [, x, y]] of polygon.calls.slice(1, 6).entries()) {
    const radius = index % 2 ? 48 : 60;
    const angle = index * Math.PI * 2 / 5 - .5;
    assert.ok(Math.abs(x - (150 + Math.cos(angle) * radius)) < 1e-10);
    assert.ok(Math.abs(y - (450 + Math.sin(angle) * radius)) < 1e-10);
  }
});

test('paintMask clears the square canvas and configures black rounded drawing styles', () => {
  const { ctx, calls } = contextSpy();
  paintMask(ctx, initialState());
  assert.deepEqual(calls, [['clearRect', 0, 0, 600, 600]]);
  assert.equal(ctx.fillStyle, '#000');
  assert.equal(ctx.strokeStyle, '#000');
  assert.equal(ctx.lineCap, 'round');
  assert.equal(ctx.lineJoin, 'round');
});

test('paintMask draws the centered text source before appended marks without mutating state', () => {
  const { ctx, calls } = contextSpy();
  const state = { ...initialState(), shape: 'text', size: 1500, text: 'a', marks: [mark] };
  const before = structuredClone(state);
  paintMask(ctx, state);
  assert.equal(ctx.font, '300px Georgia, serif');
  assert.deepEqual(calls, [
    ['clearRect', 0, 0, 600, 600], ['beginPath'], ['fillText', 'a', 300, 300, 540],
    ['beginPath'], ['arc', 150, 450, 60, 0, Math.PI * 2], ['fill'],
  ]);
  assert.deepEqual(state, before);
});

test('paintMask scales freehand paths about the center and preserves separate strokes', () => {
  const { ctx, calls } = contextSpy();
  const state = {
    ...initialState(), shape: 'freehand', size: 1800, stroke: 30,
    paths: [[{ x: .25, y: .375 }, { x: .75, y: .625 }], [{ x: .5, y: .5 }]],
  };
  const before = structuredClone(state);
  paintMask(ctx, state);
  assert.equal(ctx.lineWidth, 6);
  assert.deepEqual(calls, [
    ['clearRect', 0, 0, 600, 600],
    ['beginPath'], ['moveTo', 0, 150], ['lineTo', 600, 450], ['stroke'],
    ['beginPath'], ['moveTo', 300, 300], ['lineTo', 300.01, 300.01], ['stroke'],
  ]);
  assert.deepEqual(state, before);
});

test('paintMask centers imported images with aspect ratio and import scale intact', () => {
  for (const [width, height, geometry] of [
    [400, 200, [225, 262.5, 150, 75]], [200, 400, [262.5, 225, 75, 150]],
  ]) {
    const { ctx, calls } = contextSpy();
    const image = { width, height };
    const state = { ...initialState(), shape: 'import', size: 1500, importScale: .5, marks: [mark] };
    const before = structuredClone(state);
    paintMask(ctx, state, image);
    assert.deepEqual(calls, [
      ['clearRect', 0, 0, 600, 600], ['drawImage', image, ...geometry],
      ['beginPath'], ['arc', 150, 450, 60, 0, Math.PI * 2], ['fill'],
    ]);
    assert.deepEqual(state, before);
  }
});

test('paintMask still draws marks when the imported image is unavailable', () => {
  const { ctx, calls } = contextSpy();
  paintMask(ctx, { ...initialState(), shape: 'import', marks: [mark] }, null);
  assert.deepEqual(calls, [
    ['clearRect', 0, 0, 600, 600], ['beginPath'], ['arc', 150, 450, 60, 0, Math.PI * 2], ['fill'],
  ]);
});

test('paintMask translates before drawing local off-paper marks and restores the transform', () => {
  const { ctx, calls } = contextSpy();
  const state = {
    ...initialState(), shape: 'composition', offset: { x: .3, y: -.2 },
    marks: [{ ...mark, x: -.2, y: .7 }],
  };
  const before = structuredClone(state);
  paintMask(ctx, state);
  assert.deepEqual(calls, [
    ['clearRect', 0, 0, 600, 600], ['save'], ['translate', 180, -120],
    ['beginPath'], ['arc', -120, 420, 60, 0, Math.PI * 2], ['fill'], ['restore'],
  ]);
  assert.deepEqual(state, before);
  calls.length = 0;
  paintMask(ctx, initialState());
  assert.deepEqual(calls, [['clearRect', 0, 0, 600, 600]]);
});

test('paintMask translates imported colors together with appended marks', () => {
  const { ctx, calls } = contextSpy();
  const image = { width: 400, height: 200 };
  const state = { ...initialState(), shape: 'import', size: 1500, offset: { x: -.25, y: .125 }, marks: [mark] };
  paintMask(ctx, state, image);
  assert.deepEqual(calls, [
    ['clearRect', 0, 0, 600, 600], ['save'], ['translate', -150, 75],
    ['drawImage', image, 150, 225, 300, 150],
    ['beginPath'], ['arc', 150, 450, 60, 0, Math.PI * 2], ['fill'], ['restore'],
  ]);
});
