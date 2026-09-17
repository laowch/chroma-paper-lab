const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePhysicalChunk(dpi) {
  const pixelsPerMeter = Math.round(dpi / 0.0254);
  if (typeof dpi !== 'number' || !Number.isFinite(dpi) || dpi <= 0
      || pixelsPerMeter < 1 || pixelsPerMeter > 0xffffffff) {
    throw new RangeError('DPI must produce a positive, unsigned 32-bit pixels-per-meter value.');
  }

  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9, false);
  chunk.set([112, 72, 89, 115], 4); // pHYs
  view.setUint32(8, pixelsPerMeter, false);
  view.setUint32(12, pixelsPerMeter, false);
  chunk[16] = 1; // Unit: meter.
  view.setUint32(17, crc32(chunk.subarray(4, 17)), false);
  return chunk;
}

/** Return a new PNG with one pHYs chunk, leaving all other chunks unchanged. */
export function setPngDpi(bytes, dpi) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('PNG bytes must be a Uint8Array.');
  }
  if (bytes.length < PNG_SIGNATURE.length
      || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new Error('Invalid PNG signature.');
  }

  const physicalChunk = makePhysicalChunk(dpi);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let outputLength = PNG_SIGNATURE.length + physicalChunk.length;
  let offset = PNG_SIGNATURE.length;
  let foundEnd = false;

  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    if (remaining < 12) {
      throw new Error('Truncated PNG chunk header or CRC.');
    }
    const length = view.getUint32(offset, false);
    if (length > 0x7fffffff || length > remaining - 12) {
      throw new Error('Invalid or truncated PNG chunk length.');
    }
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (offset === PNG_SIGNATURE.length && (type !== 'IHDR' || length !== 13)) {
      throw new Error('PNG must begin with a 13-byte IHDR chunk.');
    }
    if (type === 'IHDR' && offset !== PNG_SIGNATURE.length) {
      throw new Error('PNG contains multiple IHDR chunks.');
    }
    const end = offset + length + 12;
    if (type === 'IEND' && (length !== 0 || end !== bytes.length)) {
      throw new Error('Invalid PNG IEND chunk or trailing data.');
    }
    if (type !== 'pHYs') {
      const chunk = bytes.subarray(offset, end);
      chunks.push(chunk);
      outputLength += chunk.length;
    }
    offset = end;
    if (type === 'IEND') {
      foundEnd = true;
      break;
    }
  }
  if (!foundEnd) {
    throw new Error('PNG is missing its IEND chunk.');
  }

  const output = new Uint8Array(outputLength);
  output.set(PNG_SIGNATURE);
  offset = PNG_SIGNATURE.length;
  for (let index = 0; index < chunks.length; index += 1) {
    output.set(chunks[index], offset);
    offset += chunks[index].length;
    if (index === 0) {
      // pHYs must precede the first IDAT chunk.
      output.set(physicalChunk, offset);
      offset += physicalChunk.length;
    }
  }
  return output;
}

/** Encode a canvas as a PNG carrying actual print-resolution metadata. */
export async function canvasToPrintPng(canvas, { dpi = 300 } = {}) {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error('Canvas PNG encoding failed.'));
    }, 'image/png');
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new Blob([setPngDpi(bytes, dpi)], { type: 'image/png' });
}

/** Start a browser download and keep its object URL alive until the next task. */
export function downloadBlob(blob, filename) {
  const anchor = document.createElement('a');
  const url = URL.createObjectURL(blob);
  try {
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Immediate revocation can cancel downloads in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
