import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  canvasToPrintPng, downloadBlob, recordCanvasVideo, setPngDpi, supportsVideoExport, PNG_SIZE, PNG_DPI,
} from './export.js';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const scanline = Buffer.from([0, 23, 45, 67, 255]);

// Independent table-based CRC implementation for constructing and checking chunks.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function checksum(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 4, 'ascii');
  result.set(data, 8);
  result.writeUInt32BE(checksum(result.subarray(4, result.length - 4)), result.length - 4);
  return result;
}

const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0);
header.writeUInt32BE(1, 4);
header[8] = 8;
header[9] = 6; // 8-bit RGBA.
const ihdr = chunk('IHDR', header);
const idat = chunk('IDAT', deflateSync(scanline));
const iend = chunk('IEND');
const png = Buffer.concat([signature, ihdr, idat, iend]);

function parseChunks(bytes) {
  const data = Buffer.from(bytes);
  const result = [];
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset);
    const end = offset + length + 12;
    result.push({
      type: data.toString('ascii', offset + 4, offset + 8),
      data: data.subarray(offset + 8, end - 4),
      crc: data.readUInt32BE(end - 4),
      raw: data.subarray(offset, end),
    });
    offset = end;
  }
  return result;
}

function physical(bytes) {
  return parseChunks(bytes).find(({ type }) => type === 'pHYs');
}

test('rejects missing, truncated, and incorrect PNG signatures', () => {
  for (const bytes of [new Uint8Array(), signature.subarray(0, 7), Buffer.alloc(8)]) {
    assert.throws(() => setPngDpi(bytes, 300), /PNG signature/);
  }
  const bad = Buffer.from(png);
  bad[0] = 0;
  assert.throws(() => setPngDpi(bad, 300), /PNG signature/);
  assert.throws(() => setPngDpi(png.buffer, 300), TypeError);
});

test('writes a valid big-endian pHYs chunk: 300 DPI is 11811 pixels per meter', () => {
  assert.equal(checksum(Buffer.from('123456789')), 0xcbf43926);
  const result = setPngDpi(png, 300);
  assert.ok(result instanceof Uint8Array);
  assert.deepEqual(Buffer.from(result.subarray(0, 8)), signature);
  const chunks = parseChunks(result);
  assert.deepEqual(chunks.map(({ type }) => type), ['IHDR', 'pHYs', 'IDAT', 'IEND']);
  const metadata = chunks[1];
  assert.equal(metadata.raw.readUInt32BE(0), 9);
  assert.equal(metadata.data.readUInt32BE(0), 11811);
  assert.equal(metadata.data.readUInt32BE(4), 11811);
  assert.equal(metadata.data[8], 1);
  assert.deepEqual([...metadata.data], [0, 0, 46, 35, 0, 0, 46, 35, 1]);
  assert.equal(metadata.crc, checksum(metadata.raw.subarray(4, -4)));
});

test('replaces all duplicate pHYs chunks and preserves other chunks byte for byte', () => {
  const oldMetadata = Buffer.alloc(9);
  oldMetadata.writeUInt32BE(100, 0);
  oldMetadata.writeUInt32BE(200, 4);
  const text = chunk('tEXt', Buffer.from('Title\0Print example'));
  const compressed = idat.subarray(8, -4);
  const firstIdat = chunk('IDAT', compressed.subarray(0, 4));
  const secondIdat = chunk('IDAT', compressed.subarray(4));
  const input = Buffer.concat([
    signature, ihdr, chunk('pHYs', oldMetadata), text,
    chunk('pHYs', oldMetadata), firstIdat, secondIdat,
    chunk('pHYs', oldMetadata), iend,
  ]);
  const original = Buffer.from(input);
  const result = setPngDpi(input, 300);
  const chunks = parseChunks(result);
  assert.equal(chunks.filter(({ type }) => type === 'pHYs').length, 1);
  assert.equal(chunks[1].type, 'pHYs');
  assert.equal(physical(result).data.readUInt32BE(0), 11811);
  assert.deepEqual(
    chunks.filter(({ type }) => type !== 'pHYs').map(({ raw }) => raw),
    parseChunks(input).filter(({ type }) => type !== 'pHYs').map(({ raw }) => raw),
  );
  assert.deepEqual(input, original, 'input must not be mutated');
  const imageData = Buffer.concat(chunks.filter(({ type }) => type === 'IDAT').map(({ data }) => data));
  assert.deepEqual(inflateSync(imageData), scanline);
  assert.deepEqual(setPngDpi(result, 300), result, 'setting the same DPI is idempotent');
});

