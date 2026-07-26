import { Star, StarHalf } from "@phosphor-icons/react";
import { scoreToStars } from "../lib/music.js";

export function Rating({ score, compact = false }) {
  const stars = scoreToStars(score);
  if (stars == null) {
    return <span className="rating rating-empty">未评分</span>;
  }
  const full = Math.floor(stars);
  const half = stars % 1 !== 0;
  return (
    <span
      className={`rating ${compact ? "rating-compact" : ""}`}
      aria-label={`${score} 分（满分 10 分），${stars} 星`}
    >
      <span className="rating-score">{score.toFixed(1)}</span>
      <span className="rating-stars" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => {
          if (index < full) {
            return <Star key={index} weight="fill" />;
          }
          if (index === full && half) {
            return <StarHalf key={index} weight="fill" />;
          }
          return <Star key={index} weight="fill" className="star-muted" />;
        })}
      </span>
    </span>
  );
}

export function RatingInput({ value, onChange }) {
  return (
    <fieldset className="rating-input">
      <legend>评分（10 分制）</legend>
      <div className="rating-choice-grid">
        {Array.from({ length: 10 }, (_, index) => index + 1).map((score) => (
          <label
            key={score}
            className={Number(value) === score ? "is-selected" : ""}
          >
            <input
              type="radio"
              name="rating10"
              value={score}
              checked={Number(value) === score}
              onChange={() => onChange(score)}
            />
            <span>{score}</span>
          </label>
        ))}
      </div>
      <div className="rating-input-preview">
        {value ? <Rating score={Number(value)} /> : "选择 1–10 分"}
        {value ? (
          <button type="button" className="text-button" onClick={() => onChange("")}>
            清除评分
          </button>
        ) : null}
      </div>
    </fieldset>
  );
}
