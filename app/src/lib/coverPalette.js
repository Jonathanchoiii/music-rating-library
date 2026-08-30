export const COVER_PALETTE_COLUMNS = 20;
export const COVER_PALETTE_ROWS = 18;
export const COVER_PALETTE_SAMPLE_COUNT =
  COVER_PALETTE_COLUMNS * COVER_PALETTE_ROWS;

const paletteCache = new Map();

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function rgbToHsb(red, green, blue) {
  const r = clamp(red / 255);
  const g = clamp(green / 255);
  const b = clamp(blue / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;

  if (delta > 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }

  if (hue < 0) hue += 360;
  return {
    hue,
    saturation: max === 0 ? 0 : delta / max,
    brightness: max,
  };
}

function mixRgb(color, target, amount) {
  const ratio = clamp(amount);
  return {
    red: Math.round(color.red * (1 - ratio) + target.red * ratio),
    green: Math.round(color.green * (1 - ratio) + target.green * ratio),
    blue: Math.round(color.blue * (1 - ratio) + target.blue * ratio),
  };
}

function hsbToRgb(hue, saturation, brightness) {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const chroma = brightness * saturation;
  const segment = normalizedHue / 60;
  const intermediate = chroma * (1 - Math.abs((segment % 2) - 1));
  const offset = brightness - chroma;
  let red = 0;
  let green = 0;
  let blue = 0;

  if (segment < 1) [red, green] = [chroma, intermediate];
  else if (segment < 2) [red, green] = [intermediate, chroma];
  else if (segment < 3) [green, blue] = [chroma, intermediate];
  else if (segment < 4) [green, blue] = [intermediate, chroma];
  else if (segment < 5) [red, blue] = [intermediate, chroma];
  else [red, blue] = [chroma, intermediate];

  return {
    red: Math.round((red + offset) * 255),
    green: Math.round((green + offset) * 255),
    blue: Math.round((blue + offset) * 255),
  };
}

export function liftCoverBrightness(color) {
  const hsb = rgbToHsb(color.red, color.green, color.blue);
  const liftedBrightness =
    hsb.brightness >= 1
      ? hsb.brightness
      : hsb.brightness + (1 - hsb.brightness) * 0.7;
  return hsbToRgb(hsb.hue, hsb.saturation, liftedBrightness);
}

function rgbCss({ red, green, blue }) {
  return `rgb(${red} ${green} ${blue})`;
}

function rgbaCss({ red, green, blue }, alpha) {
  return `rgb(${red} ${green} ${blue} / ${alpha})`;
}

export function findDominantCoverColors(pixelData) {
  const buckets = new Map();

  for (let index = 0; index < pixelData.length; index += 4) {
    const alpha = pixelData[index + 3];
    if (alpha < 160) continue;
    const red = pixelData[index];
    const green = pixelData[index + 1];
    const blue = pixelData[index + 2];
    const hsb = rgbToHsb(red, green, blue);
    const hueBucket = hsb.saturation < 0.08 ? "neutral" : Math.round(hsb.hue / 18) % 20;
    const saturationBucket = Math.round(hsb.saturation / 0.14);
    const brightnessBucket = Math.round(hsb.brightness / 0.11);
    const key = `${hueBucket}:${saturationBucket}:${brightnessBucket}`;
    const bucket = buckets.get(key) ?? {
      count: 0,
      red: 0,
      green: 0,
      blue: 0,
    };
    bucket.count += 1;
    bucket.red += red;
    bucket.green += green;
    bucket.blue += blue;
    buckets.set(key, bucket);
  }

  const ranked = [...buckets.values()]
    .map((bucket) => ({
      count: bucket.count,
      red: Math.round(bucket.red / bucket.count),
      green: Math.round(bucket.green / bucket.count),
      blue: Math.round(bucket.blue / bucket.count),
    }))
    .sort((first, second) => second.count - first.count);

  const primary = ranked[0] ?? { red: 235, green: 233, blue: 228, count: 1 };
  return { primary };
}

export function createCoverPalette(primary) {
  const elevatedPrimary = liftCoverBrightness(primary);
  const hsb = rgbToHsb(
    elevatedPrimary.red,
    elevatedPrimary.green,
    elevatedPrimary.blue,
  );
  const lightBase = { red: 249, green: 248, blue: 245 };
  const surface = mixRgb(
    elevatedPrimary,
    lightBase,
    hsb.saturation < 0.12 ? 0.42 : 0.32,
  );

  return {
    tone: "light",
    hsb,
    style: {
      "--detail-palette-primary": rgbCss(surface),
      "--detail-palette-primary-soft": rgbaCss(elevatedPrimary, 0.24),
      "--detail-hero-ink": "#171715",
      "--detail-hero-muted": "rgb(23 23 21 / 0.62)",
      "--detail-hero-line": "rgb(23 23 21 / 0.14)",
      "--detail-control-surface": "rgb(255 255 255 / 0.68)",
    },
  };
}

export function readCoverPalette(image, cacheKey = image?.currentSrc || image?.src) {
  if (!image?.naturalWidth || !image?.naturalHeight) return null;
  if (cacheKey && paletteCache.has(cacheKey)) return paletteCache.get(cacheKey);

  const canvas = document.createElement("canvas");
  canvas.width = COVER_PALETTE_COLUMNS;
  canvas.height = COVER_PALETTE_ROWS;
  const context = canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  });
  if (!context) return null;

  try {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const { primary } = findDominantCoverColors(pixels);
    const palette = createCoverPalette(primary);
    if (cacheKey) paletteCache.set(cacheKey, palette);
    return palette;
  } catch {
    return null;
  }
}

export function getCoverPaletteProxyUrl(sourceUrl) {
  try {
    const url = new URL(String(sourceUrl ?? ""));
    if (url.protocol !== "https:") return "";
    return `/api/cover-palette-image?url=${encodeURIComponent(url.href)}`;
  } catch {
    return "";
  }
}
