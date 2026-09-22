import { INKS, PRESETS, MAX_PIGMENTS } from './presets.js';
import { MAX_DROPS, DROP_PLACEMENTS } from './artwork.js';
import { crc32 } from './export.js';

export const MAX_EXPERIMENT_BYTES = 32 * 1024 * 1024;

const FORMAT = 'chroma-experiment';
const VERSION = 1;
const BRUSHES = ['dot', 'line', 'circle', 'ring', 'arc', 'polygon', 'freehand', 'text'];
const SHAPES = [...BRUSHES, 'import', 'composition'];
const PLACEMENTS = [...DROP_PLACEMENTS.map(option => option.value), 'random', 'custom'];
const MAX_STROKES = 10000; // Marks and legacy paths share this budget.
const MAX_POINTS_PER_STROKE = 20000;
const MAX_TOTAL_POINTS = 200000;
const MAX_COORDINATE = 1000; // Local geometry can move and resize far outside the paper.
const MAX_MARK_SIZE = 100000;
// import.js prepares at most 1400 x 1400 RGBA pixels (<8 MiB before PNG encoding).
const MAX_PNG_BYTES = 10 * 1024 * 1024;
const PNG_PREFIX = 'data:image/png;base64,';

function invalid(path, message) {
  throw new Error(`Invalid experiment: ${path} ${message}.`);
}

function required(value, path) {
  if (value === undefined) invalid(path, 'is required');
}

function object(value, path) {
  required(value, path);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'must be an object');
  return value;
}

function number(value, path, min, max, integer = false) {
  required(value, path);
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path, 'must be a finite number');
  if (integer && !Number.isSafeInteger(value)) invalid(path, 'must be an integer');
  if (value < min || value > max) invalid(path, `must be between ${min} and ${max}`);
  return value;
}

function string(value, path, max) {
  required(value, path);
  if (typeof value !== 'string') invalid(path, 'must be a string');
  if (value.length > max) invalid(path, `must contain at most ${max} characters`);
  return value;
}

function boolean(value, path) {
  required(value, path);
  if (typeof value !== 'boolean') invalid(path, 'must be a boolean');
  return value;
}

function choice(value, path, options) {
  required(value, path);
  if (!options.includes(value)) invalid(path, `must be one of: ${options.join(', ')}`);
  return value;
}

function array(value, path, min, max) {
  required(value, path);
  if (!Array.isArray(value)) invalid(path, 'must be an array');
  if (value.length < min || value.length > max) invalid(path, `must contain ${min} to ${max} items`);
  return value;
}

function color(value, path) {
  string(value, path, 7);
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) invalid(path, 'must be a six-digit HEX color');
  return value;
}

function point(value, path, min = -MAX_COORDINATE, max = MAX_COORDINATE) {
  object(value, path);
  return { x: number(value.x, `${path}.x`, min, max), y: number(value.y, `${path}.y`, min, max) };
}

function pigment(value, path) {
  object(value, path);
  return {
    color: color(value.color, `${path}.color`),
    mobility: number(value.mobility, `${path}.mobility`, .05, 1.5),
    spread: number(value.spread, `${path}.spread`, .05, 1),
    opacity: number(value.opacity, `${path}.opacity`, 0, 1),
    saturation: number(value.saturation, `${path}.saturation`, 0, 1.5),
    direction: number(value.direction, `${path}.direction`, -180, 180),
  };
}

function points(value, path, budget) {
  array(value, path, 0, MAX_POINTS_PER_STROKE);
  budget.points += value.length;
  if (budget.points > MAX_TOTAL_POINTS) invalid('drawing', `exceeds the ${MAX_TOTAL_POINTS} total point limit`);
  return Array.from(value, (entry, index) => point(entry, `${path}[${index}]`));
}

function mark(value, path, budget) {
  object(value, path);
  const result = {
    type: choice(value.type, `${path}.type`, BRUSHES),
    ...point(value, path),
    endX: number(value.endX, `${path}.endX`, -MAX_COORDINATE, MAX_COORDINATE),
    endY: number(value.endY, `${path}.endY`, -MAX_COORDINATE, MAX_COORDINATE),
    radius: number(value.radius, `${path}.radius`, 0, MAX_COORDINATE),
    stroke: number(value.stroke, `${path}.stroke`, .000001, MAX_MARK_SIZE),
    size: number(value.size, `${path}.size`, .000001, MAX_MARK_SIZE),
    points: points(value.points, `${path}.points`, budget),
  };
  // Seeded marks have no text property; preserve that distinction on round trips.
  if (value.type === 'text' || Object.hasOwn(value, 'text')) result.text = string(value.text, `${path}.text`, 256);
  return result;
}

