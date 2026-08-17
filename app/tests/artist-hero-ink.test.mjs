import assert from "node:assert/strict";
import test from "node:test";
import {
  HERO_INK_BAND,
  HERO_INK_LUMINANCE_THRESHOLD,
  heroInkFromLuminance,
  heroInkFromPixelData,
  relativeLuminance,
} from "../src/lib/artistHeroInk.js";

function pixelsForGrid(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = fill[0];
    data[index + 1] = fill[1];
    data[index + 2] = fill[2];
    data[index + 3] = 255;
  }
  return data;
}

test("dark luminance maps to light overlay ink", () => {
  assert.ok(relativeLuminance(18, 16, 14) < HERO_INK_LUMINANCE_THRESHOLD);
  assert.equal(heroInkFromLuminance(0.12), "light");
});

test("light luminance maps to dark overlay ink", () => {
  assert.ok(relativeLuminance(236, 228, 214) > HERO_INK_LUMINANCE_THRESHOLD);
  assert.equal(heroInkFromLuminance(0.82), "dark");
});

test("hero ink samples the lower title band for the name, not the cream stats band", () => {
  assert.ok(HERO_INK_BAND.y1 < 0.9, "title band stays above the opaque veil");
  const width = 24;
  const height = 24;
  const data = pixelsForGrid(width, height, [12, 10, 8]);
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = 248;
      data[index + 1] = 244;
      data[index + 2] = 236;
    }
  }
  assert.equal(heroInkFromPixelData(data, width, height), "light");
});

test("a light title band keeps dark overlay type", () => {
  const data = pixelsForGrid(24, 24, [238, 232, 220]);
  assert.equal(heroInkFromPixelData(data, 24, 24), "dark");
});
