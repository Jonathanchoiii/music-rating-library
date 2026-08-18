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
  "ArtistDetail.jsx",
);

test("artist detail closes only when the backdrop itself is clicked", async () => {
  const source = await fs.readFile(componentPath, "utf8");
  assert.match(
    source,
    /event\.target === event\.currentTarget\) onClose\?\.\(\)/,
  );
});

test("artist detail removes the redundant raw-artist eyebrow", async () => {
  const source = await fs.readFile(componentPath, "utf8");
  assert.equal(source.includes("原始艺人署名"), false);
});

test("artist detail has no generic topbar title and bleeds the verified hero photo", async () => {
  const source = await fs.readFile(componentPath, "utf8");
  assert.equal(source.includes("<span>艺人详情</span>"), false);
  assert.match(source, /has-hero-photo/);
  assert.match(source, /artist-detail-visual-veil/);
  assert.match(source, /artist-detail-media-blur/);
  assert.match(source, /data-close-on-photo/);
});

test("artist photo hero is 1:1 with an in-frame veil to the drawer surface", async () => {
  const css = await fs.readFile(
    path.join(directory, "..", "src", "styles.css"),
    "utf8",
  );
  const visualBlock =
    css.match(
      /\.artist-detail-drawer\.has-hero-photo \.artist-detail-visual \{[^}]+\}/,
    )?.[0] ?? "";
  const veilBlock = css.match(/\.artist-detail-visual-veil \{[^}]+\}/)?.[0] ?? "";
  const blurBlock = css.match(/\.artist-detail-media-blur \{[^}]+\}/)?.[0] ?? "";
  const identityBlock =
    css.match(
      /\.artist-detail-drawer\.has-hero-photo \.artist-detail-identity \{[^}]+\}/,
    )?.[0] ?? "";
  const heroBlock =
    css.match(
      /\.artist-detail-drawer\.has-hero-photo \.artist-detail-hero \{[^}]+\}/,
    )?.[0] ?? "";

  assert.match(visualBlock, /aspect-ratio:\s*1/);
  assert.equal(/height:\s*clamp\(/.test(visualBlock), false);
  assert.equal(css.includes("clamp(340px, 54vh, 560px)"), false);
  assert.equal(css.includes("clamp(280px, 48vh, 460px)"), false);
  assert.match(heroBlock, /border-bottom:\s*0/);
  assert.match(veilBlock, /inset:\s*auto 0 0/);
  assert.match(veilBlock, /height:\s*var\(--artist-hero-veil-height/);
  assert.match(veilBlock, /--artist-hero-fade-start/);
  assert.match(veilBlock, /--artist-hero-fade-mid/);
  assert.match(veilBlock, /--artist-hero-fade-opaque/);
  assert.match(css, /--artist-hero-veil-height:\s*36%/);
  assert.match(css, /--artist-hero-fade-start:\s*20%/);
  assert.match(css, /--artist-hero-fade-mid:\s*40%/);
  assert.match(css, /--artist-hero-fade-strong:\s*67%/);
  assert.match(css, /--artist-hero-fade-opaque:\s*94%/);
  assert.match(css, /--artist-hero-blur-height:\s*30%/);
  assert.equal(css.includes("artist-hero-veil-tuner"), false);
  assert.equal(veilBlock.includes("-30px"), false);
  assert.equal(/bottom:\s*calc\(-12% - 30px\)/.test(blurBlock), false);
  assert.match(blurBlock, /height:\s*var\(--artist-hero-blur-height/);
  assert.match(identityBlock, /position:\s*absolute/);
  assert.match(identityBlock, /bottom:\s*0/);
});

test("photo hero has no tuner and samples overlay title contrast", async () => {
  const source = await fs.readFile(componentPath, "utf8");
  const keys = await fs.readFile(
    path.join(directory, "..", "src", "lib", "sharedStorageKeys.js"),
    "utf8",
  );
  const css = await fs.readFile(
    path.join(directory, "..", "src", "styles.css"),
    "utf8",
  );
  assert.equal(source.includes("artist-hero-veil-tuner"), false);
  assert.equal(source.includes("ArtistHeroVeilTuner"), false);
  assert.equal(source.includes("头图渐变"), false);
  assert.equal(keys.includes("ARTIST_HERO_VEIL_STORAGE_KEY"), false);
  assert.equal(keys.includes("recordshelf.artist-hero-veil"), false);
  assert.match(source, /data-hero-ink=\{hasHeroPhoto \? heroInk : "dark"\}/);
  assert.match(css, /\[data-hero-ink="light"\] h2/);
  const mutedOverlayBlock =
    css.match(
      /\.artist-detail-drawer\.has-hero-photo \.artist-detail-aliases,\s*\.artist-detail-drawer\.has-hero-photo \.artist-detail-summary,\s*\.artist-detail-drawer\.has-hero-photo \.artist-media-message \{[^}]+\}/,
    )?.[0] ?? "";
  assert.match(mutedOverlayBlock, /color:\s*var\(--muted-dark\)/);
  assert.equal(/\[data-hero-ink="light"\][^{]*artist-detail-summary/.test(css), false);
  assert.equal(/\[data-hero-ink="light"\][^{]*artist-detail-aliases/.test(css), false);
  assert.match(source, /onToggleMotion/);
  assert.match(source, /motion-artwork-icon/);
});

test("artist detail exposes one manual public-research action", async () => {
  const source = await fs.readFile(componentPath, "utf8");
  assert.match(source, /onClick=\{onRequestIntroduction\}/);
  assert.equal(
    source.match(/onClick=\{onRequestIntroduction\}/g)?.length,
    1,
  );
  assert.equal(source.includes("Sparkle"), false);
  assert.match(source, /listening-guide-update/);
  assert.match(source, /关闭探索模式/);
  assert.match(source, /开启探索模式/);
  assert.match(source, /更新艺人介绍/);
  assert.match(source, /<dt>团体成员<\/dt>/);
  assert.match(source, /artist-public-members-fact/);
  assert.match(source, /join\(" \/ "\)/);
  assert.match(source, /ArtistFactSection title="获奖"/);
  assert.match(source, /ArtistFactSection title="提名与入围"/);
  assert.match(source, /ArtistFactSection title="影视作品关系"/);
  assert.match(source, /artist-research-notice/);
  assert.match(source, /<ArtistPublicFacts facts=\{profile\?\.publicFacts\} \/>/);
});

test("artist public genres reuse listening-guide suggested-listen chips", async () => {
  const source = await fs.readFile(componentPath, "utf8");
  const css = await fs.readFile(
    path.join(directory, "..", "src", "styles.css"),
    "utf8",
  );
  assert.match(source, /<dt>流派<\/dt>/);
  assert.match(source, /artist-public-genres-fact/);
  assert.match(source, /className="artist-public-genres"/);
  assert.match(source, /className="listening-guide-chip"/);
  assert.equal(source.includes('aria-label="流派"'), false);
  const wrapBlock =
    css.match(
      /\.listening-guide-highlights > div,\s*\.artist-public-genres \{[^}]+\}/,
    )?.[0] ?? "";
  const chipBlock =
    css.match(
      /\.listening-guide-highlights > div span,\s*\.listening-guide-chip \{[^}]+\}/,
    )?.[0] ?? "";
  assert.match(wrapBlock, /flex-wrap:\s*wrap/);
  assert.match(chipBlock, /background:\s*#efefec/);
  assert.match(chipBlock, /color:\s*var\(--muted-dark\)/);
  assert.match(chipBlock, /font-size:\s*11px/);
  const genreFactBlock =
    Array.from(
      css.matchAll(
        /\.artist-public-facts > \.artist-public-genres-fact \{[^}]+\}/g,
      ),
      (match) => match[0],
    ).find((block) => block.includes("background: transparent")) ?? "";
  const genreChipBlock =
    css.match(
      /\.artist-public-facts \.artist-public-genres \.listening-guide-chip \{[^}]+\}/,
    )?.[0] ?? "";
  const factsBlock = css.match(/\.artist-public-facts \{[^}]+\}/)?.[0] ?? "";
  const factCellBlock = css.match(/\.artist-public-facts > div \{[^}]+\}/)?.[0] ?? "";
  const factDdBlock = css.match(/\.artist-public-facts dd \{[^}]+\}/)?.[0] ?? "";
  assert.match(factsBlock, /margin:\s*0/);
  assert.match(factsBlock, /padding:\s*0/);
  assert.equal(/padding-left:/.test(factsBlock), false);
  assert.equal(/margin-left:/.test(factsBlock), false);
  assert.match(factCellBlock, /padding:\s*12px 13px 12px 0/);
  assert.match(factDdBlock, /margin:\s*0/);
  assert.match(factDdBlock, /padding:\s*0/);
  assert.match(genreFactBlock, /padding:\s*0/);
  assert.match(genreFactBlock, /background:\s*transparent/);
  assert.match(genreChipBlock, /min-height:\s*20px/);
  assert.match(genreChipBlock, /font-weight:\s*400/);
  assert.match(genreChipBlock, /white-space:\s*nowrap/);
});