function importedPng(value) {
  const path = 'state.imported';
  if (value === null) return null;
  string(value, path, PNG_PREFIX.length + Math.ceil(MAX_PNG_BYTES / 3) * 4);
  if (!value.startsWith(PNG_PREFIX)) invalid(path, 'must be a self-contained base64 PNG data URL');
  const data = value.slice(PNG_PREFIX.length);
  if (!data.length || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) invalid(path, 'contains invalid PNG base64');
  const byteLength = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (byteLength > MAX_PNG_BYTES) invalid(path, 'exceeds the 10 MiB PNG limit');
  if (byteLength < 45) invalid(path, 'contains a truncated PNG');

  // Decode only the small IHDR first. Never create an Image/canvas at this boundary.
  const header = atob(data.slice(0, 44));
  const uint32 = (bytes, offset) => bytes.charCodeAt(offset) * 0x1000000
    + bytes.charCodeAt(offset + 1) * 0x10000 + bytes.charCodeAt(offset + 2) * 0x100 + bytes.charCodeAt(offset + 3);
  if (header.slice(0, 8) !== '\x89PNG\r\n\x1a\n' || uint32(header, 8) !== 13 || header.slice(12, 16) !== 'IHDR') {
    invalid(path, 'must contain a PNG signature and IHDR header');
  }
  number(uint32(header, 16), `${path} PNG width`, 1, 2048, true);
  number(uint32(header, 20), `${path} PNG height`, 1, 2048, true);
  const depth = header.charCodeAt(24), type = header.charCodeAt(25);
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[type]?.includes(depth) || header.charCodeAt(26) !== 0 || header.charCodeAt(27) !== 0 || header.charCodeAt(28) > 1) {
    invalid(path, 'contains an invalid PNG header');
  }

  // Animated PNGs need a separate frame budget; saved source canvases are static.
  const bytes = atob(data);
  let offset = 33, hasData = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = uint32(bytes, offset), type = bytes.slice(offset + 4, offset + 8);
    if (offset + length + 12 > bytes.length) invalid(path, 'contains a truncated PNG chunk');
    if (['acTL', 'fcTL', 'fdAT', 'IHDR'].includes(type)) invalid(path, 'must be a static PNG with one IHDR header');
    if (type === 'IDAT' && length > 0) hasData = true;
    offset += length + 12;
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length) invalid(path, 'contains an invalid PNG ending');
      ended = true;
      break;
    }
  }
  if (!hasData || !ended) invalid(path, 'must contain complete PNG image data and an IEND chunk');
  // Some browsers successfully decode corrupt image data as blank pixels.
  const buffer = Uint8Array.from(bytes, byte => byte.charCodeAt(0));
  for (let start = 8; start < bytes.length;) {
    const end = start + 8 + uint32(bytes, start);
    if (crc32(buffer.subarray(start + 4, end)) !== uint32(bytes, end)) invalid(path, 'contains a corrupt PNG checksum');
    start = end + 4;
  }
  return value;
}

