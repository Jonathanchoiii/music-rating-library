import { ImageBroken } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { coverDisplayCandidates } from "../lib/coverStatus.js";
import { isMotionArtworkEnabled } from "../lib/motionArtwork.js";

function coverHue(release) {
  const key = `${release.title}${release.artists.join("")}`;
  return (
    [...key].reduce((sum, character) => sum + character.codePointAt(0), 0) % 360
  );
}

export function ReleaseArtwork({
  release,
  active = false,
  userRequested = false,
  className = "",
  onLoad,
  onStaticError,
}) {
  const [motionFailed, setMotionFailed] = useState(false);
  const [coverCandidateIndex, setCoverCandidateIndex] = useState(0);
  const motionUrl = isMotionArtworkEnabled(release)
    ? release.motionArtwork.localUrl
    : "";
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const coverCandidates = coverDisplayCandidates(release);

  useEffect(() => {
    setMotionFailed(false);
    setCoverCandidateIndex(0);
  }, [
    release.id,
    release.coverUrl,
    release.coverMatchedAt,
    release.coverRemoteUrl,
    motionUrl,
  ]);

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

  const coverSrc = coverCandidates[coverCandidateIndex] ?? "";
  return coverSrc ? (
    <img
      className={`release-cover ${className}`}
      src={coverSrc}
      alt={`${release.artists.join("、")}《${release.title}》封面`}
      loading="lazy"
      onLoad={onLoad}
      onError={() => {
        if (coverCandidateIndex + 1 < coverCandidates.length) {
          setCoverCandidateIndex((index) => index + 1);
          return;
        }
        onStaticError?.();
        setCoverCandidateIndex(coverCandidates.length);
      }}
    />
  ) : (
    <span
      className={`release-cover cover-placeholder ${className}`}
      aria-label={`${release.title} 暂无封面`}
      style={{ "--cover-hue": coverHue(release) }}
    >
      <ImageBroken aria-hidden="true" />
      <span>{release.title.slice(0, 1).toUpperCase()}</span>
    </span>
  );
}
