import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { canvasToPrintPng, downloadBlob, setPngDpi } from './export.js';

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
  for (const options of [undefined, { dpi: 150 }]) {
    const result = await canvasToPrintPng(canvas, options);
    assert.ok(result instanceof Blob);
    assert.equal(result.type, 'image/png');
    const bytes = new Uint8Array(await result.arrayBuffer());
    assert.equal(physical(bytes).data.readUInt32BE(0), Math.round((options?.dpi ?? 300) / 0.0254));
    assert.deepEqual(parseChunks(bytes).find(({ type }) => type === 'IDAT').raw, idat);
  }
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