function state(value) {
  object(value, 'state');
  const marks = array(value.marks, 'state.marks', 0, MAX_STROKES);
  const paths = array(value.paths, 'state.paths', 0, MAX_STROKES);
  if (marks.length + paths.length > MAX_STROKES) invalid('drawing', `exceeds the ${MAX_STROKES} total stroke limit`);
  const budget = { points: 0 };
  const result = {
    shape: choice(value.shape, 'state.shape', SHAPES),
    size: number(value.size, 'state.size', 1, 10000),
    stroke: number(value.stroke, 'state.stroke', .000001, 10000),
    ink: color(value.ink, 'state.ink'),
    inkIndex: number(value.inkIndex, 'state.inkIndex', -1, 1000000, true),
    pigments: Array.from(array(value.pigments, 'state.pigments', 1, MAX_PIGMENTS), (entry, index) => pigment(entry, `state.pigments[${index}]`)),
    mode: choice(value.mode, 'state.mode', ['radial', 'directional']),
    direction: number(value.direction, 'state.direction', 0, 360),
    amount: number(value.amount, 'state.amount', .1, 1.5),
    separation: number(value.separation, 'state.separation', 0, 1),
    fiber: number(value.fiber, 'state.fiber', 0, 1),
    grain: number(value.grain, 'state.grain', 0, 1),
    retention: number(value.retention, 'state.retention', 0, 1),
    progress: number(value.progress, 'state.progress', 0, 1.22),
    seed: number(value.seed, 'state.seed', 0, 0xffffffff, true),
    layers: Array.from(array(value.layers, 'state.layers', 3, 3), (entry, index) => boolean(entry, `state.layers[${index}]`)),
    drops: Array.from(array(value.drops, 'state.drops', 0, MAX_DROPS), (entry, index) => {
      const path = `state.drops[${index}]`;
      return { ...point(entry, path, 0, 1), age: number(entry.age, `${path}.age`, 0, 22) };
    }),
    dropPosition: point(value.dropPosition, 'state.dropPosition', 0, 1),
    dropPlacement: choice(value.dropPlacement, 'state.dropPlacement', PLACEMENTS),
    showDropMarkers: boolean(value.showDropMarkers, 'state.showDropMarkers'),
    text: string(value.text, 'state.text', 256),
    keepSource: boolean(value.keepSource, 'state.keepSource'),
    paths: Array.from(paths, (entry, index) => points(entry, `state.paths[${index}]`, budget)),
    imported: importedPng(value.imported),
    importName: string(value.importName, 'state.importName', 1024),
    importScale: number(value.importScale, 'state.importScale', .25, 2),
    randomness: number(value.randomness, 'state.randomness', 0, 2),
    speed: number(value.speed, 'state.speed', 0, 2),
    sourceRandomness: number(value.sourceRandomness, 'state.sourceRandomness', 0, 1),
    marks: Array.from(marks, (entry, index) => mark(entry, `state.marks[${index}]`, budget)),
    offset: point(value.offset, 'state.offset'),
    generated: boolean(value.generated, 'state.generated'),
  };
  if (result.shape === 'import' && result.imported === null) invalid('state.imported', 'is required for an imported shape');
  return result;
}

function snapshot(value) {
  object(value, 'snapshot');
  return {
    state: state(value.state),
    tool: choice(value.tool, 'snapshot.tool', ['water', 'draw', 'stamp', 'move']),
    brushShape: choice(value.brushShape, 'snapshot.brushShape', BRUSHES),
    inputMode: choice(value.inputMode, 'snapshot.inputMode', ['draw', 'import']),
    selectedPreset: number(value.selectedPreset, 'snapshot.selectedPreset', -1, 1000000, true),
    elapsed: number(value.elapsed, 'snapshot.elapsed', 0, 31536000),
    hasBloomed: boolean(value.hasBloomed, 'snapshot.hasBloomed'),
    animationMode: choice(value.animationMode, 'snapshot.animationMode', ['bloom', 'water']),
  };
}

function checkSize(text) {
  if (typeof text !== 'string') invalid('file', 'must be JSON text');
  if (text.length > MAX_EXPERIMENT_BYTES || new TextEncoder().encode(text).byteLength > MAX_EXPERIMENT_BYTES) {
    invalid('file', 'exceeds the 32 MiB size limit');
  }
}

/** Save only the visible, editable snapshot; no animation target or history is retained. */
export function serializeExperiment(value) {
  const saved = snapshot(value);
  const text = JSON.stringify({
    format: FORMAT,
    version: VERSION,
    paletteName: INKS[saved.state.inkIndex]?.name ?? null,
    presetName: PRESETS[saved.selectedPreset]?.name ?? null,
    snapshot: saved,
  }, null, 2);
  checkSize(text);
  return text;
}

/** Validate untrusted JSON and return a fresh, whitelisted snapshot ready for restoration. */
export function parseExperiment(text) {
  checkSize(text);
  let file;
  try { file = JSON.parse(text); }
  catch { invalid('file', 'is not valid JSON'); }
  object(file, 'file');
  required(file.format, 'format');
  if (file.format !== FORMAT) invalid('format', `must be "${FORMAT}"`);
  required(file.version, 'version');
  if (file.version !== VERSION) invalid('version', 'is unsupported (expected version 1)');
  for (const key of ['paletteName', 'presetName']) {
    if (file[key] !== null) string(file[key], key, 256);
  }
  const saved = snapshot(file.snapshot);
  // Indices are historical hints only. Never replace stored ink/pigments with palette defaults.
  saved.state.inkIndex = INKS.findIndex(ink => ink.name === file.paletteName);
  saved.selectedPreset = PRESETS.findIndex(preset => preset.name === file.presetName);
  return saved;
}
