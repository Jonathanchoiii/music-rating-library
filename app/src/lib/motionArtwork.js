export const CURRENT_MOTION_ARTWORK_PROFILE_VERSION = 2;

export function hasLocalMotionArtwork(release) {
  const artwork = release?.motionArtwork;
  return Boolean(
    artwork?.status === "AVAILABLE" &&
      artwork?.storage === "LOCAL_WEBP" &&
      artwork?.localUrl,
  );
}

export function motionArtworkNeedsUpgrade(release) {
  if (!hasLocalMotionArtwork(release)) return false;
  return (
    Number(release.motionArtwork.profileVersion ?? 1) <
    CURRENT_MOTION_ARTWORK_PROFILE_VERSION
  );
}

export function isMotionArtworkEnabled(release) {
  return hasLocalMotionArtwork(release) && release.motionArtwork.enabled !== false;
}

export function setMotionArtworkEnabled(motionArtwork, enabled) {
  return {
    ...motionArtwork,
    enabled: Boolean(enabled),
    preferenceUpdatedAt: new Date().toISOString(),
  };
}

export async function convertMotionArtworkToWebp(
  release,
  sourceUrl,
  onProgress = () => {},
) {
  onProgress("正在生成清晰版动态 WebP（最高 960px，超限自动回退）…");
  const response = await fetch("/api/apple-motion-artwork/convert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ releaseId: release.id, sourceUrl }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "DYNAMIC_ARTWORK_WRITE_FAILED");
    error.detail = payload.detail;
    throw error;
  }
  return payload.motionArtwork;
}
