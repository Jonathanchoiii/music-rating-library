import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectPrivateMediaNames,
  copySnapshotToICloud,
  packageRemotePreviewSnapshot,
  safePrivateFileName,
  sanitizePreviewStorage,
} from "../remote-preview/package-snapshot.mjs";
import { NEODB_OAUTH_CLIENT_KEY } from "../src/lib/sharedStorageKeys.js";
import { isReadOnlyModeFromLocation } from "../src/lib/readonlyMode.js";

test("private media names only accept same-origin cover and motion routes", () => {
  assert.equal(
    safePrivateFileName("/private-covers/album.webp", "/private-covers"),
    "album.webp",
  );
  assert.equal(
    safePrivateFileName("/private-covers/../secret", "/private-covers"),
    null,
  );
  assert.equal(
    safePrivateFileName("https://example.com/x.webp", "/private-covers"),
    null,
  );
});

test("snapshot collection walks catalog overlays and user releases", () => {
  const media = collectPrivateMediaNames([
    [{ coverUrl: "/private-covers/one.jpg" }],
    {
      releaseMetadataOverrides: {
        a: {
          motionArtwork: { localUrl: "/private-motion-artwork/a.webp" },
        },
      },
      userReleases: [{ coverUrl: "/private-covers/two.png" }],
      profiles: {
        "raw-kiiikiii": {
          media: { localMotionUrl: "/private-motion-artwork/artist.mp4" },
        },
      },
    },
  ]);
  assert.deepEqual([...media.covers].sort(), ["one.jpg", "two.png"]);
  assert.deepEqual([...media.motion].sort(), ["a.webp", "artist.mp4"]);
});

test("preview storage never includes NeoDB OAuth client records", () => {
  const storage = sanitizePreviewStorage({
    "recordshelf-user-state-v2": "{}",
    [NEODB_OAUTH_CLIENT_KEY]: "{\"secret\":true}",
  });
  assert.equal(storage["recordshelf-user-state-v2"], "{}");
  assert.equal(storage[NEODB_OAUTH_CLIENT_KEY], undefined);
});

test("settings does not expose phone preview sync", async () => {
  const settingsFiles = {
    "App.jsx": "../src/App.jsx",
    "SettingsDialog.jsx": "../src/components/SettingsDialog.jsx",
    "SettingsHome.jsx": "../src/components/SettingsHome.jsx",
    "PreviewGate.jsx": "../src/components/PreviewGate.jsx",
  };
  const sources = Object.fromEntries(
    await Promise.all(
      Object.entries(settingsFiles).map(async ([name, rel]) => [
        name,
        await fs.readFile(new URL(rel, import.meta.url), "utf8"),
      ]),
    ),
  );
  assert.match(sources["App.jsx"], /isSettingsRoute \? \([\s\S]*<SettingsDialog/);
  assert.match(sources["SettingsDialog.jsx"], /<SettingsHome\b/);
  assert.match(sources["SettingsHome.jsx"], /settings-section-label">资料管理</);
  for (const [name, source] of Object.entries(sources)) {
    assert.equal(source.includes("同步到手机预览"), false, name);
    assert.equal(source.includes("手机预览"), false, name);
    assert.equal(source.includes("/api/remote-preview/sync"), false, name);
    assert.equal(source.includes("syncPhonePreview"), false, name);
  }
});

test("authoritative 4173 stays writable unless ?readonly=1", () => {
  assert.equal(
    isReadOnlyModeFromLocation({
      hostname: "127.0.0.1",
      port: "4173",
      userAgent: "Mozilla/5.0",
      search: "",
    }),
    false,
  );
  assert.equal(
    isReadOnlyModeFromLocation({
      hostname: "127.0.0.1",
      port: "4173",
      userAgent: "Mozilla/5.0",
      search: "?readonly=1",
    }),
    true,
  );
  assert.equal(
    isReadOnlyModeFromLocation({
      hostname: "recordshelf.vercel.app",
      port: "",
      userAgent: "Safari",
      search: "",
    }),
    true,
  );
});

test("packager copies referenced covers and motion without oauth keys", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recordshelf-preview-"));
  const catalogPath = path.join(root, "catalog.json");
  const statePath = path.join(root, "shared-local-state.json");
  const coverDir = path.join(root, "covers");
  const motionDir = path.join(root, "motion");
  const snapshotDir = path.join(root, "snapshot");
  await fs.mkdir(coverDir);
  await fs.mkdir(motionDir);
  await fs.writeFile(path.join(coverDir, "one.jpg"), "cover");
  await fs.writeFile(path.join(motionDir, "spin.webp"), "motion");
  await fs.writeFile(
    catalogPath,
    JSON.stringify([
      {
        id: "release-one",
        title: "One",
        coverUrl: "/private-covers/one.jpg",
        listeningEntries: [{ id: "e1" }],
      },
    ]),
  );
  await fs.writeFile(
    statePath,
    JSON.stringify({
      revision: 4,
      updatedAt: "2026-08-15T00:00:00.000Z",
      storage: {
        "recordshelf-user-state-v2": JSON.stringify({
          releaseMetadataOverrides: {
            "release-one": {
              albumIntroduction: "手写介绍",
              motionArtwork: {
                status: "AVAILABLE",
                storage: "LOCAL_WEBP",
                localUrl: "/private-motion-artwork/spin.webp",
              },
            },
          },
        }),
        [NEODB_OAUTH_CLIENT_KEY]: "must-not-copy",
      },
    }),
  );

  const packed = await packageRemotePreviewSnapshot({
    catalogPath,
    statePath,
    snapshotDir,
    coverDirectories: [coverDir],
    motionDirectory: motionDir,
  });
  assert.equal(packed.catalogCount, 1);
  assert.equal(packed.coverCount, 1);
  assert.equal(packed.motionCount, 1);
  const state = JSON.parse(
    await fs.readFile(path.join(snapshotDir, "state.json"), "utf8"),
  );
  assert.equal(state.storage[NEODB_OAUTH_CLIENT_KEY], undefined);
  assert.match(
    state.storage["recordshelf-user-state-v2"],
    /手写介绍/,
  );
  assert.equal(
    await fs.readFile(path.join(snapshotDir, "covers", "one.jpg"), "utf8"),
    "cover",
  );

  const icloudRoot = path.join(root, "icloud");
  const copied = await copySnapshotToICloud(snapshotDir, {
    destination: path.join(icloudRoot, "preview"),
  });
  assert.equal(copied.copied, true);
  assert.equal(
    await fs.readFile(path.join(icloudRoot, "preview", "manifest.json"), "utf8"),
    await fs.readFile(path.join(snapshotDir, "manifest.json"), "utf8"),
  );
});
