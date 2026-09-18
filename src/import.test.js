import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareImportedImage, prepareImportedPixels } from './import.js';

function raster(width, height, color = [255, 255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(color, offset);
  return { data, width, height };
}

function rectangle(image, left, top, width, height, color) {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) image.data.set(color, (y * image.width + x) * 4);
  }
}

function pixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return [...image.data.subarray(offset, offset + 4)];
}

function assertMask({ source, mask }) {
  assert.equal(source.width, mask.width);
  assert.equal(source.height, mask.height);
  assert.equal(source.data.length, source.width * source.height * 4);
  assert.equal(mask.data.length, source.data.length);
  for (let offset = 0; offset < source.data.length; offset += 4) {
    assert.equal(mask.data[offset], 0);
    assert.equal(mask.data[offset + 1], 0);
    assert.equal(mask.data[offset + 2], 0);
    assert.equal(mask.data[offset + 3], source.data[offset + 3]);
  }
}

test('decoded transparent PNG pixels retain original RGB and every native alpha value', () => {
  const image = raster(80, 60, [250, 150, 77, 0]);
  rectangle(image, 25, 20, 20, 10, [31, 105, 181, 128]);
  for (const [index, alpha] of [1, 64, 128, 255, 0].entries()) {
    rectangle(image, 25 + index, 20, 1, 1, [255, 255, 255, alpha]);
  }
  const original = image.data.slice();
  const result = prepareImportedPixels(image);
  assert.equal(result.source.width, 28);
  assert.equal(result.source.height, 18);
  for (let y = 0; y < result.source.height; y += 1) {
    for (let x = 0; x < result.source.width; x += 1) {
      assert.deepEqual(pixel(result.source, x, y), pixel(image, x + 21, y + 16));
    }
  }
  assert.deepEqual(image.data, original, 'the input buffer is not modified');
  assert.notEqual(result.source.data, image.data);
  assertMask(result);
});

test('transparent cutouts touching every corner are not mistaken for a solid background', () => {
  const image = raster(30, 20, [20, 40, 60, 255]);
  rectangle(image, 8, 6, 14, 8, [0, 0, 0, 0]);
  const result = prepareImportedPixels(image);
  assert.deepEqual(result.source, image);
  assertMask(result);
});

test('white background is removed without changing foreground RGB or boosting native alpha', () => {
  const image = raster(100, 80);
  rectangle(image, 40, 30, 20, 10, [32, 55, 98, 255]);
  rectangle(image, 40, 30, 1, 1, [0, 0, 0, 96]);
  rectangle(image, 41, 30, 1, 1, [230, 230, 230, 255]);
  const result = prepareImportedPixels(image);
  assert.equal(result.source.width, 28);
  assert.equal(result.source.height, 18);
  assert.deepEqual(pixel(result.source, 0, 0), [255, 255, 255, 0]);
  assert.deepEqual(pixel(result.source, 4, 4), [0, 0, 0, 96]);
  const softEdge = pixel(result.source, 5, 4);
  assert.deepEqual(softEdge.slice(0, 3), [230, 230, 230]);
  assert.ok(softEdge[3] > 0 && softEdge[3] < 255);
  assert.deepEqual(pixel(result.source, 6, 4), [32, 55, 98, 255]);
  assertMask(result);
});

test('a white mark on a dark background produces an opaque black alpha-only mask', () => {
  const image = raster(100, 80, [8, 12, 20, 255]);
  rectangle(image, 40, 30, 20, 10, [255, 255, 255, 255]);
  const result = prepareImportedPixels(image);
  assert.equal(result.source.width, 28);
  assert.equal(result.source.height, 18);
  assert.deepEqual(pixel(result.source, 0, 0), [8, 12, 20, 0]);
  assert.deepEqual(pixel(result.source, 4, 4), [255, 255, 255, 255]);
  assert.deepEqual(pixel(result.mask, 4, 4), [0, 0, 0, 255]);
  assertMask(result);
});

test('color contrast still extracts marks with nearly identical background luminance', () => {
  const image = raster(50, 50, [255, 0, 0, 255]);
  rectangle(image, 20, 20, 10, 10, [0, 76, 0, 255]);
  const result = prepareImportedPixels(image);
  assert.deepEqual(pixel(result.source, 0, 0), [255, 0, 0, 0]);
  assert.deepEqual(pixel(result.source, 4, 4), [0, 76, 0, 255]);
  assertMask(result);
});

