const CONFIRMED_LINK_STATUSES = new Set(["CONFIRMED", "AUTO_CONFIRMED"]);
const BATCH_SIZE = 40;

export function publicListeningGuideIdentity(release) {
  return {
    id: release.id,
    originalTitle: release.title,
    artists: Array.isArray(release.artists) ? release.artists : [],
    releaseDate: release.releaseDate ?? null,
    releaseType: release.releaseType ?? null,
    editionTypes: release.editionTypes ?? release.versionAttributes ?? [],
    externalIdentities: (release.externalLinks ?? [])
      .filter((link) => CONFIRMED_LINK_STATUSES.has(link.status))
      .map((link) => ({ provider: link.provider, idOrUrl: link.url })),
  };
}

export async function backfillListeningGuideCache(releases) {
  const publicReleases = releases.map(publicListeningGuideIdentity);
  const summary = {
    total: publicReleases.length,
    created: 0,
    existing: 0,
    identityUpdated: 0,
    ready: 0,
    insufficient: 0,
    skipped: 0,
  };

  for (let index = 0; index < publicReleases.length; index += BATCH_SIZE) {
    const response = await fetch("/api/listening-guides/backfill", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ releases: publicReleases.slice(index, index + BATCH_SIZE) }),
    });
    if (!response.ok) throw new Error("聆听指南缓存更新失败");
    const result = await response.json();
    for (const key of [
      "created",
      "existing",
      "identityUpdated",
      "ready",
      "insufficient",
      "skipped",
    ]) {
      summary[key] += Number(result[key] ?? 0);
    }
  }

  return summary;
}