test('supports typed-array views and fractional DPI without changing source bytes', () => {
  const storage = new Uint8Array(png.length + 10);
  storage.set(png, 5);
  const original = storage.slice();
  const result = setPngDpi(storage.subarray(5, 5 + png.length), 72.5);
  assert.equal(physical(result).data.readUInt32BE(0), Math.round(72.5 / 0.0254));
  assert.deepEqual(storage, original);
});

test('rejects invalid or unrepresentable DPI', () => {
  for (const dpi of [0, -1, NaN, Infinity, -Infinity, '300', null, undefined, 0.0001, 1e20]) {
    assert.throws(() => setPngDpi(png, dpi), RangeError);
  }
});

test('safely rejects truncated chunks, oversized lengths, and missing IEND', () => {
  for (let length = 8; length < png.length; length += 1) {
    assert.throws(() => setPngDpi(png.subarray(0, length), 300), /PNG/);
  }
  for (const length of [0xffffffff, 0x80000000, 0x7fffffff, png.length]) {
    const invalid = Buffer.from(png);
    invalid.writeUInt32BE(length, 8);
    assert.throws(() => setPngDpi(invalid, 300), /PNG chunk length/);
  }
  assert.throws(() => setPngDpi(Buffer.concat([signature, idat, iend]), 300), /IHDR/);
  assert.throws(() => setPngDpi(Buffer.concat([signature, ihdr, ihdr, idat, iend]), 300), /IHDR/);
  assert.throws(() => setPngDpi(Buffer.concat([png, Buffer.of(0)]), 300), /trailing data/);
  assert.throws(() => setPngDpi(Buffer.concat([signature, ihdr, idat, chunk('IEND', Buffer.of(0))]), 300), /IEND/);
});

test('canvasToPrintPng returns a PNG Blob with default or custom DPI', async () => {
  const canvas = {
    toBlob(callback, type) {
      assert.equal(type, 'image/png');
      callback(new Blob([png], { type }));
    },
  };
  for (const options of [undefined, { dpi: 150 }, { dpi: 500 }]) {
    const result = await canvasToPrintPng(canvas, options);
    assert.ok(result instanceof Blob);
    assert.equal(result.type, 'image/png');
    const bytes = new Uint8Array(await result.arrayBuffer());
    assert.equal(physical(bytes).data.readUInt32BE(0), Math.round((options?.dpi ?? 500) / 0.0254));
    assert.deepEqual(parseChunks(bytes).find(({ type }) => type === 'IDAT').raw, idat);
  }
});

test('print export uses 4000 square pixels and valid 500 DPI metadata', () => {
  assert.equal(PNG_SIZE,4000);
  assert.equal(PNG_DPI,500);
  const result=setPngDpi(png,PNG_DPI), metadata=physical(result);
  assert.equal(metadata.data.readUInt32BE(0),19685);
  assert.equal(metadata.data.readUInt32BE(4),19685);
  assert.equal(metadata.data[8],1);
  assert.equal(metadata.crc,checksum(metadata.raw.subarray(4,-4)));
  assert.deepEqual(parseChunks(result).find(({type})=>type==='IDAT').raw,idat);
});

test('canvasToPrintPng rejects failed encoding and propagates canvas errors', async () => {
  await assert.rejects(canvasToPrintPng({ toBlob: (callback) => callback(null) }), /encoding failed/);
  const error = new Error('Canvas is tainted');
  await assert.rejects(canvasToPrintPng({ toBlob() { throw error; } }), (actual) => actual === error);
});

test('downloadBlob clicks and removes its anchor, then revokes the URL after a delay', (t) => {
  const events = [];
  const anchor = {
    click() { events.push('click'); },
    remove() { events.push('remove'); },
  };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement(tag) { assert.equal(tag, 'a'); return anchor; },
      body: { appendChild(element) { assert.equal(element, anchor); events.push('append'); } },
    },
  });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });
  const blob = new Blob([png], { type: 'image/png' });
  t.mock.method(URL, 'createObjectURL', (value) => {
    assert.equal(value, blob);
    return 'blob:test-png';
  });
  t.mock.method(URL, 'revokeObjectURL', (url) => {
    assert.equal(url, 'blob:test-png');
    events.push('revoke');
  });
  let release;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.ok(delay > 0);
    release = callback;
  });
  downloadBlob(blob, 'print.png');
  assert.equal(anchor.href, 'blob:test-png');
  assert.equal(anchor.download, 'print.png');
  assert.equal(anchor.hidden, true);
  assert.deepEqual(events, ['append', 'click', 'remove']);
  release();
  assert.deepEqual(events, ['append', 'click', 'remove', 'revoke']);
});

