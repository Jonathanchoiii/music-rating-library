import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const componentPath = path.join(
  directory,
  "..",
  "src",
  "components",
  "ReleaseDetail.jsx",
);
const cssPath = path.join(directory, "..", "src", "styles.css");

test("release detail has no generic topbar title and keeps a close control", async () => {
  const source = await fs.readFile(componentPath, "utf8");
  assert.equal(source.includes("<span>发行详情</span>"), false);
  assert.match(source, /className="drawer-topbar"/);
  assert.match(source, /className="icon-button"/);
  assert.match(source, /关闭详情/);
});

test("release drawer close bar sticks overlay-style like artist detail", async () => {
  const css = await fs.readFile(cssPath, "utf8");
  const topbarBlock =
    css.match(/\.release-drawer > \.drawer-topbar \{[^}]+\}/)?.[0] ?? "";
  const buttonBlock =
    css.match(
      /\.release-drawer > \.drawer-topbar \.icon-button \{[^}]+\}/,
    )?.[0] ?? "";
  const artistTopbarBlock =
    css.match(/\.artist-detail-topbar \{[^}]+\}/)?.[0] ?? "";
  const iconButtonBlock = css.match(/^\.icon-button \{[^}]+\}/m)?.[0] ?? "";

  assert.match(topbarBlock, /position:\s*sticky/);
  assert.match(topbarBlock, /top:\s*0/);
  assert.match(topbarBlock, /z-index:\s*6/);
  assert.match(topbarBlock, /height:\s*56px/);
  assert.match(topbarBlock, /margin:\s*0 0 -56px/);
  assert.match(topbarBlock, /background:\s*transparent/);
  assert.match(topbarBlock, /pointer-events:\s*none/);
  assert.match(topbarBlock, /justify-content:\s*flex-end/);
  assert.equal(topbarBlock.includes("32px"), false);
  assert.match(buttonBlock, /pointer-events:\s*auto/);
  assert.match(artistTopbarBlock, /position:\s*sticky/);
  assert.match(artistTopbarBlock, /margin:\s*0 0 -56px/);
  assert.match(iconButtonBlock, /width:\s*44px/);
  assert.match(iconButtonBlock, /height:\s*44px/);
});

test("release detail keeps a 40px top breathing space on desktop and mobile", async () => {
  const css = await fs.readFile(cssPath, "utf8");
  const drawerBlock = css.match(/\.release-drawer \{[^}]+\}/)?.[0] ?? "";
  const mobileDrawerBlock =
    css.match(
      /@media \(max-width: 760px\)[\s\S]*?\.release-drawer \{[^}]+\}/,
    )?.[0] ?? "";

  assert.match(drawerBlock, /padding:\s*40px 30px 54px/);
  assert.match(mobileDrawerBlock, /padding:\s*40px 16px 100px/);
});

test("mobile release cover and summary share one top edge", async () => {
  const css = await fs.readFile(cssPath, "utf8");
  const mobileStart = css.indexOf(
    "@media (max-width: 760px) {\n  .library-main",
  );
  const mobileEnd = css.indexOf("\n@media", mobileStart + 1);
  const mobileCss = css.slice(
    mobileStart,
    mobileEnd === -1 ? undefined : mobileEnd,
  );

  assert.notEqual(mobileStart, -1);

  assert.match(
    mobileCss,
    /\.detail-hero \{[^}]*grid-template-columns:\s*136px minmax\(0, 1fr\)/,
  );
  assert.match(
    mobileCss,
    /\.detail-summary \{[^}]*align-self:\s*start;[^}]*padding-top:\s*0/,
  );
  assert.match(
    mobileCss,
    /\.detail-summary h2 \{[^}]*font-size:\s*20px/,
  );
  assert.match(
    mobileCss,
    /\.detail-summary::before \{[^}]*float:\s*right;[^}]*width:\s*44px;[^}]*height:\s*44px/,
  );
  assert.match(
    mobileCss,
    /> \.drawer-topbar \{[^}]*padding-top:\s*0/,
  );
});
