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

const VIDEO_MIME_TYPES = [
  'video/mp4;codecs=avc1.640032', // High Profile Level 5.0 supports 1920 × 1920 at 25 fps.
  'video/mp4;codecs=h264',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
];

function supportedVideoMimeType() {
  if (typeof globalThis.MediaRecorder !== 'function'
      || typeof globalThis.MediaRecorder.isTypeSupported !== 'function') return '';
  return VIDEO_MIME_TYPES.find((type) => {
    try {
      return globalThis.MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  }) || '';
}

/** Whether this browser can record a canvas as H.264 MP4 or VP9/VP8 WebM. */
export function supportsVideoExport() {
  return typeof globalThis.HTMLCanvasElement?.prototype?.captureStream === 'function'
    && Boolean(supportedVideoMimeType());
}

export async function recordCanvasVideo({
  canvas, renderFrame, duration = 5, fps = 25, onProgress, signal,
}) {
  const abortReason = () => signal.reason ?? new DOMException('Video export cancelled.', 'AbortError');
  if (signal?.aborted) throw abortReason();
  const mimeType = supportedVideoMimeType();
  if (typeof canvas?.captureStream !== 'function' || !mimeType) {
    throw new Error('Video export is not supported in this browser. Canvas captureStream and H.264 MP4 or VP9/VP8 WebM recording are required.');
  }
  if (typeof renderFrame !== 'function') throw new TypeError('renderFrame must be a function.');
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(duration * 1000)
      || !Number.isFinite(fps) || fps <= 0) {
    throw new RangeError('Video duration and fps must be positive, finite numbers.');
  }

  const durationMs = duration * 1000;
  // Hold the final image for one frame within the requested recording duration.
  const frameInterval = Math.min(1000 / fps, durationMs / 2);
  const animationDuration = durationMs - frameInterval;

  return new Promise((resolve, reject) => {
    const chunks = [];
    let stream;
    let recorder;
    let timer;
    let deadlineTimer;
    let stopTimeout;
    let startedAt;
    let stopping = false;
    let settled = false;

    function cleanup() {
      clearTimeout(timer);
      clearTimeout(deadlineTimer);
      clearTimeout(stopTimeout);
      signal?.removeEventListener('abort', onAbort);
      if (recorder) {
        recorder.removeEventListener('dataavailable', onData);
        recorder.removeEventListener('error', onError);
        recorder.removeEventListener('stop', onStop);
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch {
          // Stopping one resource must not prevent release of the others.
        }
      }
      for (const track of stream?.getTracks() || []) {
        try { track.stop(); } catch { /* Release every track even if one fails. */ }
      }
    }

    function finish(error, result) {
      if (settled) return;
      settled = true;
      cleanup();
      if (result) resolve(result);
      else reject(error);
    }

    function onAbort() { finish(abortReason()); }
    function onError(event) { finish(event.error || new Error('Video recording failed.')); }
    function onData(event) {
      if (event.data?.size > 0) chunks.push(event.data);
    }
    function onStop() {
      if (!stopping) {
        finish(new Error('Video recording stopped before completion.'));
        return;
      }
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
        if (!blob.size) throw new Error('Video recording produced an empty file.');
        finish(null, { blob, extension: mimeType.startsWith('video/mp4') ? 'mp4' : 'webm' });
      } catch (error) {
        finish(error);
      }
    }

    function stopRecording() {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(timer);
      clearTimeout(deadlineTimer);
      // Some implementations fail to dispatch stop after an encoder failure.
      stopTimeout = setTimeout(() => finish(new Error('Video recording did not finish in time.')), 5000);
      try { recorder.stop(); } catch (error) { finish(error); }
    }

    async function draw(progress) {
      if (settled || stopping) return;
      try {
        await renderFrame(progress);
        if (settled || stopping) return;
        for (const track of stream.getVideoTracks()) track.requestFrame?.();
        onProgress?.(progress);
        if (settled || stopping) return;
        // Hold an on-time final frame until the independent recording deadline.
        if (progress === 1) return;
        const elapsed = performance.now() - startedAt;
        const nextFrameAt = Math.min(animationDuration, (Math.floor(elapsed / frameInterval) + 1) * frameInterval);
        timer = setTimeout(() => {
          const next = Math.min(1, (performance.now() - startedAt) / animationDuration);
          void draw(next);
        }, Math.max(1, nextFrameAt - elapsed));
      } catch (error) {
        finish(error);
      }
    }

    try {
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      stream = canvas.captureStream(fps);
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
      recorder.addEventListener('dataavailable', onData);
      recorder.addEventListener('error', onError);
      recorder.addEventListener('stop', onStop);
      recorder.start();
      if (settled) return;
      startedAt = performance.now();
      // Stop on time even if an asynchronous render is still pending.
      deadlineTimer = setTimeout(stopRecording, durationMs);
      void draw(0);
    } catch (error) {
      finish(error);
    }
  });
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