const videoTypes = [
  'video/mp4;codecs=avc1.640032',
  'video/mp4;codecs=h264',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
];

function mockVideo(t, settings = {}) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const recorders = [];
  const captureRates = [];
  const probes = [];
  const tracks = Array.from({ length: 2 }, () => ({
    stops: 0,
    requests: 0,
    stop() { this.stops += 1; },
    requestFrame() { this.requests += 1; },
  }));
  const stream = { getTracks: () => tracks, getVideoTracks: () => tracks };

  class FakeCanvas {
    captureStream(fps) {
      captureRates.push(fps);
      if (settings.captureError) throw settings.captureError;
      return stream;
    }
  }
  class FakeRecorder extends EventTarget {
    static isTypeSupported(type) {
      probes.push(type);
      return (settings.types ?? videoTypes).includes(type);
    }
    constructor(value, options) {
      super();
      assert.equal(value, stream);
      if (settings.constructorError) throw settings.constructorError;
      this.options = options;
      this.mimeType = options.mimeType;
      this.state = 'inactive';
      this.stopCalls = 0;
      recorders.push(this);
    }
    start() {
      if (settings.startError) throw settings.startError;
      this.state = 'recording';
    }
    emit(type, properties = {}) {
      this.dispatchEvent(Object.assign(new Event(type), properties));
    }
    stop() {
      this.stopCalls += 1;
      if (settings.stopError) throw settings.stopError;
      this.state = 'inactive';
      if (settings.noStopEvent) return;
      queueMicrotask(() => {
        this.emit('dataavailable', { data: new Blob([settings.data ?? 'video']) });
        this.emit('stop');
      });
    }
  }

  for (const [name, value] of Object.entries({ MediaRecorder: FakeRecorder, HTMLCanvasElement: FakeCanvas })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + delay });
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', (id) => timers.delete(id));

  async function flush() {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  }
  async function advance(ms) {
    const target = now + ms;
    await flush();
    let iterations = 0;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      assert.ok(++iterations < 1000, 'recording must not spin in a tight timer loop');
      const [id, timer] = next;
      timers.delete(id);
      now = timer.at;
      timer.callback();
      await flush();
    }
    now = target;
    await flush();
  }
  function assertClean(signal, expectedStops = 1) {
    assert.equal(timers.size, 0, 'all timers must be cleared');
    for (const track of tracks) assert.equal(track.stops, expectedStops);
    for (const recorder of recorders) {
      for (const event of ['dataavailable', 'error', 'stop']) {
        assert.equal(getEventListeners(recorder, event).length, 0, `${event} listener leaked`);
      }
    }
    if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0);
  }
  const canvas = Object.freeze(Object.assign(new FakeCanvas(), { width: 1920, height: 1920 }));
  return { canvas, tracks, recorders, captureRates, probes, timers, advance, flush, assertClean };
}

test('supportsVideoExport checks both canvas capture and recorder codec support', (t) => {
  const env = mockVideo(t);
  assert.equal(supportsVideoExport(), true);
  assert.deepEqual(env.probes, [videoTypes[0]]);
  const Canvas = globalThis.HTMLCanvasElement;
  const Recorder = globalThis.MediaRecorder;
  globalThis.HTMLCanvasElement = undefined;
  assert.equal(supportsVideoExport(), false);
  globalThis.HTMLCanvasElement = class {};
  assert.equal(supportsVideoExport(), false);
  globalThis.HTMLCanvasElement = Canvas;
  globalThis.MediaRecorder = undefined;
  assert.equal(supportsVideoExport(), false);
  globalThis.MediaRecorder = class {};
  assert.equal(supportsVideoExport(), false);
  globalThis.MediaRecorder = Recorder;
  t.mock.method(Recorder, 'isTypeSupported', () => { throw new Error('Codec probe failed'); });
  assert.equal(supportsVideoExport(), false);
  env.assertClean(undefined, 0);
});

