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
    process.exit(0);
  }
  throw error;
}

const privateMarker = privateLibrary.find((release) => release?.id)?.id;
if (!privateMarker) {
  throw new Error("Private library has no stable release marker.");
}

const publicBundle = await javascriptContents(
  path.join(appRoot, "dist/client"),
);
const desktopBundle = await javascriptContents(
  path.join(appRoot, "dist/desktop-client"),
);

if (publicBundle.includes(privateMarker)) {
  throw new Error("Public build contains a private release marker.");
}
if (!desktopBundle.includes(privateMarker)) {
  throw new Error("Desktop build is missing the local private library.");
}

console.log(
  "Build privacy verified: public demo is clean and desktop data is local.",
);