test("artist detail exposes compact artist platform links and one manual media request", async () => {
  const source = await fs.readFile(componentPath, "utf8");
  const css = await fs.readFile(
    path.join(directory, "..", "src", "styles.css"),
    "utf8",
  );
  assert.match(source, /onSavePlatformLinks/);
  assert.match(source, /onMatchAppleLink/);
  assert.match(source, /从已确认专辑匹配 Apple Music/);
  assert.match(source, /onRequestMedia/);
  assert.match(source, /visibleArtistMediaMessage/);
  assert.equal(
    source.includes("profile.media.error || profile.media.notice"),
    false,
  );
  assert.match(source, /Apple Music/);
  assert.match(source, /Spotify/);
  assert.match(source, /YouTube Music/);
  assert.match(source, /artist-platform-tools/);
  assert.match(source, /artist-identity-actions/);
  assert.match(source, /artist-detail-media/);
  assert.match(source, /is-motion-video/);
  assert.match(source, /<video/);
  assert.match(source, /artist-detail-collage/);
  assert.match(css, /\.artist-detail-media\.is-motion \{[\s\S]*?scale\(1\.2\)/);
  assert.match(
    css,
    /\.artist-identity-actions \.icon-button \{[\s\S]*?color:\s*var\(--text\)/,
  );
});

test("artist platform icons reflect confirmed links and remain inert when missing", async () => {
  const source = await fs.readFile(componentPath, "utf8");
  assert.match(source, /className="is-connected"/);
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.match(source, /className="is-missing"[\s\S]*?disabled/);
  assert.match(source, /setConfirmedLinks\(next\)/);
  assert.match(source, /confirmedLinks\?\.\[provider\]/);
});

test("artist platform links persist immediately through shared artistProfiles", async () => {
  const appSource = await fs.readFile(
    path.join(directory, "..", "src", "App.jsx"),
    "utf8",
  );
  assert.match(appSource, /getArtistProfile\(/);
  assert.match(appSource, /skipInitialArtistProfilePersistRef/);
  assert.match(appSource, /persistArtistProfilePatch/);
  assert.match(
    appSource,
    /persistArtistProfilePatch\(selectedArtistGroup\.id, \{ platformLinks \}\)/,
  );
  assert.match(appSource, /saveArtistProfileState\(next, window\.localStorage/);
});

test("artist research details read awards and sources from the profile", async () => {
  const source = await fs.readFile(componentPath, "utf8");
  const fn =
    source.slice(source.indexOf("function ArtistResearchDetails")) || "";
  assert.match(fn, /const awards = profile\?\.awards \?\? \[\]/);
  assert.match(fn, /const nominations = profile\?\.nominations \?\? \[\]/);
  assert.match(fn, /const films = profile\?\.filmRelationships \?\? \[\]/);
  assert.match(fn, /const listening = profile\?\.recommendedListening \?\? \[\]/);
  assert.match(fn, /const sources = profile\?\.sources \?\? \[\]/);
});

test("artist route plus-encoded IDs open the spaced raw credit", async () => {
  const { getLibraryRouteState } = await import("../src/lib/librarySearch.js");
  const plus = getLibraryRouteState({
    pathname: "/artists",
    search: "?view=list&artist=raw-doja%2Bcat",
  });
  const spaced = getLibraryRouteState({
    pathname: "/artists",
    search: "?view=list&artist=raw-doja+cat",
  });
  const encoded = getLibraryRouteState({
    pathname: "/artists",
    search: "?view=list&artist=raw-doja%20cat",
  });
  assert.equal(plus.selectedArtistId, "raw-doja cat");
  assert.equal(spaced.selectedArtistId, "raw-doja cat");
  assert.equal(encoded.selectedArtistId, "raw-doja cat");
  assert.equal(plus.isArtistIndex, false);
});

test("artist introduction client maps Codex codes instead of a generic failure", async () => {
  const appSource = await fs.readFile(
    path.join(directory, "..", "src", "App.jsx"),
    "utf8",
  );
  assert.match(appSource, /artistResearchJobPatch/);
  assert.equal(appSource.includes("Codex 联网研究没有完成，原有资料已保留。"), false);
  assert.equal(appSource.includes("CODEX_NOT_LOGGED_IN"), false);
});
