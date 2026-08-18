import {
  ArrowClockwise,
  ArrowSquareOut,
  Plus,
  SpinnerGap,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";

const SUPPORTED_RATING_HOSTS = new Map([
  ["music.douban.com", "DOUBAN"],
  ["albumoftheyear.org", "AOTY"],
  ["www.albumoftheyear.org", "AOTY"],
  ["rateyourmusic.com", "RATEYOURMUSIC"],
  ["www.rateyourmusic.com", "RATEYOURMUSIC"],
  ["metacritic.com", "METACRITIC"],
  ["www.metacritic.com", "METACRITIC"],
  ["record.club", "RECORD_CLUB"],
  ["www.record.club", "RECORD_CLUB"],
]);

const PROVIDER_LABELS = {
  AOTY: "AOTY",
  RATEYOURMUSIC: "Rate Your Music",
  METACRITIC: "Metacritic",
  RECORD_CLUB: "Record Club",
  DOUBAN: "豆瓣",
};

const RATING_LINK_HINT =
  "请填写豆瓣、AOTY、Rate Your Music、Metacritic 或 Record Club 的 HTTPS 专辑页链接";

function compactCount(value) {
  if (!Number.isFinite(value)) return "";
  return new Intl.NumberFormat("zh-CN", { notation: "compact" }).format(value);
}

function formatCheckedAt(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatScore(score, scale) {
  if (!Number.isFinite(Number(score))) return "";
  return scale === 100
    ? String(Math.round(Number(score)))
    : Number(score).toFixed(1);
}

function refreshResultMessage(payload, options = {}) {
  const ratings = payload?.externalRatings;
  const savedLinks = ratings?.links ?? [];
  const sources = ratings?.sources ?? [];
  const blocked = ratings?.blockedProviders ?? [];
  const addedProvider = options.addingProvider ?? null;
  const addedLink = addedProvider
    ? savedLinks.find((link) => link.provider === addedProvider)
    : null;

  if (options.adding && !addedLink) {
    return RATING_LINK_HINT;
  }
  if (blocked.length) {
    const labels = blocked
      .map((provider) => PROVIDER_LABELS[provider] ?? provider)
      .join("、");
    return sources.length
      ? `${labels} 暂时无法读取（可能被站点拦截），已保留上次分数`
      : `${labels} 暂时无法读取（可能被站点拦截），请稍后重试或在浏览器打开链接查看`;
  }
  if (addedLink?.status === "LINK_SAVED") {
    return "链接已保存；该平台目前没有可供本地应用自动取分的公开接口";
  }
  if (sources.length) return "";
  return "没有找到与当前发行完全匹配的公开评分";
}

export function ExternalRatings({ release, onApply }) {
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [ratingUrl, setRatingUrl] = useState("");
  const [message, setMessage] = useState("");
  const ratings = release.externalRatings;
  const sources = Array.isArray(ratings?.sources) ? ratings.sources : [];
  const links = Array.isArray(ratings?.links) ? ratings.links : [];
  const checkedAt = formatCheckedAt(ratings?.checkedAt);

  useEffect(() => {
    setRefreshing(false);
    setAdding(false);
    setRatingUrl("");
    setMessage("");
  }, [release.id]);

  async function refresh(nextLinks = links, options = {}) {
    if (refreshing) return;
    setRefreshing(true);
    setMessage(options.adding ? "正在保存链接并读取可用评分…" : "正在核对已保存的平台评分…");
    try {
      const response = await fetch("/api/external-ratings/refresh", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          release: {
            id: release.id,
            title: release.title,
            translatedTitle: release.translatedTitle,
            titleAliases: release.titleAliases,
            artists: release.artists,
            releaseDate: release.releaseDate,
            externalLinks: (release.externalLinks ?? []).filter((link) =>
              ["NEODB", "DOUBAN", "AOTY", "RATEYOURMUSIC"].includes(
                link.provider,
              ),
            ),
            ratingLinks: nextLinks,
            externalRatings: release.externalRatings,
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "EXTERNAL_RATINGS_UNAVAILABLE");
      onApply?.(release.id, payload.externalRatings);
      setAdding(false);
      setRatingUrl("");
      setMessage(refreshResultMessage(payload, options));
    } catch (error) {
      const labels = {
        NEODB_LINK_REQUIRED: "请先添加这张发行的精确 NeoDB 链接，或粘贴评分平台专辑页链接",
        NEODB_CATALOG_UNAVAILABLE: "NeoDB 暂时无法读取，请稍后重试",
        EXTERNAL_RATINGS_UNAVAILABLE: "平台评分暂时无法读取，请稍后重试",
      };
      setMessage(labels[error.message] ?? "平台评分暂时无法读取，请稍后重试");
    } finally {
      setRefreshing(false);
    }
  }

  function submitRatingLink(event) {
    event.preventDefault();
    const value = ratingUrl.trim();
    let provider;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || !SUPPORTED_RATING_HOSTS.has(parsed.hostname)) {
        throw new Error("UNSUPPORTED");
      }
      provider = SUPPORTED_RATING_HOSTS.get(parsed.hostname);
    } catch {
      setMessage(RATING_LINK_HINT);
      return;
    }
    refresh([...links, { url: value }], { adding: value, addingProvider: provider });
  }

  const sourceProviders = new Set(sources.map((source) => source.provider));
  const savedOnlyLinks = links.filter((link) => !sourceProviders.has(link.provider));

  return (
    <section className="external-ratings" aria-labelledby={`external-ratings-${release.id}`}>
      <header>
        <div>
          <h3 id={`external-ratings-${release.id}`}>平台评分</h3>
          <p>
            独立于你的评分 · {checkedAt ? `更新于 ${checkedAt}` : "仅按需读取精确关联条目"}
          </p>
        </div>
        <div className="external-ratings-actions">
          {onApply ? (
            <>
          <button
            type="button"
            className="external-ratings-refresh"
            onClick={() => {
              setAdding((current) => !current);
              setMessage("");
            }}
            disabled={refreshing}
            aria-label="添加评分平台链接"
            title="添加评分平台链接"
          >
            <Plus aria-hidden="true" />
          </button>
          <button
            type="button"
            className="external-ratings-refresh"
            onClick={() => refresh()}
            disabled={refreshing}
            aria-label={sources.length || links.length ? "更新平台评分" : "获取平台评分"}
            title={sources.length || links.length ? "更新平台评分" : "获取平台评分"}
          >
            {refreshing ? (
              <SpinnerGap className="spin" aria-hidden="true" />
            ) : (
              <ArrowClockwise aria-hidden="true" />
            )}
          </button>
            </>
          ) : null}
        </div>
      </header>
      {onApply && adding ? (
        <form className="external-rating-link-editor" onSubmit={submitRatingLink}>
          <label htmlFor={`external-rating-url-${release.id}`}>评分页链接</label>
          <div>
            <input
              id={`external-rating-url-${release.id}`}
              type="url"
              inputMode="url"
              value={ratingUrl}
              onChange={(event) => setRatingUrl(event.target.value)}
              placeholder="粘贴豆瓣、AOTY、RYM、Metacritic 或 Record Club 链接"
              autoFocus
              required
            />
            <button type="submit" className="secondary-button" disabled={refreshing}>
              添加并取分
            </button>
          </div>
        </form>
      ) : null}
      {sources.length ? (
        <div className="external-rating-list">
          {sources.map((source) => {
            const isAoty =
              source.provider === "AOTY" &&
              (source.criticScore != null || source.userScore != null);
            const ariaScore = isAoty
              ? [
                  source.criticScore != null
                    ? `媒体 ${formatScore(source.criticScore, 100)}`
                    : null,
                  source.userScore != null
                    ? `用户 ${formatScore(source.userScore, 100)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join("，")
              : `${formatScore(source.score, source.scale)} 分`;
            return (
              <a
                key={`${source.provider}-${source.url}`}
                className={`external-rating-card is-${source.provider.toLocaleLowerCase()}${isAoty ? " is-split" : ""}`}
                href={source.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`${source.providerLabel} ${ariaScore}，查看原页面`}
              >
                <span className="external-rating-brand" aria-hidden="true">
                  {source.provider === "DOUBAN" ? "豆瓣" : source.providerLabel}
                </span>
                {isAoty ? (
                  <span className="external-rating-split">
                    {source.criticScore != null ? (
                      <span>
                        <small>媒体</small>
                        <strong>{formatScore(source.criticScore, 100)}</strong>
                      </span>
                    ) : null}
                    {source.userScore != null ? (
                      <span>
                        <small>用户</small>
                        <strong>{formatScore(source.userScore, 100)}</strong>
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <strong>{formatScore(source.score, source.scale)}</strong>
                )}
                {source.ratingCount != null ? (
                  <small>{compactCount(source.ratingCount)} 人评分</small>
                ) : (
                  <small />
                )}
                <ArrowSquareOut aria-hidden="true" />
              </a>
            );
          })}
        </div>
      ) : null}
      {savedOnlyLinks.length ? (
        <div className="external-rating-link-list" aria-label="已保存的评分平台链接">
          {savedOnlyLinks.map((link) => (
            <a key={`${link.provider}-${link.url}`} href={link.url} target="_blank" rel="noreferrer">
              <span>{link.providerLabel}</span>
              <small>
                {link.status === "NO_SCORE_FOUND"
                  ? "未读取到评分"
                  : link.status === "SCORE_BLOCKED"
                    ? "读取被拦截"
                    : "已保存链接"}
              </small>
              <ArrowSquareOut aria-hidden="true" />
            </a>
          ))}
        </div>
      ) : null}
      {message ? <p className="external-ratings-message">{message}</p> : null}
    </section>
  );
}