test('recordCanvasVideo prefers H.264 MP4, then VP9, then VP8 with matching extensions', async (t) => {
  for (const [index, mimeType] of videoTypes.entries()) {
    await t.test(mimeType, async (t) => {
      const env = mockVideo(t, { types: videoTypes.slice(index) });
      const result = recordCanvasVideo({ canvas: env.canvas, renderFrame() {}, duration: 0.08 });
      await env.advance(80);
      const { blob, extension } = await result;
      assert.equal(blob.type, mimeType.toLowerCase());
      assert.equal(extension, index < 2 ? 'mp4' : 'webm');
      assert.equal(await blob.text(), 'video');
      assert.deepEqual(env.probes, videoTypes.slice(0, index + 1));
      assert.equal(env.recorders[0].options.mimeType, mimeType);
      env.assertClean();
    });
  }
});

test('default recording is paced over five seconds at 25 fps and includes both endpoints', async (t) => {
  const env = mockVideo(t);
  const frames = [];
  const progress = [];
  const controller = new AbortController();
  const result = recordCanvasVideo({
    canvas: env.canvas,
    renderFrame: (value) => frames.push({ value, at: performance.now() }),
    onProgress: (value) => progress.push(value),
    signal: controller.signal,
  });
  await env.flush();
  assert.deepEqual(frames, [{ value: 0, at: 0 }]);
  assert.deepEqual(env.captureRates, [25]);
  assert.deepEqual(env.recorders[0].options, { mimeType: videoTypes[0], videoBitsPerSecond: 12_000_000 });
  await env.advance(39);
  assert.equal(frames.length, 1, 'frames must not render in a synchronous loop');
  await env.advance(4921);
  assert.equal(frames.length, 125);
  assert.deepEqual(frames.at(-1), { value: 1, at: 4960 });
  assert.deepEqual(progress, frames.map(({ value }) => value));
  assert.ok(progress.every((value, index) => value >= 0 && value <= 1 && (!index || value > progress[index - 1])));
  assert.equal(env.recorders[0].stopCalls, 0, 'final frame must remain available for capture');
  await env.advance(40);
  assert.ok((await result).blob.size > 0);
  assert.equal(env.recorders[0].stopCalls, 1);
  assert.equal(env.tracks[0].requests, 125);
  assert.equal(env.canvas.width, 1920);
  assert.equal(env.canvas.height, 1920);
  env.assertClean(controller.signal);
});

test('custom duration and fps are respected and chunks are combined', async (t) => {
  const env = mockVideo(t, { types: [videoTypes[3]] });
  const frames = [];
  const result = recordCanvasVideo({ canvas: env.canvas, renderFrame: (p) => frames.push(p), duration: 0.2, fps: 10 });
  env.recorders[0].emit('dataavailable', { data: new Blob([]) });
  env.recorders[0].emit('dataavailable', { data: new Blob(['first-']) });
  await env.advance(200);
  assert.equal(await (await result).blob.text(), 'first-video');
  assert.deepEqual(env.captureRates, [10]);
  assert.deepEqual(frames, [0, 1]);
  env.assertClean();
});

test('slow asynchronous rendering skips missed deadlines without overlapping frames', async (t) => {
  const env = mockVideo(t);
  for (const track of env.tracks) delete track.requestFrame;
  const frames = [];
  let release;
  const result = recordCanvasVideo({
    canvas: env.canvas,
    duration: 0.24,
    renderFrame(p) {
      frames.push({ p, at: performance.now() });
      if (p === 0) return new Promise((resolve) => { release = resolve; });
    },
  });
  await env.advance(100);
  assert.deepEqual(frames, [{ p: 0, at: 0 }]);
  release();
  await env.advance(140);
  assert.deepEqual(frames, [{ p: 0, at: 0 }, { p: 0.6, at: 120 }, { p: 0.8, at: 160 }, { p: 1, at: 200 }]);
  assert.ok((await result).blob.size > 0);
  env.assertClean();
});

