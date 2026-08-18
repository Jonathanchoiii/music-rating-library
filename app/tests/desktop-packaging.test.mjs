import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
function staticImportSpecifiers(source) {
  return [
    ...source.matchAll(/\bfrom\s*["'](\.[^"']+)["']/g),
    ...source.matchAll(/\bimport\s*["'](\.[^"']+)["']/g),
  ].map((match) => match[1]);
}

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function matchesFilesPattern(relativePosix, pattern) {
  if (pattern.endsWith("/**/*")) {
    const directory = pattern.slice(0, -"/**/*".length);
    return (
      relativePosix === directory ||
      relativePosix.startsWith(`${directory}/`)
    );
  }
  return relativePosix === pattern;
}

function isPackaged(relativePosix, patterns) {
  return patterns.some((pattern) =>
    matchesFilesPattern(relativePosix, pattern),
  );
}

async function collectStaticLocalImports(entryRelative, patterns) {
  const queue = [toPosix(entryRelative)];
  const seen = new Set();
  const missing = [];

  while (queue.length) {
    const relativePosix = queue.pop();
    if (seen.has(relativePosix)) continue;
    seen.add(relativePosix);

    const absolutePath = path.join(APP_ROOT, relativePosix);
    let source;
    try {
      source = await fs.readFile(absolutePath, "utf8");
    } catch (error) {
      missing.push({
        from: relativePosix,
        spec: relativePosix,
        resolved: relativePosix,
        reason: error?.code === "ENOENT" ? "missing-on-disk" : String(error),
      });
      continue;
    }

    if (!isPackaged(relativePosix, patterns)) {
      missing.push({
        from: relativePosix,
        spec: relativePosix,
        resolved: relativePosix,
        reason: "not-in-electron-files",
      });
    }

    if (!/\.(?:js|mjs|cjs)$/.test(relativePosix)) continue;

    for (const spec of staticImportSpecifiers(source)) {
      const resolved = toPosix(
        path.normalize(path.join(path.dirname(relativePosix), spec)),
      );
      queue.push(resolved);
    }
  }

  return { seen, missing };
}

test("desktop asar files include every static import from the Electron main process", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(APP_ROOT, "package.json"), "utf8"),
  );
  const patterns = packageJson.build.files;
  const { missing } = await collectStaticLocalImports(
    packageJson.main,
    patterns,
  );

  assert.deepEqual(
    missing,
    [],
    missing
      .map(
        (item) =>
          `${item.resolved} (${item.reason}) imported via ${item.from}`,
      )
      .join("\n"),
  );
});

test("shared artistProfiles sanitizer is packed without a static browser-state import", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(APP_ROOT, "package.json"), "utf8"),
  );
  const source = await fs.readFile(
    path.join(APP_ROOT, "src/lib/artistProfiles.js"),
    "utf8",
  );

  assert.equal(
    packageJson.build.files.includes("src/lib/artistProfiles.js"),
    true,
  );
  assert.equal(
    staticImportSpecifiers(source).includes("./sharedLocalState.js"),
    false,
  );
  assert.match(source, /import\("\.\/sharedLocalState\.js"\)/);
});
