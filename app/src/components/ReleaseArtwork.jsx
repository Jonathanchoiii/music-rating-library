import { useEffect, useState } from "react";
import { coverDisplaySrc } from "../lib/coverStatus.js";
import { isMotionArtworkEnabled } from "../lib/motionArtwork.js";

export function ReleaseArtwork({
  release,
  active = false,
  userRequested = false,
  className = "",
  onLoad,
  onStaticError,
}) {
  const [motionFailed, setMotionFailed] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const motionUrl = isMotionArtworkEnabled(release)
    ? release.motionArtwork.localUrl
    : "";
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    setMotionFailed(false);
    setCoverFailed(false);
  }, [release.id, release.coverUrl, release.coverMatchedAt, motionUrl]);

  const shouldShowMotion =
    motionUrl && active && (!reducedMotion || userRequested) && !motionFailed;

  if (shouldShowMotion) {
    return (
      <img
        className={`release-cover release-motion-artwork ${className}`}
        src={motionUrl}
        alt={`${release.artists.join("、")}《${release.title}》动态封面`}
        onLoad={onLoad}
        onError={() => setMotionFailed(true)}
      />
    );
  }

  const coverSrc = coverDisplaySrc(release);
  return coverSrc && !coverFailed ? (
    <img
      className={`release-cover ${className}`}
      src={coverSrc}
      alt={`${release.artists.join("、")}《${release.title}》封面`}
      loading="lazy"
      onLoad={onLoad}
      onError={() => {
        setCoverFailed(true);
        onStaticError?.();
      }}
    />
  ) : (
    <span className={`release-cover cover-placeholder ${className}`}>
      <span>{release.title.slice(0, 1).toUpperCase()}</span>
    </span>
  );
}
