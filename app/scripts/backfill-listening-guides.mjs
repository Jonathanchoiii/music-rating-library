import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backfillListeningGuides,
  publicListeningGuideIdentity,
} from "../listening-guides/index.mjs";

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libraryPath = path.join(appDirectory, ".private", "neodb-library.local.json");
const parsed = JSON.parse(await fs.readFile(libraryPath, "utf8"));
const releases = Array.isArray(parsed) ? parsed : parsed.releases ?? [];

const result = await backfillListeningGuides(
  releases.map((release) => ({
    id: release.id,
    ...publicListeningGuideIdentity(release),
  })),
);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
