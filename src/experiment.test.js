import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EXPERIMENT_BYTES, serializeExperiment, parseExperiment } from './experiment.js';
import { initialState, presetState, INKS, PRESETS, makePigments } from './presets.js';
import { createSeededMarks, DROP_PLACEMENTS } from './artwork.js';
import { crc32 } from './export.js';

const PNG_PREFIX = 'data:image/png;base64,';
const PNG = PNG_PREFIX + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const BRUSHES = ['dot', 'line', 'circle', 'ring', 'arc', 'polygon', 'freehand', 'text'];

function initialSnapshot() {
  return {
    state: initialState(), tool: 'water', brushShape: 'ring', inputMode: 'draw',
    selectedPreset: PRESETS.findIndex(preset => preset.name === 'Quiet bloom'),
    elapsed: 0, hasBloomed: false, animationMode: 'bloom',
  };
}

function drawnMark(type = 'freehand') {
  return {
    type, x: -.8, y: 1.2, endX: 2, endY: -.25, radius: 1.75,
    stroke: 512, size: 6400, text: 'ink <&>', points: [{ x: -.8, y: 1.2 }, { x: 2, y: -.25 }],
  };
}

function editedSnapshot() {
  const saved = initialSnapshot();
  Object.assign(saved, { tool: 'stamp', brushShape: 'text', inputMode: 'import', selectedPreset: -1, elapsed: 12.375, hasBloomed: true, animationMode: 'water' });
  Object.assign(saved.state, {
    shape: 'import', size: 1250, stroke: 155, ink: '#13579B', inkIndex: -1,
    pigments: makePigments(['#aAbBcC', '#112233', '#445566', '#778899', '#112299', '#abcdef']).map((pigment, index) => ({
      ...pigment, mobility: .15 + index / 5, spread: .1 + index / 10,
      opacity: index / 5, saturation: index / 4, direction: -180 + index * 60,
    })),
    mode: 'directional', direction: 315, amount: 1.41, separation: .71, fiber: .44,
    grain: .73, retention: .29, progress: .6789, seed: 0xffffffff,
    layers: [false, true, false],
    drops: [0, .001, .3, 2.5, 6, 12.125, 18.3, 22].map((age, index) => ({ x: index / 7, y: 1 - index / 7, age })),
    dropRadius: .27, dropPosition: { x: .1234, y: .9876 }, dropPlacement: 'custom', showDropMarkers: false,
    text: '水 & ink', keepSource: false,
    paths: [[{ x: -2, y: 3 }, { x: 1.25, y: -.33 }], [], [{ x: .1, y: .9 }]],
    imported: PNG, importName: '<original> 水.svg', importScale: 1.63,
    randomness: 1.81, speed: .27, sourceRandomness: .64,
    marks: [...BRUSHES.map(drawnMark), ...createSeededMarks(4713)],
    offset: { x: -.65, y: .35 }, generated: false,
  });
  return saved;
}

function documentFor(saved = initialSnapshot()) {
  return JSON.parse(serializeExperiment(saved));
}

function parseDocument(file) {
  return parseExperiment(JSON.stringify(file));
}

function change(file, path, value, remove = false) {
  const keys = path.split('.');
  const key = keys.pop();
  const parent = keys.reduce((object, property) => object[property], file);
  if (remove) delete parent[key];
  else parent[key] = value;
}

function pngBytes() {
  return Buffer.from(PNG.slice(PNG_PREFIX.length), 'base64');
}

function dataUrl(bytes) {
  return PNG_PREFIX + bytes.toString('base64');
}

function changedPng(edit) {
  const bytes = pngBytes();
  edit(bytes);
  return dataUrl(bytes);
}

