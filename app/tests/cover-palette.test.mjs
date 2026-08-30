import test from "node:test";
import assert from "node:assert/strict";
import {
  COVER_PALETTE_SAMPLE_COUNT,
  createCoverPalette,
  findDominantCoverColors,
  liftCoverBrightness,
  rgbToHsb,
} from "../src/lib/coverPalette.js";
import {
  handleCoverPaletteImageRequest,
  isTrustedCoverPaletteUrl,
} from "../scripts/private-covers-http.mjs";

function pixels(colors) {
  return Uint8ClampedArray.from(colors.flatMap((color) => [...color, 255]));
}

test("封面取色固定使用 20 × 18 共 360 个等面积采样格", () => {
  assert.equal(COVER_PALETTE_SAMPLE_COUNT, 360);
});

test("主色按采样面积占比选择，而不是按单个像素亮度选择", () => {
  const dominant = Array.from({ length: 250 }, () => [186, 48, 62]);
  const accent = Array.from({ length: 110 }, () => [40, 92, 190]);
  const result = findDominantCoverColors(pixels([...dominant, ...accent]));

  assert.ok(result.primary.red > result.primary.blue);
  assert.deepEqual(Object.keys(result), ["primary"]);
});

test("低明度封面按 B新 = B旧 + (100 - B旧) × 0.7 提亮", () => {
  const source = { red: 28, green: 38, blue: 54 };
  const sourceHsb = rgbToHsb(source.red, source.green, source.blue);
  const lifted = liftCoverBrightness(source);
  const liftedHsb = rgbToHsb(lifted.red, lifted.green, lifted.blue);
  const expectedBrightness =
    sourceHsb.brightness + (1 - sourceHsb.brightness) * 0.7;

  assert.ok(Math.abs(liftedHsb.brightness - expectedBrightness) < 0.01);
  assert.ok(Math.abs(liftedHsb.hue - sourceHsb.hue) < 1);
});

test("所有封面渐变都保持浅色背景与黑字", () => {
  const dark = createCoverPalette(
    { red: 28, green: 38, blue: 54 },
  );
  const light = createCoverPalette(
    { red: 228, green: 214, blue: 178 },
  );

  assert.equal(dark.tone, "light");
  assert.equal(dark.style["--detail-hero-ink"], "#171715");
  assert.equal(light.tone, "light");
  assert.equal(light.style["--detail-hero-ink"], "#171715");
  assert.ok(dark.hsb.brightness >= 0.7);
  assert.equal(dark.style["--detail-palette-secondary"], undefined);
});

test("跨域封面取色只允许固定公开图片域名，拒绝本机与伪装域名", () => {
  assert.equal(
    isTrustedCoverPaletteUrl(
      "https://neodb.social/m/album/example.jpg",
    ),
    true,
  );
  assert.equal(
    isTrustedCoverPaletteUrl("https://is1-ssl.mzstatic.com/image/thumb/example.jpg"),
    true,
  );
  assert.equal(isTrustedCoverPaletteUrl("http://127.0.0.1/private.jpg"), false);
  assert.equal(isTrustedCoverPaletteUrl("https://neodb.social.evil.test/a.jpg"), false);
  assert.equal(isTrustedCoverPaletteUrl("https://user@neodb.social/a.jpg"), false);
});

test("可信远程封面通过本机同源端点返回图片字节且不落盘", async () => {
  const headers = new Map();
  let body = null;
  const response = {
    statusCode: 0,
    headersSent: false,
    setHeader(name, value) {
      headers.set(name.toLocaleLowerCase(), String(value));
    },
    end(value) {
      body = value;
    },
  };
  const handled = await handleCoverPaletteImageRequest(
    {
      method: "GET",
      url: "/api/cover-palette-image?url=https%3A%2F%2Fneodb.social%2Fm%2Falbum%2Fcover.jpg",
    },
    response,
    {
      fetchImpl: async () =>
        new Response(Uint8Array.from([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    },
  );

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(headers.get("content-type"), "image/jpeg");
  assert.deepEqual([...body], [1, 2, 3, 4]);
});
