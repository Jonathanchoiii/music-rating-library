export const HERO_INK_SAMPLE_SIZE = 24;
export const HERO_INK_OBJECT_POSITION_Y = 0.5;
export const HERO_INK_LUMINANCE_THRESHOLD = 0.46;
/** Lower title band for the name. Stats/aliases sit on the opaque cream veil and keep dark type. */
export const HERO_INK_BAND = Object.freeze({
  x0: 0.06,
  x1: 0.72,
  y0: 0.58,
  y1: 0.84,
});

function channelToLinear(channel) {
  const value = channel / 255;
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(red, green, blue) {
  return (
    0.2126 * channelToLinear(red) +
    0.7152 * channelToLinear(green) +
    0.0722 * channelToLinear(blue)
  );
}

export function heroInkFromLuminance(luminance) {
  return luminance < HERO_INK_LUMINANCE_THRESHOLD ? "light" : "dark";
}

export function heroInkFromPixelData(
  pixelData,
  width,
  height,
  band = HERO_INK_BAND,
) {
  if (!pixelData?.length || !width || !height) return "dark";
  const xStart = Math.max(0, Math.floor(width * band.x0));
  const xEnd = Math.min(width, Math.ceil(width * band.x1));
  const yStart = Math.max(0, Math.floor(height * band.y0));
  const yEnd = Math.min(height, Math.ceil(height * band.y1));
  let total = 0;
  let count = 0;
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      const index = (y * width + x) * 4;
      if (pixelData[index + 3] < 160) continue;
      total += relativeLuminance(
        pixelData[index],
        pixelData[index + 1],
        pixelData[index + 2],
      );
      count += 1;
    }
  }
  if (!count) return "dark";
  return heroInkFromLuminance(total / count);
}

export function drawCoverFittedImage(
  context,
  image,
  size,
  positionX = 0.5,
  positionY = HERO_INK_OBJECT_POSITION_Y,
) {
  const sourceWidth = image?.naturalWidth || image?.videoWidth;
  const sourceHeight = image?.naturalHeight || image?.videoHeight;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.max(size / sourceWidth, size / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(
    image,
    (size - drawWidth) * positionX,
    (size - drawHeight) * positionY,
    drawWidth,
    drawHeight,
  );
}

export function readArtistHeroInk(image) {
  const sourceWidth = image?.naturalWidth || image?.videoWidth;
  const sourceHeight = image?.naturalHeight || image?.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;
  const canvas = document.createElement("canvas");
  canvas.width = HERO_INK_SAMPLE_SIZE;
  canvas.height = HERO_INK_SAMPLE_SIZE;
  const context = canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  });
  if (!context) return null;
  try {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    drawCoverFittedImage(context, image, HERO_INK_SAMPLE_SIZE);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return heroInkFromPixelData(pixels, canvas.width, canvas.height);
  } catch {
    return null;
  }
}
