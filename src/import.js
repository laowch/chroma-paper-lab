const MAX_SIDE = 1400;
const BACKGROUND_TOLERANCE = 12;

function validateDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 1 || height < 1 || !Number.isSafeInteger(width * height * 4)) {
    throw new Error('This image has invalid dimensions. Please choose another image.');
  }
}

function contrast(data, offset, background) {
  const red = (data[offset] - background[0]) / 255;
  const green = (data[offset + 1] - background[1]) / 255;
  const blue = (data[offset + 2] - background[2]) / 255;
  return Math.max(
    Math.hypot(red, green, blue) / Math.sqrt(3) * 2.55,
    Math.abs(red * 0.2126 + green * 0.7152 + blue * 0.0722) * 2.8,
  );
}

function estimateBackground(data, width, height) {
  const size = Math.min(width, height, 24, Math.max(2, Math.floor(Math.min(width, height) * 0.04)));
  const corners = [[0, 0], [width - size, 0], [0, height - size], [width - size, height - size]]
    .map(([left, top]) => {
      const offsets = [];
      for (let y = top; y < top + size; y += 1) {
        for (let x = left; x < left + size; x += 1) offsets.push((y * width + x) * 4);
      }
      return offsets;
    });
  const samples = corners.flat();

  // Existing transparency preserves cutouts that touch every corner.
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] === 0) return null;
  }
  if (samples.filter((offset) => data[offset + 3] < 72).length > samples.length / 2) return null;

  // Medians resist a contaminated corner and isolated JPEG/corner noise.
  const background = [0, 1, 2].map((channel) => {
    const values = samples.map((offset) => data[offset + channel]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  });
  const matches = (offset) => data[offset + 3] >= 240
    && background.every((value, channel) => Math.abs(data[offset + channel] - value) <= BACKGROUND_TOLERANCE);
  const agreeingCorners = corners.filter((offsets) => offsets.filter(matches).length >= offsets.length * 0.75);
  if (agreeingCorners.length < 3) return null;

  // Preserve original alpha when matching corners hide a nonuniform perimeter.
  const perimeter = [];
  for (let index = 0; index < 32; index += 1) {
    const x = Math.round(index * (width - 1) / 31);
    const y = Math.round(index * (height - 1) / 31);
    perimeter.push(x * 4, ((height - 1) * width + x) * 4, y * width * 4, (y * width + width - 1) * 4);
  }
  if (perimeter.filter(matches).length < perimeter.length * 0.75) return null;

  const noise = samples.filter(matches).map((offset) => contrast(data, offset, background)).sort((a, b) => a - b);
  return { color: background, floor: Math.max(0.035, noise[Math.floor((noise.length - 1) * 0.95)]) };
}

export function prepareImportedPixels({ data, width, height }) {
  validateDimensions(width, height);
  if (!(data instanceof Uint8ClampedArray || data instanceof Uint8Array) || data.length !== width * height * 4) {
    throw new TypeError('Image pixels must be an RGBA byte array matching its dimensions.');
  }
  const background = estimateBackground(data, width, height);
  const alpha = new Uint8ClampedArray(width * height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * 4;
      const coverage = background
        ? Math.max(0, Math.min(1, (contrast(data, offset, background.color) - background.floor) / 0.42))
        : 1;
      // Multiply coverage by native alpha, rather than boosting translucent ink.
      alpha[index] = Math.round(data[offset + 3] * coverage);
      if (alpha[index] > 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    throw new Error('No foreground was found in this image. Please choose an image with a visible mark.');
  }

  const padding = Math.max(4, Math.round(Math.max(maxX - minX + 1, maxY - minY + 1) * 0.08));
  const left = Math.max(0, minX - padding);
  const top = Math.max(0, minY - padding);
  const cropWidth = Math.min(width, maxX + 1 + padding) - left;
  const cropHeight = Math.min(height, maxY + 1 + padding) - top;
  const source = { width: cropWidth, height: cropHeight, data: new Uint8ClampedArray(cropWidth * cropHeight * 4) };
  const mask = { width: cropWidth, height: cropHeight, data: new Uint8ClampedArray(source.data.length) };
  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const index = (y + top) * width + x + left;
      const offset = (y * cropWidth + x) * 4;
      source.data[offset] = data[index * 4];
      source.data[offset + 1] = data[index * 4 + 1];
      source.data[offset + 2] = data[index * 4 + 2];
      source.data[offset + 3] = alpha[index];
      mask.data[offset + 3] = alpha[index]; // RGB stays black; coverage lives only in alpha.
    }
  }
  return { source, mask };
}

function createCanvas(width, height, options) {
  if (typeof document === 'undefined') throw new Error('Image preparation requires a browser canvas.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', options);
  if (!context) throw new Error('Your browser could not process this image.');
  return { canvas, context };
}

/** Prepare a decoded CanvasImageSource as equal-sized source and alpha-mask canvases. */
export function prepareImportedImage(image) {
  const width = image?.naturalWidth ?? image?.videoWidth ?? image?.width;
  const height = image?.naturalHeight ?? image?.videoHeight ?? image?.height;
  validateDimensions(width, height);
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const workingWidth = Math.max(1, Math.round(width * scale));
  const workingHeight = Math.max(1, Math.round(height * scale));
  const { context } = createCanvas(workingWidth, workingHeight, { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, workingWidth, workingHeight);
  let pixels;
  try {
    pixels = context.getImageData(0, 0, workingWidth, workingHeight);
  } catch {
    throw new Error('This image could not be read. Please use a local image without external resources.');
  }
  const prepared = prepareImportedPixels(pixels);
  const toCanvas = (rgba) => {
    const { canvas, context: output } = createCanvas(rgba.width, rgba.height);
    const imageData = output.createImageData(rgba.width, rgba.height);
    imageData.data.set(rgba.data);
    output.putImageData(imageData, 0, 0);
    return canvas;
  };
  return { source: toCanvas(prepared.source), mask: toCanvas(prepared.mask) };
}