test('the recording deadline stops capture before a pending render is released', async (t) => {
  for (const pendingProgress of [0, 0.5, 1]) {
    await t.test(`pending frame at ${pendingProgress}`, async (t) => {
      // Delay finalization so late render completion exercises stopping, not just settled.
      const env = mockVideo(t, { noStopEvent: true });
      const controller = new AbortController();
      const frames = [];
      const progress = [];
      let release;
      const result = recordCanvasVideo({
        canvas: env.canvas,
        duration: 0.12,
        signal: controller.signal,
        renderFrame(p) {
          frames.push(p);
          if (p === pendingProgress) return new Promise((resolve) => { release = resolve; });
        },
        onProgress: (p) => progress.push(p),
      });
      await env.advance(119);
      assert.equal(typeof release, 'function', 'the selected render must still be pending');
      assert.equal(frames.at(-1), pendingProgress);
      assert.equal(env.recorders[0].stopCalls, 0);
      const framesBeforeStop = [...frames];
      const progressBeforeStop = [...progress];
      const requestsBeforeStop = env.tracks.map((track) => track.requests);

      await env.advance(1);
      assert.equal(env.recorders[0].stopCalls, 1, 'stop must not wait for the pending render');
      assert.equal(env.recorders[0].state, 'inactive');
      assert.equal(env.timers.size, 1, 'only the finalization watchdog should remain');
      const watchdog = [...env.timers];

      release();
      await env.advance(120);
      assert.deepEqual(frames, framesBeforeStop, 'no rendering after stopping');
      assert.deepEqual(progress, progressBeforeStop, 'no progress after stopping');
      assert.deepEqual(env.tracks.map((track) => track.requests), requestsBeforeStop);
      assert.equal(env.recorders[0].stopCalls, 1, 'late completion must not stop twice');
      assert.deepEqual([...env.timers], watchdog, 'late completion must not schedule or replace timers');

      env.recorders[0].emit('dataavailable', { data: new Blob(['video']) });
      env.recorders[0].emit('stop');
      assert.ok((await result).blob.size > 0);
      env.assertClean(controller.signal);
    });
  }
});

test('unsupported codecs or canvas APIs reject before allocating resources', async (t) => {
  const env = mockVideo(t, { types: [] });
  assert.equal(supportsVideoExport(), false);
  await assert.rejects(recordCanvasVideo({ canvas: env.canvas, renderFrame() {} }), /not supported.*H\.264.*WebM/);
  await assert.rejects(recordCanvasVideo({ canvas: {}, renderFrame() {} }), /captureStream/);
  assert.deepEqual(env.captureRates, []);
  env.assertClean(undefined, 0);
});

test('invalid recording arguments reject without starting capture', async (t) => {
  const env = mockVideo(t);
  for (const key of ['duration', 'fps']) {
    for (const value of [0, -1, NaN, Infinity, '5', null]) {
      await assert.rejects(recordCanvasVideo({ canvas: env.canvas, renderFrame() {}, [key]: value }), RangeError);
    }
  }
  await assert.rejects(recordCanvasVideo({ canvas: env.canvas }), TypeError);
  assert.deepEqual(env.captureRates, []);
  env.assertClean(undefined, 0);
});

test('empty recordings are rejected and cleaned up', async (t) => {
  const env = mockVideo(t, { data: '' });
  const rejected = assert.rejects(recordCanvasVideo({ canvas: env.canvas, renderFrame() {}, duration: 0.08 }), /empty file/);
  await env.advance(80);
  await rejected;
  env.assertClean();
});

test('render and progress exceptions release timers, recorder, tracks, and abort listeners', async (t) => {
  for (const stage of ['initial', 'later', 'final', 'async', 'progress']) {
    await t.test(stage, async (t) => {
      const env = mockVideo(t);
      const controller = new AbortController();
      const error = new Error(`${stage} failed`);
      const rejected = assert.rejects(recordCanvasVideo({
        canvas: env.canvas,
        duration: 0.12,
        signal: controller.signal,
        renderFrame(p) {
          if (stage === 'initial' || (stage === 'later' && p > 0) || (stage === 'final' && p === 1)) throw error;
          if (stage === 'async') return Promise.reject(error);
        },
        onProgress() { if (stage === 'progress') throw error; },
      }), (actual) => actual === error);
      await env.advance(120);
      await rejected;
      assert.equal(env.recorders[0].stopCalls, 1);
      env.assertClean(controller.signal);
    });
  }
});

