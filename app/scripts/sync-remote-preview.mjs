#!/usr/bin/env node
import { loadPreviewEnv, syncRemotePreview } from "../remote-preview/sync.mjs";

const skipBlob = process.argv.includes("--skip-blob");
const skipICloud = process.argv.includes("--skip-icloud");

await loadPreviewEnv();
try {
  const result = await syncRemotePreview({ skipBlob, skipICloud });
  console.log(
    JSON.stringify(
      {
        ok: true,
        updatedAt: result.updatedAt,
        catalogCount: result.catalogCount,
        coverCount: result.coverCount,
        motionCount: result.motionCount,
        icloud: result.icloud,
        blob: {
          uploaded: result.blob.uploaded,
          files: result.blob.files ?? 0,
          reason: result.blob.reason ?? null,
        },
        tokenPresent: result.tokenPresent,
      },
      null,
      2,
    ),
  );
  if (!result.blob.uploaded) {
    process.exitCode = result.tokenPresent ? 1 : 0;
  }
} catch (error) {
  console.error(error?.message ?? error);
  process.exit(1);
}
