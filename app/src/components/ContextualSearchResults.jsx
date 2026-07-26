import { ChatCircleText, TextT } from "@phosphor-icons/react";
import { Cover } from "./ReleaseViews.jsx";

function excerptAroundMatch(text, query, maxLength = 180) {
  const value = String(text);
  if (value.length <= maxLength) return value;
  const matchIndex = value
    .toLocaleLowerCase()
    .indexOf(String(query).toLocaleLowerCase());
  if (matchIndex < 0) return `${value.slice(0, maxLength).trim()}…`;
  const start = Math.max(0, matchIndex - Math.floor(maxLength * 0.42));
  const end = Math.min(value.length, start + maxLength);
  return `${start > 0 ? "…" : ""}${value
    .slice(start, end)
    .trim()}${end < value.length ? "…" : ""}`;
}

function HighlightText({ text, query }) {
  const value = String(text);
  const escaped = String(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return value;
  const matcher = new RegExp(`(${escaped})`, "gi");
  return value.split(matcher).map((part, index) =>
    part.toLocaleLowerCase() === String(query).toLocaleLowerCase() ? (
      <mark key={`${part}-${index}`}>{part}</mark>
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    ),
  );
}

export function ContextualSearchResults({
  results,
  query,
  onOpen,
}) {
  if (!results.length) return null;
  return (
    <section className="context-search-section" aria-labelledby="context-search-title">
      <header>
        <div>
          <span className="eyebrow">间接命中</span>
          <h2 id="context-search-title">评论与其他文字</h2>
          <p>
            这些唱片的标题或艺人没有直接命中，但相关文字中提到了“
            {query}”。
          </p>
        </div>
        <span>{results.length} 张唱片</span>
      </header>
      <div className="context-search-grid">
        {results.map(({ release, matches }) => (
          <article className="context-search-card" key={release.id}>
            <button
              type="button"
              className="context-cover-button"
              onClick={() => onOpen(release.id)}
              aria-label={`打开 ${release.title}`}
            >
              <Cover release={release} />
            </button>
            <div className="context-search-body">
              <button
                type="button"
                className="context-release-title"
                onClick={() => onOpen(release.id)}
              >
                {release.title}
              </button>
              <span className="context-release-artist">
                {release.artists.join("、")}
              </span>
              <div className="context-match-list">
                {matches.slice(0, 3).map((match) => {
                  const excerpt = excerptAroundMatch(match.text, query);
                  const Icon =
                    match.kind === "COMMENT" ? ChatCircleText : TextT;
                  return (
                    <div className="context-match" key={match.key}>
                      <span className="context-match-label">
                        <Icon aria-hidden="true" />
                        {match.label}
                      </span>
                      <p>
                        <HighlightText text={excerpt} query={query} />
                      </p>
                    </div>
                  );
                })}
                {matches.length > 3 ? (
                  <span className="context-more">
                    另有 {matches.length - 3} 处文字命中
                  </span>
                ) : null}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