test('capture, constructor, start, and stop errors do not leave resources or pending waits', async (t) => {
  for (const stage of ['captureError', 'constructorError', 'startError', 'stopError']) {
    await t.test(stage, async (t) => {
      const error = new Error(stage);
      const env = mockVideo(t, { [stage]: error });
      const controller = new AbortController();
      const rejected = assert.rejects(recordCanvasVideo({
        canvas: env.canvas, renderFrame() {}, duration: 0.08, signal: controller.signal,
      }), (actual) => actual === error);
      await env.advance(80);
      await rejected;
      env.assertClean(controller.signal, stage === 'captureError' ? 0 : 1);
    });
  }
});

test('recorder errors reject immediately without waiting for a stop event', async (t) => {
  const env = mockVideo(t, { noStopEvent: true });
  const controller = new AbortController();
  const error = new Error('Encoder failed');
  const rejected = assert.rejects(recordCanvasVideo({
    canvas: env.canvas, renderFrame() {}, signal: controller.signal,
  }), (actual) => actual === error);
  await env.flush();
  env.recorders[0].emit('error', { error });
  await rejected;
  assert.equal(env.recorders[0].stopCalls, 1);
  env.assertClean(controller.signal);
});

test('already-aborted signals reject without creating a stream or recorder', async (t) => {
  const env = mockVideo(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(recordCanvasVideo({
    canvas: env.canvas, renderFrame() { assert.fail('must not render'); }, signal: controller.signal,
  }), { name: 'AbortError' });
  assert.equal(env.captureRates.length, 0);
  assert.equal(env.recorders.length, 0);
  env.assertClean(controller.signal, 0);
});

test('cancelling a paced recording rejects with the abort reason and stops further rendering', async (t) => {
  const env = mockVideo(t, { noStopEvent: true });
  const controller = new AbortController();
  const reason = new Error('Cancelled by caller');
  const frames = [];
  const rejected = assert.rejects(recordCanvasVideo({
    canvas: env.canvas, renderFrame: (p) => frames.push(p), signal: controller.signal,
  }), (actual) => actual === reason);
  await env.advance(80);
  controller.abort(reason);
  await rejected;
  const count = frames.length;
  await env.advance(10000);
  assert.equal(frames.length, count);
  assert.equal(env.recorders[0].stopCalls, 1);
  env.assertClean(controller.signal);
});

test('cancellation during an awaited render cleans immediately and cannot schedule more frames', async (t) => {
  const env = mockVideo(t);
  const controller = new AbortController();
  let release;
  const rejected = assert.rejects(recordCanvasVideo({
    canvas: env.canvas,
    renderFrame: () => new Promise((resolve) => { release = resolve; }),
    onProgress() { assert.fail('must not report progress after cancellation'); },
    signal: controller.signal,
  }), { name: 'AbortError' });
  controller.abort();
  await rejected;
  env.assertClean(controller.signal);
  release();
  await env.advance(10000);
  env.assertClean(controller.signal);
});

test('cancellation also clears the finalization watchdog', async (t) => {
  const env = mockVideo(t, { noStopEvent: true });
  const controller = new AbortController();
  const rejected = assert.rejects(recordCanvasVideo({
    canvas: env.canvas, renderFrame() {}, duration: 0.08, signal: controller.signal,
  }), { name: 'AbortError' });
  await env.advance(80);
  assert.equal(env.recorders[0].state, 'inactive');
  assert.equal(env.timers.size, 1);
  controller.abort();
  await rejected;
  env.assertClean(controller.signal);
});

test('missing recorder stop events time out rather than leaving an unresolved export', async (t) => {
  const env = mockVideo(t, { noStopEvent: true });
  const rejected = assert.rejects(recordCanvasVideo({
    canvas: env.canvas, renderFrame() {}, duration: 0.08,
  }), /did not finish in time/);
  await env.advance(5080);
  await rejected;
  env.assertClean();
});

test('unexpected recorder stop rejects rather than returning a truncated video', async (t) => {
  const env = mockVideo(t);
  const rejected = assert.rejects(recordCanvasVideo({ canvas: env.canvas, renderFrame() {} }), /before completion/);
  await env.flush();
  env.recorders[0].stop();
  await rejected;
  env.assertClean();
});

test('failure to stop one track does not prevent cleanup of other tracks', async (t) => {
  const env = mockVideo(t);
  env.tracks[0].stop = function stop() { this.stops += 1; throw new Error('Track stop failed'); };
  const result = recordCanvasVideo({ canvas: env.canvas, renderFrame() {}, duration: 0.08 });
  await env.advance(80);
  assert.ok((await result).blob.size > 0);
  env.assertClean();
});