test('three dominant corners resist one contaminated corner without erasing it', () => {
  const image = raster(100, 80);
  rectangle(image, 0, 0, 4, 4, [30, 50, 70, 255]);
  rectangle(image, 40, 30, 20, 10, [90, 40, 150, 255]);
  const result = prepareImportedPixels(image);
  assert.equal(result.source.width, 65); // 60px foreground span + round(60 * 8%).
  assert.equal(result.source.height, 45);
  assert.deepEqual(pixel(result.source, 20, 20), [255, 255, 255, 0]);
  assert.deepEqual(pixel(result.source, 40, 30), [90, 40, 150, 255]);
  assert.deepEqual(pixel(result.source, 0, 0), [30, 50, 70, 255]);
  assertMask(result);
});

test('minor corner noise does not turn the background into a foreground rectangle', () => {
  const image = raster(100, 100, [248, 248, 248, 255]);
  for (const [left, top] of [[0, 0], [96, 0], [0, 96], [96, 96]]) {
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const gray = [245, 248, 251][(x + y) % 3];
        rectangle(image, left + x, top + y, 1, 1, [gray, gray, gray, 255]);
      }
    }
  }
  assert.throws(() => prepareImportedPixels(image), /No foreground.*visible mark/);
  rectangle(image, 40, 40, 20, 10, [10, 20, 30, 255]);
  const result = prepareImportedPixels(image);
  assert.equal(result.source.width, 28);
  assert.equal(result.source.height, 18);
  assertMask(result);
});

test('nonuniform backgrounds conservatively retain all original pixels', () => {
  const gradient = raster(80, 60);
  for (let x = 0; x < gradient.width; x += 1) {
    const gray = Math.round(80 + x * 140 / (gradient.width - 1));
    rectangle(gradient, x, 0, 1, gradient.height, [gray, gray, gray, 255]);
  }
  rectangle(gradient, 30, 20, 20, 20, [220, 220, 220, 180]);
  const split = raster(80, 60);
  rectangle(split, 0, 0, 40, 60, [0, 0, 0, 255]);
  for (const image of [gradient, split]) {
    const result = prepareImportedPixels(image);
    assert.deepEqual(result.source, image);
    assertMask(result);
  }
});

test('matching corners with a nonuniform perimeter trigger preservation, not extraction', () => {
  const image = raster(80, 60, [120, 160, 190, 255]);
  for (const [left, top] of [[0, 0], [76, 0], [0, 56], [76, 56]]) {
    rectangle(image, left, top, 4, 4, [255, 255, 255, 255]);
  }
  rectangle(image, 30, 20, 20, 20, [255, 255, 255, 255]);
  const result = prepareImportedPixels(image);
  assert.deepEqual(result.source, image, 'white foreground must survive unreliable background estimation');
  assertMask(result);
});

test('auto-crop adds 8% longest-side padding, clamped independently at image edges', () => {
  const centered = raster(180, 80, [0, 0, 0, 0]);
  rectangle(centered, 30, 20, 100, 20, [10, 80, 220, 255]);
  const result = prepareImportedPixels(centered);
  assert.equal(result.source.width, 116);
  assert.equal(result.source.height, 36);
  assert.deepEqual(pixel(result.source, 8, 8), [10, 80, 220, 255]);
  assertMask(result);

  for (const [left, top] of [[0, 0], [60, 80]]) {
    const edge = raster(120, 100, [0, 0, 0, 0]);
    rectangle(edge, left, top, 60, 20, [90, 100, 110, 128]);
    const cropped = prepareImportedPixels(edge);
    assert.equal(cropped.source.width, 65);
    assert.equal(cropped.source.height, 25);
    assertMask(cropped);
  }
});

test('one-pixel-wide and one-pixel-high images preserve faint alpha without out-of-bounds sampling', () => {
  for (const [width, height] of [[1, 9], [9, 1]]) {
    const image = raster(width, height, [0, 0, 0, 0]);
    rectangle(image, Math.floor(width / 2), Math.floor(height / 2), 1, 1, [90, 100, 110, 1]);
    const result = prepareImportedPixels(image);
    assert.deepEqual(result.source, image);
    assertMask(result);
  }
});

test('transparent, white, black, and uniformly colored blank images report no foreground', () => {
  for (const color of [[255, 255, 255, 0], [255, 255, 255, 255], [0, 0, 0, 255], [40, 90, 150, 255]]) {
    for (const [width, height] of [[1, 1], [2, 2], [40, 30]]) {
      assert.throws(() => prepareImportedPixels(raster(width, height, color)), /No foreground.*visible mark/);
    }
  }
});

