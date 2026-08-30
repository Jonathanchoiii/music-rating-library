import fs from "node:fs/promises";
import path from "node:path";

const appRoot = path.resolve(import.meta.dirname, "..");
const privateLibraryPath = path.join(
  appRoot,
  ".private/neodb-library.local.json",
);

async function javascriptContents(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const contents = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      contents.push(await javascriptContents(target));
    } else if (entry.name.endsWith(".js")) {
      contents.push(await fs.readFile(target, "utf8"));
    }
  }
  return contents.join("\n");
}

let privateLibrary;
try {
  privateLibrary = JSON.parse(
    await fs.readFile(privateLibraryPath, "utf8"),
  );
} catch (error) {
  if (error?.code === "ENOENT") {
    console.log("No private library present; local privacy comparison skipped.");
    privateLibrary = null;
  } else {
    throw error;
  }
}

const privateMarker = privateLibrary?.find((release) => release?.id)?.id;
if (privateLibrary && !privateMarker) {
  throw new Error("Private library has no stable release marker.");
}

const publicBundle = await javascriptContents(
  path.join(appRoot, "dist/client"),
);
const desktopBundle = await javascriptContents(
  path.join(appRoot, "dist/desktop-client"),
);

if (privateMarker) {
  if (publicBundle.includes(privateMarker)) {
    throw new Error("Public build contains a private release marker.");
  }
  if (!desktopBundle.includes(privateMarker)) {
    throw new Error("Desktop build is missing the local private library.");
  }
}

const builtClientCode = `${publicBundle}\n${desktopBundle}`;
const credentialPatterns = [
  { label: "OpenAI API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "Google API key", pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/ },
];
for (const credential of credentialPatterns) {
  if (credential.pattern.test(builtClientCode)) {
    throw new Error(`Built client contains a possible ${credential.label}.`);
  }
}

console.log(
  "Build privacy verified: public demo is clean, desktop data is local, and no provider keys were bundled.",
);