function assertBadImport(imported, pattern = /state\.imported/) {
  const file = documentFor();
  file.snapshot.state.imported = imported;
  assert.throws(() => parseDocument(file), pattern);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test('initial state round trips exactly with a named versioned wrapper', () => {
  assert.equal(MAX_EXPERIMENT_BYTES, 32 * 1024 * 1024);
  const saved = initialSnapshot(), text = serializeExperiment(saved), file = JSON.parse(text);
  assert.equal(file.format, 'chroma-experiment');
  assert.equal(file.version, 1);
  assert.equal(saved.state.localFlow, false);
  assert.equal(file.snapshot.state.localFlow, false);
  assert.equal(file.paletteName, 'Carbon black');
  assert.equal(file.presetName, 'Quiet bloom');
  assert.deepEqual(file.snapshot, saved);
  assert.deepEqual(parseExperiment(text), saved);
  assert.equal(parseExperiment(text).state.ink, '#282925', 'source ink is not remixed');
});

for (const [index, preset] of PRESETS.entries()) {
  test(`preset round trip: ${preset.name}`, () => {
    const saved = initialSnapshot();
    saved.state = presetState(preset);
    saved.selectedPreset = index;
    saved.brushShape = saved.state.shape === 'composition' ? 'line' : saved.state.shape;
    const text = serializeExperiment(saved);
    assert.equal(JSON.parse(text).presetName, preset.name);
    assert.equal(JSON.parse(text).paletteName, preset.pigments ? null : INKS[preset.inkIndex].name);
    assert.deepEqual(parseExperiment(text), saved);
  });
}

test('edited six-pigment import preserves every setting, mark, path, color and independent drop age', () => {
  const saved = editedSnapshot();
  const restored = parseExperiment(serializeExperiment(saved));
  assert.deepEqual(restored, saved);
  assert.equal(restored.state.ink, '#13579B');
  assert.equal(restored.state.imported, PNG);
  assert.equal(Object.hasOwn(restored.state.marks.at(-1), 'text'), false);
  assert.deepEqual(Object.keys(restored.state).sort(), Object.keys(initialState()).sort());
});

test('legacy effects without local flow keep the original model and all other settings', () => {
  for (const omitRadius of [false, true]) {
    const saved = editedSnapshot();
    if (omitRadius) saved.state.dropRadius = 1;
    const file = documentFor(saved);
    delete file.snapshot.state.localFlow;
    if (omitRadius) delete file.snapshot.state.dropRadius;
    const restored = parseDocument(file);
    assert.equal(restored.state.localFlow, false);
    assert.deepEqual(restored, saved);
    assert.equal(documentFor(restored).snapshot.state.localFlow, false);
    assert.equal(documentFor(file.snapshot).snapshot.state.localFlow, false);
  }
});

test('enabled local flow round trips with six pigments, imports and independent drop ages', () => {
  for (const keepSource of [false, true]) {
    const saved = editedSnapshot();
    Object.assign(saved.state, { localFlow: true, keepSource });
    const file = documentFor(saved);
    assert.equal(file.version, 1);
    assert.equal(file.snapshot.state.localFlow, true);
    assert.deepEqual(parseDocument(file), saved);
  }
});

test('supplied local flow values must be booleans, never coerced or defaulted', () => {
  for (const localFlow of [null, 0, 1, -1, 'true', 'false', '', {}, [], [true]]) {
    const file = documentFor();
    file.snapshot.state.localFlow = localFlow;
    assert.throws(() => parseDocument(file), /state\.localFlow must be a boolean/);
    assert.throws(() => serializeExperiment(file.snapshot), /state\.localFlow must be a boolean/);
  }
  const saved = initialSnapshot();
  saved.state.localFlow = undefined;
  assert.throws(() => serializeExperiment(saved), /state\.localFlow is required/);
});

test('dry, empty and generated states, all tools/shapes and one through six pigments round trip', () => {
  const saved = initialSnapshot();
  Object.assign(saved.state, { shape: 'composition', progress: 0, generated: false, layers: [false, false, false], text: '' });
  saved.selectedPreset = -1;
  assert.deepEqual(parseExperiment(serializeExperiment(saved)), saved);
  for (const tool of ['water', 'draw', 'stamp', 'move']) {
    for (const shape of [...BRUSHES, 'composition']) {
      saved.tool = tool;
      saved.state.shape = shape;
      saved.brushShape = BRUSHES.includes(shape) ? shape : 'ring';
      saved.state.marks = createSeededMarks(0);
      saved.state.generated = true;
      saved.state.seed = 0;
      assert.deepEqual(parseExperiment(serializeExperiment(saved)), saved);
    }
  }
  for (let count = 1; count <= 6; count++) {
    saved.state.pigments = makePigments(Array(count).fill('#123456'));
    assert.deepEqual(parseExperiment(serializeExperiment(saved)), saved);
  }
});

test('resized geometry outside canvas and UI ranges is preserved, including zero-radius marks', () => {
  const saved = initialSnapshot();
  saved.state.marks = createSeededMarks(2847);
  saved.state.marks.push(drawnMark('text'), { ...drawnMark('circle'), radius: 0, points: [] });
  // Mirror main.js size/stroke transforms at the UI extremes, not a clamped import.
  const scale = 1600 / 150;
  for (const mark of saved.state.marks) {
    for (const key of ['x', 'y', 'endX', 'endY']) mark[key] = .5 + (mark[key] - .5) * scale;
    mark.radius *= scale;
    mark.size *= scale;
    mark.stroke *= 160 / 5;
    for (const point of mark.points) {
      point.x = .5 + (point.x - .5) * scale;
      point.y = .5 + (point.y - .5) * scale;
    }
  }
  assert.deepEqual(parseExperiment(serializeExperiment(saved)), saved);
});

test('all water placement modes preserve next-drop coordinates independently of existing drops', () => {
  for (const dropPlacement of [...DROP_PLACEMENTS.map(option => option.value), 'random', 'custom']) {
    const saved = editedSnapshot();
    saved.state.dropPlacement = dropPlacement;
    assert.deepEqual(parseExperiment(serializeExperiment(saved)), saved);
  }
});

test('legacy effects without a radius retain the original water reach', () => {
  const file = documentFor(editedSnapshot());
  delete file.snapshot.state.dropRadius;
  const restored = parseDocument(file);
  assert.equal(restored.state.dropRadius, 1);
  assert.deepEqual(restored.state, { ...file.snapshot.state, dropRadius: 1 });
  assert.equal(JSON.parse(serializeExperiment(restored)).snapshot.state.dropRadius, 1);
});

test('drop radius round trips at both bounds without changing water amount, progress or ages', () => {
  for (const dropRadius of [.1, .25, 1, 1.5]) {
    const saved = editedSnapshot();
    saved.state.dropRadius = dropRadius;
    assert.deepEqual(parseExperiment(serializeExperiment(saved)), saved);
  }
});

test('invalid drop radii are rejected rather than defaulted or clamped', () => {
  for (const dropRadius of [0, -.1, .099, 1.501, null, '0.25', true, {}, []]) {
    const file = documentFor();
    file.snapshot.state.dropRadius = dropRadius;
    assert.throws(() => parseDocument(file), /state\.dropRadius/);
    assert.throws(() => serializeExperiment(file.snapshot), /state\.dropRadius/);
  }
});

test('palette and preset names resolve against current lists rather than stale indices', () => {
  const file = documentFor(editedSnapshot());
  file.paletteName = INKS[2].name;
  file.presetName = PRESETS[4].name;
  file.snapshot.state.inkIndex = 999;
  file.snapshot.selectedPreset = 777;
  const result = parseDocument(file);
  assert.equal(result.state.inkIndex, 2);
  assert.equal(result.selectedPreset, 4);
  assert.equal(result.state.ink, '#13579B');
  assert.deepEqual(result.state.pigments, file.snapshot.state.pigments);
  assert.equal(JSON.parse(serializeExperiment(result)).paletteName, INKS[2].name);
});

test('unknown or custom names resolve to -1 without replacing actual stored colors', () => {
  for (const names of [[null, null], ['Removed palette', 'Old preset'], ['__proto__', 'constructor'], ['', '']]) {
    const file = documentFor();
    [file.paletteName, file.presetName] = names;
    const result = parseDocument(file);
    assert.equal(result.state.inkIndex, -1);
    assert.equal(result.selectedPreset, -1);
    assert.equal(result.state.ink, file.snapshot.state.ink);
    assert.deepEqual(result.state.pigments, file.snapshot.state.pigments);
  }
});

test('saving and loading do not mutate snapshots, defaults, palettes or presets and return independent objects', () => {
  const saved = deepFreeze(editedSnapshot()), before = structuredClone(saved);
  const palettes = structuredClone(INKS), presets = structuredClone(PRESETS), defaults = initialState();
  const text = serializeExperiment(saved);
  const first = parseExperiment(text), second = parseExperiment(text);
  first.state.pigments[0].color = '#ffffff';
  first.state.marks[0].points[0].x = 10;
  first.state.paths[0][0].y = 10;
  first.state.drops[0].age = 10;
  first.state.dropPosition.x = 0;
  first.state.offset.x = 1;
  first.state.layers[0] = true;
  assert.deepEqual(saved, before);
  assert.deepEqual(second, saved);
  assert.deepEqual(INKS, palettes);
  assert.deepEqual(PRESETS, presets);
  assert.deepEqual(initialState(), defaults);
});

test('only whitelisted visible state is saved, never history or an animation target', () => {
  const saved = initialSnapshot();
  const expected = structuredClone(saved);
  saved.animationTarget = editedSnapshot().state;
  saved.undoStack = [editedSnapshot()];
  saved.playing = true;
  saved.state.futureOption = { enabled: true };
  assert.deepEqual(parseExperiment(serializeExperiment(saved)), expected);
  assert.equal(Object.hasOwn(documentFor(saved).snapshot, 'animationTarget'), false);
});

test('invalid JSON, format, version and root types fail with readable errors', () => {
  for (const text of ['', '{', 'undefined', '{"format":', '{"value": NaN}']) {
    assert.throws(() => parseExperiment(text), /not valid JSON/);
  }
  for (const text of ['null', '[]', 'true', '1', '"test"']) assert.throws(() => parseExperiment(text), /file must be an object/);
  for (const value of [null, undefined, 42, {}, Buffer.from('{}')]) assert.throws(() => parseExperiment(value), /must be JSON text/);
  for (const [key, values] of [['format', ['other', 1, null]], ['version', [0, 2, '1', null, {}]]]) {
    for (const value of values) {
      const file = documentFor();
      file[key] = value;
      assert.throws(() => parseDocument(file), new RegExp(key));
    }
  }
});

test('every required wrapper, snapshot, state and nested field rejects omission', () => {
  const saved = editedSnapshot();
  const file = documentFor(saved);
  const paths = [
    ...Object.keys(file),
    ...Object.keys(saved).map(key => `snapshot.${key}`),
    ...Object.keys(saved.state).filter(key => !['dropRadius', 'localFlow'].includes(key)).map(key => `snapshot.state.${key}`),
    ...Object.keys(saved.state.pigments[0]).map(key => `snapshot.state.pigments.0.${key}`),
    ...Object.keys(saved.state.drops[0]).map(key => `snapshot.state.drops.0.${key}`),
    ...Object.keys(saved.state.marks[0]).filter(key => key !== 'text').map(key => `snapshot.state.marks.0.${key}`),
    'snapshot.state.marks.7.text', 'snapshot.state.marks.0.points.0.x', 'snapshot.state.paths.0.0.y',
    'snapshot.state.dropPosition.x', 'snapshot.state.dropPosition.y', 'snapshot.state.offset.x', 'snapshot.state.offset.y',
  ];
  for (const path of paths) {
    const changed = structuredClone(file);
    change(changed, path, undefined, true);
    assert.throws(() => parseDocument(changed), /is required/, path);
  }
});

test('wrong field types, enums, colors, bounds and oversized strings fail at their field', () => {
  const cases = [
    ['paletteName', 3], ['paletteName', 'x'.repeat(257)], ['presetName', {}],
    ['snapshot', []], ['snapshot.state', null], ['snapshot.tool', 'erase'], ['snapshot.tool', 0],
    ['snapshot.brushShape', 'import'], ['snapshot.inputMode', 'upload'], ['snapshot.animationMode', 'target'],
    ['snapshot.selectedPreset', 1.5], ['snapshot.selectedPreset', -2], ['snapshot.selectedPreset', 1000001],
    ['snapshot.elapsed', -1], ['snapshot.elapsed', 31536001], ['snapshot.elapsed', '1'], ['snapshot.hasBloomed', 1],
    ['snapshot.state.shape', 'unknown'], ['snapshot.state.mode', 'noise'], ['snapshot.state.dropPlacement', 'corner'],
    ['snapshot.state.ink', '#fff'], ['snapshot.state.ink', '#gggggg'], ['snapshot.state.ink', 'red'],
    ['snapshot.state.inkIndex', -2], ['snapshot.state.inkIndex', 1.5],
    ['snapshot.state.size', 0], ['snapshot.state.size', 10001], ['snapshot.state.stroke', 0],
    ['snapshot.state.direction', 361], ['snapshot.state.amount', 0], ['snapshot.state.amount', 1.51],
    ['snapshot.state.separation', 1.1], ['snapshot.state.fiber', -.1], ['snapshot.state.grain', 2], ['snapshot.state.retention', -1],
    ['snapshot.state.progress', 1.23], ['snapshot.state.seed', -1], ['snapshot.state.seed', 4294967296], ['snapshot.state.seed', 1.1],
    ['snapshot.state.layers', [true, true]], ['snapshot.state.layers', [true, true, true, true]], ['snapshot.state.layers.0', 0],
    ['snapshot.state.drops.0.age', 23], ['snapshot.state.drops.0.age', -1], ['snapshot.state.drops.0.x', -.1], ['snapshot.state.drops.0.y', 1.01],
    ['snapshot.state.dropPosition.x', 1.01], ['snapshot.state.dropPosition', []], ['snapshot.state.showDropMarkers', 'false'],
    ['snapshot.state.text', 'x'.repeat(257)], ['snapshot.state.text', null], ['snapshot.state.keepSource', 1],
    ['snapshot.state.importName', 'x'.repeat(1025)], ['snapshot.state.importScale', .1], ['snapshot.state.importScale', 3],
    ['snapshot.state.randomness', 3], ['snapshot.state.speed', -1], ['snapshot.state.sourceRandomness', 2], ['snapshot.state.generated', 'true'],
    ['snapshot.state.pigments.0.color', '#zzzzzz'], ['snapshot.state.pigments.0.mobility', 0], ['snapshot.state.pigments.0.spread', 2],
    ['snapshot.state.pigments.0.opacity', 2], ['snapshot.state.pigments.0.saturation', 2], ['snapshot.state.pigments.0.direction', -181],
    ['snapshot.state.marks.0.type', 'import'], ['snapshot.state.marks.0.radius', -1], ['snapshot.state.marks.0.stroke', 0],
    ['snapshot.state.marks.0.size', 100001], ['snapshot.state.marks.0.endX', 1001], ['snapshot.state.marks.0.endY', -1001],
    ['snapshot.state.marks.0.text', 12], ['snapshot.state.marks.0.points.0.x', '0'], ['snapshot.state.paths.0.0.y', 1001],
    ['snapshot.state.offset.x', -1001], ['snapshot.state.offset.y', null],
  ];
  const file = documentFor(editedSnapshot());
  for (const [path, value] of cases) {
    const changed = structuredClone(file);
    change(changed, path, value);
    assert.throws(() => parseDocument(changed), /Invalid experiment:/, path);
  }
  for (const path of ['pigments', 'marks', 'paths', 'drops', 'layers']) {
    const changed = structuredClone(file);
    changed.snapshot.state[path] = {};
    assert.throws(() => parseDocument(changed), /must be an array/, path);
  }
  for (const path of ['pigments.0', 'marks.0', 'drops.0', 'marks.0.points.0', 'paths.0.0']) {
    const changed = structuredClone(file);
    change(changed, `snapshot.state.${path}`, null);
    assert.throws(() => parseDocument(changed), /must be an object/, path);
  }
});

test('nonfinite numbers are rejected both before serialization and after JSON numeric overflow', () => {
  const paths = ['elapsed', 'state.progress', 'state.dropRadius', 'state.pigments.0.mobility', 'state.drops.0.age', 'state.marks.0.x', 'state.paths.0.0.y'];
  for (const path of paths) {
    for (const value of [NaN, Infinity, -Infinity]) {
      const saved = editedSnapshot();
      change(saved, path, value);
      assert.throws(() => serializeExperiment(saved), /finite number/, path);
    }
    const file = documentFor(editedSnapshot());
    change(file, `snapshot.${path}`, '__NONFINITE__');
    for (const value of ['1e999', '-1e999', 'null']) {
      assert.throws(() => parseExperiment(JSON.stringify(file).replace('"__NONFINITE__"', value)), /finite number/, path);
    }
  }
});

test('collection limits enforce 1–6 pigments, 8 drops and aggregate stroke/point budgets', () => {
  for (const [field, value] of [
    ['pigments', []], ['pigments', Array(7).fill(initialState().pigments[0])],
    ['drops', Array(9).fill({ x: .5, y: .5, age: 0 })],
    ['marks', Array(10001).fill(drawnMark())], ['paths', Array(10001).fill([])],
  ]) {
    const file = documentFor();
    file.snapshot.state[field] = value;
    assert.throws(() => parseDocument(file), /must contain/, field);
  }
  const file = documentFor();
  file.snapshot.state.marks = Array(5001).fill({ ...drawnMark(), points: [] });
  file.snapshot.state.paths = Array(5000).fill([]);
  assert.throws(() => parseDocument(file), /total stroke limit/);
  file.snapshot.state.marks = [drawnMark()];
  file.snapshot.state.paths = [Array(20001).fill({ x: .5, y: .5 })];
  assert.throws(() => parseDocument(file), /20000 items/);
  file.snapshot.state.paths = [];
  file.snapshot.state.marks[0].points = Array(20001).fill({ x: .5, y: .5 });
  assert.throws(() => parseDocument(file), /20000 items/);
  const points = Array(20000).fill({ x: .5, y: .5 });
  file.snapshot.state.paths = Array(5).fill(points);
  file.snapshot.state.marks = Array(5).fill({ ...drawnMark(), points });
  assert.equal(parseDocument(file).state.marks.length, 5, 'exact total point limit is accepted');
  file.snapshot.state.marks.push({ ...drawnMark(), points: [{ x: 0, y: 0 }] });
  assert.throws(() => parseDocument(file), /total point limit/);
});

test('sparse arrays cannot produce invalid saved documents', () => {
  const saved = initialSnapshot();
  saved.state.marks = Array(1);
  assert.throws(() => serializeExperiment(saved), /is required/);
  saved.state.marks = [];
  saved.state.paths = [Array(1)];
  assert.throws(() => serializeExperiment(saved), /is required/);
});

test('file limit counts UTF-8 bytes and accepts exactly 32 MiB', () => {
  const base = JSON.stringify(documentFor());
  const exact = base + ' '.repeat(MAX_EXPERIMENT_BYTES - Buffer.byteLength(base));
  assert.deepEqual(parseExperiment(exact), initialSnapshot());
  assert.throws(() => parseExperiment(exact + ' '), /32 MiB/);
  assert.throws(() => parseExperiment(' '.repeat(MAX_EXPERIMENT_BYTES + 1)), /32 MiB/);
  // Unknown fields are ignored, but their bytes must still count before parsing.
  const unicode = '{"ignored":"' + '水'.repeat(Math.floor(MAX_EXPERIMENT_BYTES / 3)) + '"}';
  assert.ok(unicode.length < MAX_EXPERIMENT_BYTES);
  assert.ok(Buffer.byteLength(unicode) > MAX_EXPERIMENT_BYTES);
  assert.throws(() => parseExperiment(unicode), /32 MiB/);
});

test('serializer also enforces total JSON byte size even when individual budgets pass', () => {
  const saved = initialSnapshot();
  // Valid per-field and aggregate bounds, but indented points + escaped text exceed the file budget.
  const points = Array.from({ length: 20000 }, () => ({ x: 123.12345678901234, y: -123.12345678901234 }));
  saved.state.paths = Array(10).fill(points);
  saved.state.marks = Array.from({ length: 9990 }, () => ({ ...drawnMark('text'), text: '\u0000'.repeat(256), points: [] }));
  assert.throws(() => serializeExperiment(saved), /32 MiB/);
});

test('imports require static self-contained base64 PNGs, not URLs, SVGs or malformed sources', () => {
  for (const imported of [
    '', 'https://example.com/image.png', '//example.com/image.png', 'blob:local-image', 'file:///image.png',
    'data:image/svg+xml,<svg/>', 'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/jpeg;base64,' + PNG.slice(PNG_PREFIX.length),
    'data:image/png,raw', PNG_PREFIX, PNG_PREFIX + '!!!!', PNG_PREFIX + 'AAAA=',
    PNG_PREFIX + 'AAA=AAAA', PNG_PREFIX + 'A'.repeat(64), PNG_PREFIX + 'AAAA',
    null, 123, {},
  ]) {
    if (imported !== null) assertBadImport(imported);
  }
  const file = documentFor(editedSnapshot());
  file.snapshot.state.imported = null;
  assert.throws(() => parseDocument(file), /required for an imported shape/);
  assertBadImport(changedPng(bytes => { bytes[0] = 0; }), /PNG signature/);
  assertBadImport(changedPng(bytes => { bytes.writeUInt32BE(12, 8); }), /IHDR/);
  assertBadImport(changedPng(bytes => { bytes.write('FAKE', 12); }), /IHDR/);
  assertBadImport(changedPng(bytes => { bytes[24] = 3; }), /invalid PNG header/);
  assertBadImport(changedPng(bytes => { bytes[25] = 5; }), /invalid PNG header/);
  assertBadImport(changedPng(bytes => { bytes[26] = 1; }), /invalid PNG header/);
  assertBadImport(changedPng(bytes => { bytes[27] = 1; }), /invalid PNG header/);
  assertBadImport(changedPng(bytes => { bytes[28] = 2; }), /invalid PNG header/);
});

test('PNG dimensions are bounded to 1–2048 before decoding the complete base64 payload', () => {
  for (const offset of [16, 20]) {
    for (const size of [0, 2049, 16000, 0xffffffff]) {
      const imported = changedPng(bytes => { bytes.writeUInt32BE(size, offset); });
      const original = globalThis.atob, lengths = [];
      globalThis.atob = value => { lengths.push(value.length); return original(value); };
      try {
        assertBadImport(imported, /PNG (width|height).*between 1 and 2048/);
        assert.deepEqual(lengths, [44], 'only IHDR is decoded for rejected dimensions');
      } finally { globalThis.atob = original; }
    }
  }
  for (const size of [1, 1400, 2048]) {
    const file = documentFor();
    file.snapshot.state.imported = changedPng(bytes => {
      bytes.writeUInt32BE(size, 16);
      bytes.writeUInt32BE(size, 20);
      bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
    });
    assert.equal(parseDocument(file).state.imported, file.snapshot.state.imported);
  }
});

test('corrupt PNG headers, compressed pixels and checksums are rejected before restoration', () => {
  for (const offset of [16, 29, 41, 52, 64]) {
    assertBadImport(changedPng(bytes => { bytes[offset + 3] ^= 2; }), /corrupt PNG checksum/);
  }
  assertBadImport(changedPng(bytes => { bytes.fill(0, 41, 52); }), /corrupt PNG checksum/);
  const saved = editedSnapshot();
  assert.deepEqual(parseExperiment(serializeExperiment(saved)), saved);
});

test('truncated, animated and oversized PNG structures are rejected', () => {
  assertBadImport(dataUrl(pngBytes().subarray(0, 32)), /truncated PNG/);
  assertBadImport(dataUrl(pngBytes().subarray(0, -1)), /IEND/);
  assertBadImport(dataUrl(Buffer.concat([pngBytes(), Buffer.from([0])])), /PNG ending/);
  assertBadImport(changedPng(bytes => { bytes.writeUInt32BE(0xffffffff, 33); }), /truncated PNG chunk/);
  assertBadImport(changedPng(bytes => { bytes.write('tEXt', 37); }), /complete PNG image data/);
  for (const type of ['acTL', 'fcTL', 'fdAT', 'IHDR']) {
    assertBadImport(changedPng(bytes => { bytes.write(type, 37); }), /static PNG/);
  }
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
  pngBytes().copy(oversized);
  assertBadImport(dataUrl(oversized), /10 MiB PNG limit/);
  assertBadImport(PNG_PREFIX + 'A'.repeat(Math.ceil(10 * 1024 * 1024 / 3) * 4 + 4), /at most/);
});

test('malicious extra keys at all levels are discarded without prototype pollution', () => {
  const expected = editedSnapshot(), file = documentFor(expected);
  const targets = [file, file.snapshot, file.snapshot.state, file.snapshot.state.pigments[0],
    file.snapshot.state.marks[0], file.snapshot.state.marks[0].points[0], file.snapshot.state.paths[0][0],
    file.snapshot.state.drops[0], file.snapshot.state.dropPosition, file.snapshot.state.offset];
  for (const target of targets) {
    Object.defineProperty(target, '__proto__', { value: { experimentPolluted: true }, enumerable: true });
    target.constructor = { prototype: { experimentPolluted: true } };
    target.prototype = { experimentPolluted: true };
    target.futureSetting = { harmless: true };
  }
  const result = parseDocument(file);
  assert.deepEqual(result, expected);
  assert.equal(Object.prototype.experimentPolluted, undefined);
  assert.equal(({}).experimentPolluted, undefined);
  assert.equal(Object.hasOwn(result.state, '__proto__'), false);
  assert.equal(Object.hasOwn(result.state, 'constructor'), false);
  assert.equal(Object.getPrototypeOf(result.state), Object.prototype);
  assert.equal(Object.getPrototypeOf(result.state.marks[0]), Object.prototype);
  assert.deepEqual(parseExperiment(serializeExperiment(file.snapshot)), expected);
});