test('pixel helper validates dimensions and byte buffers and accepts Uint8Array views', () => {
  for (const [width, height] of [[0, 1], [-1, 2], [1.5, 2], [NaN, 2], [1, Infinity], [Number.MAX_SAFE_INTEGER, 2]]) {
    assert.throws(() => prepareImportedPixels({ width, height, data: new Uint8Array() }), /invalid dimensions/);
  }
  for (const data of [new Uint8Array(3), new Float32Array(4), [0, 0, 0, 0], null]) {
    assert.throws(() => prepareImportedPixels({ width: 1, height: 1, data }), /RGBA byte array/);
  }
  const image = raster(10, 10, [0, 0, 0, 0]);
  rectangle(image, 4, 4, 2, 2, [10, 20, 30, 200]);
  const bytes = new Uint8Array(image.data.length + 16);
  bytes.set(image.data, 8);
  const original = bytes.slice();
  const result = prepareImportedPixels({ ...image, data: bytes.subarray(8, -8) });
  assert.deepEqual(result.source, image);
  assert.deepEqual(bytes, original);
  assertMask(result);
});

function mockCanvases(t) {
  const canvases = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement(tag) {
        assert.equal(tag, 'canvas');
        const canvas = { width: 0, height: 0 };
        const context = {
          drawImage(...args) { canvas.drawArgs = args; },
          getImageData(x, y, width, height) {
            assert.deepEqual([x, y, width, height], [0, 0, canvas.width, canvas.height]);
            const image = raster(width, height, [10, 20, 30, 0]);
            const markWidth = Math.min(20, width);
            const markHeight = Math.min(10, height);
            rectangle(image, Math.floor((width - markWidth) / 2), Math.floor((height - markHeight) / 2),
              markWidth, markHeight, [80, 120, 170, 128]);
            canvas.pixels = image;
            return image;
          },
          createImageData(width, height) { return raster(width, height, [0, 0, 0, 0]); },
          putImageData(image, x, y) {
            assert.deepEqual([x, y, image.width, image.height], [0, 0, canvas.width, canvas.height]);
            canvas.pixels = image;
          },
        };
        canvas.context = context;
        canvas.getContext = (type, options) => {
          assert.equal(type, '2d');
          canvas.contextOptions = options;
          return context;
        };
        canvases.push(canvas);
        return canvas;
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  });
  return canvases;
}

test('canvas wrapper bounds working dimensions to 1400 without upscaling, then uploads matching cropped pixels', (t) => {
  const canvases = mockCanvases(t);
  const cases = [
    [{ width: 2800, height: 1400 }, 1400, 700],
    [{ width: 1400, height: 5600 }, 350, 1400],
    [{ width: 80, height: 60 }, 80, 60],
    [{ width: 1, height: 5000 }, 1, 1400],
    [{ width: 10, height: 10, naturalWidth: 4000, naturalHeight: 2000 }, 1400, 700],
    [{ width: 10, height: 10, videoWidth: 2800, videoHeight: 1400 }, 1400, 700],
  ];
  for (const [image, width, height] of cases) {
    const start = canvases.length;
    const result = prepareImportedImage(image);
    const [working, source, mask] = canvases.slice(start);
    assert.equal(canvases.length - start, 3);
    assert.equal(working.width, width);
    assert.equal(working.height, height);
    assert.deepEqual(working.drawArgs, [image, 0, 0, width, height]);
    assert.deepEqual(working.contextOptions, { willReadFrequently: true });
    assert.equal(working.context.imageSmoothingEnabled, true);
    assert.equal(working.context.imageSmoothingQuality, 'high');
    assert.equal(result.source, source);
    assert.equal(result.mask, mask);
    assert.notEqual(source, mask);
    assert.equal(source.width, Math.min(width, 28));
    assert.equal(source.height, Math.min(height, 18));
    assert.deepEqual({ source: source.pixels, mask: mask.pixels }, prepareImportedPixels(working.pixels));
    assertMask({ source: source.pixels, mask: mask.pixels });
  }
});

test('canvas wrapper reports invalid images, unavailable contexts, and unreadable pixels', (t) => {
  mockCanvases(t);
  for (const image of [null, {}, { width: 0, height: 10 }, { width: 1, height: NaN }]) {
    assert.throws(() => prepareImportedImage(image), /invalid dimensions/);
  }
  t.mock.method(document, 'createElement', () => ({ getContext: () => null }));
  assert.throws(() => prepareImportedImage({ width: 10, height: 10 }), /browser could not process/);
  document.createElement.mock.mockImplementation(() => ({
    getContext: () => ({
      drawImage() {},
      getImageData() { throw new Error('SecurityError'); },
    }),
  }));
  assert.throws(() => prepareImportedImage({ width: 10, height: 10 }), /could not be read.*local image/);
  document.createElement.mock.mockImplementation(() => ({
    getContext: () => ({ drawImage() {}, getImageData: () => raster(10, 10) }),
  }));
  assert.throws(() => prepareImportedImage({ width: 10, height: 10 }), /No foreground.*visible mark/);
});
