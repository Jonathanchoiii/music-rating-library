import { useEffect, useMemo, useState } from "react";
import {
  CalendarBlank,
  Check,
  Funnel,
  MagnifyingGlass,
  SlidersHorizontal,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import { groupReleasesByArtistIdentity } from "../lib/artists.js";
import {
  EMPTY_LIBRARY_FILTERS,
  activeFilterCount,
  collectTrustedFacetOptions,
  filterReleases,
  sanitizeLibraryFilters,
} from "../lib/filters.js";
import { normalizeText } from "../lib/music.js";

const RELEASE_TYPE_OPTIONS = [
  ["LP", "LP"],
  ["EP", "EP"],
  ["SINGLE", "Single"],
  ["OTHER", "未分类"],
];

const MARK_STATUS_OPTIONS = [
  ["complete", "听过"],
  ["progress", "在听"],
  ["wishlist", "想听"],
  ["dropped", "搁置"],
];

const PLATFORM_OPTIONS = [
  ["APPLE_MUSIC", "Apple Music"],
  ["SPOTIFY", "Spotify"],
  ["NEODB", "NeoDB"],
  ["NO_STREAMING", "无流媒体链接"],
];

const COMPLETENESS_OPTIONS = [
  ["MISSING_DATE", "缺发行日期"],
  ["MISSING_TYPE", "未分类"],
  ["MISSING_COVER", "缺封面"],
  ["MISSING_STREAMING", "缺流媒体链接"],
  ["MISSING_GENRE", "缺流派"],
  ["MISSING_LANGUAGE", "缺目录语言"],
];

const CONFIDENCE_OPTIONS = [
  ["VERIFIED", "有精确信源"],
  ["USER_CONFIRMED", "含用户确认"],
  ["NEEDS_REVIEW", "有待核验字段"],
];

const FACET_CONFIGS = [
  ["genres", "流派", "宽泛分类，如 Pop、Rock、Electronic"],
  ["styles", "风格", "细分风格，如 Dream Pop、Synth-pop"],
  ["catalogLanguages", "目录语言", "只表示标题与曲目标题语言，不代表歌词语种"],
  ["editionTypes", "版本属性", "Deluxe、Live、Remix、Compilation 等"],
  ["releaseCountries", "发行地区", "该版本的发行市场，不是艺人国籍"],
  ["labels", "厂牌", "精确发行版本对应的唱片厂牌"],
  ["mediaFormats", "介质", "Digital、CD、Vinyl、Cassette 等精确版本介质"],
];

function toggleValue(values, value) {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

function FilterChoices({ options, selected, onToggle, emptyText }) {
  if (!options.length) {
    return (
      <p className="filter-empty-evidence">
        <Sparkle aria-hidden="true" />
        {emptyText}
      </p>
    );
  }
  return (
    <div className="filter-choice-grid">
      {options.map(([value, label, count]) => {
        const active = selected.includes(value);
        return (
          <button
            type="button"
            key={value}
            className={active ? "is-active" : ""}
            onClick={() => onToggle(value)}
          >
            <span className="filter-choice-check">
              {active ? <Check weight="bold" aria-hidden="true" /> : null}
            </span>
            <span>{label}</span>
            {count != null ? <small>{count}</small> : null}
          </button>
        );
      })}
    </div>
  );
}

function DateRange({ label, from, to, onChange }) {
  return (
    <div className="filter-date-range">
      <span>{label}</span>
      <label>
        <span className="sr-only">{label}开始日期</span>
        <input
          type="date"
          value={from}
          onChange={(event) => onChange("from", event.target.value)}
        />
      </label>
      <em>至</em>
      <label>
        <span className="sr-only">{label}结束日期</span>
        <input
          type="date"
          value={to}
          onChange={(event) => onChange("to", event.target.value)}
        />
      </label>
    </div>
  );
}

export function FilterDrawer({
  open,
  releases,
  filters,
  artistIdentityState,
  onApply,
  onClose,
}) {
  const [draft, setDraft] = useState(() =>
    sanitizeLibraryFilters(filters),
  );
  const [artistSearch, setArtistSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    setDraft(sanitizeLibraryFilters(filters));
    setArtistSearch("");
  }, [filters, open]);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const artistGroups = useMemo(
    () => groupReleasesByArtistIdentity(releases, artistIdentityState),
    [artistIdentityState, releases],
  );
  const visibleArtists = artistGroups
    .filter((group) => {
      const query = normalizeText(artistSearch);
      return (
        !query ||
        normalizeText(group.artist).includes(query) ||
        group.aliases.some((alias) => normalizeText(alias).includes(query))
      );
    })
    .filter(
      (group, index) =>
        index < 16 || draft.artistIds.includes(group.id),
    );
  const facetOptions = useMemo(
    () =>
      Object.fromEntries(
        FACET_CONFIGS.map(([field]) => [
          field,
          collectTrustedFacetOptions(releases, field),
        ]),
      ),
    [releases],
  );
  const previewCount = useMemo(
    () => filterReleases(releases, draft, artistIdentityState).length,
    [artistIdentityState, draft, releases],
  );

  if (!open) return null;

  function update(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function updateArray(field, value) {
    setDraft((current) => ({
      ...current,
      [field]: toggleValue(current[field], value),
    }));
  }

  return (
    <div
      className="filter-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <aside
        className="filter-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="filter-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="filter-drawer-header">
          <div>
            <span className="eyebrow">组合筛选</span>
            <h2 id="filter-title">筛选音乐库</h2>
            <p>同一维度内满足任一项，不同维度之间同时满足。</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭筛选"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="filter-drawer-body">
          <details open>
            <summary>
              <CalendarBlank aria-hidden="true" />
              时间
            </summary>
            <div className="filter-section-body">
              <DateRange
                label="发行时间"
                from={draft.releaseDateFrom}
                to={draft.releaseDateTo}
                onChange={(edge, value) =>
                  update(
                    edge === "from" ? "releaseDateFrom" : "releaseDateTo",
                    value,
                  )
                }
              />
              <DateRange
                label="标记时间"
                from={draft.markedDateFrom}
                to={draft.markedDateTo}
                onChange={(edge, value) =>
                  update(
                    edge === "from" ? "markedDateFrom" : "markedDateTo",
                    value,
                  )
                }
              />
              <div className="filter-listened-heading">
                <span>听过时间</span>
                <select
                  value={draft.listenedDateMode}
                  onChange={(event) =>
                    update("listenedDateMode", event.target.value)
                  }
                >
                  <option value="LATEST">最近一次</option>
                  <option value="FIRST">第一次</option>
                </select>
              </div>
              <DateRange
                label=""
                from={draft.listenedDateFrom}
                to={draft.listenedDateTo}
                onChange={(edge, value) =>
                  update(
                    edge === "from"
                      ? "listenedDateFrom"
                      : "listenedDateTo",
                    value,
                  )
                }
              />
              <p className="filter-helper">
                启用日期范围后，没有对应日期的唱片会被排除。
              </p>
            </div>
          </details>

          <details open>
            <summary>
              <SlidersHorizontal aria-hidden="true" />
              档案字段
            </summary>
            <div className="filter-section-body">
              <div className="filter-field-block">
                <div className="filter-field-label">
                  <strong>艺人</strong>
                  <span>{draft.artistIds.length || "不限"}</span>
                </div>
                <label className="filter-artist-search">
                  <MagnifyingGlass aria-hidden="true" />
                  <input
                    value={artistSearch}
                    onChange={(event) => setArtistSearch(event.target.value)}
                    placeholder="搜索艺人或别名"
                  />
                </label>
                <FilterChoices
                  options={visibleArtists.map((group) => [
                    group.id,
                    group.artist,
                    group.releases.length,
                  ])}
                  selected={draft.artistIds}
                  onToggle={(value) => updateArray("artistIds", value)}
                  emptyText="没有找到匹配的艺人。"
                />
              </div>

              <div className="filter-field-block">
                <strong>专辑类型</strong>
                <FilterChoices
                  options={RELEASE_TYPE_OPTIONS}
                  selected={draft.releaseTypes}
                  onToggle={(value) => updateArray("releaseTypes", value)}
                />
              </div>

              <div className="filter-field-block">
                <strong>收藏状态</strong>
                <FilterChoices
                  options={MARK_STATUS_OPTIONS}
                  selected={draft.markStatuses}
                  onToggle={(value) => updateArray("markStatuses", value)}
                />
              </div>

              <div className="filter-field-block">
                <strong>当前评分</strong>
                <div className="filter-rating-row">
                  <select
                    value={draft.ratingState}
                    onChange={(event) =>
                      update("ratingState", event.target.value)
                    }
                  >
                    <option value="ANY">全部</option>
                    <option value="RATED">已评分</option>
                    <option value="UNRATED">未评分</option>
                  </select>
                  <select
                    value={draft.ratingMin}
                    onChange={(event) =>
                      update("ratingMin", event.target.value)
                    }
                    disabled={draft.ratingState === "UNRATED"}
                    aria-label="最低评分"
                  >
                    <option value="">最低分</option>
                    {Array.from({ length: 10 }, (_, index) => index + 1).map(
                      (score) => (
                        <option key={score} value={score}>
                          {score}
                        </option>
                      ),
                    )}
                  </select>
                  <span>–</span>
                  <select
                    value={draft.ratingMax}
                    onChange={(event) =>
                      update("ratingMax", event.target.value)
                    }
                    disabled={draft.ratingState === "UNRATED"}
                    aria-label="最高评分"
                  >
                    <option value="">最高分</option>
                    {Array.from({ length: 10 }, (_, index) => index + 1).map(
                      (score) => (
                        <option key={score} value={score}>
                          {score}
                        </option>
                      ),
                    )}
                  </select>
                </div>
              </div>

              <div className="filter-field-block">
                <strong>评论</strong>
                <div className="filter-segmented">
                  {[
                    ["ANY", "全部"],
                    ["WITH_COMMENT", "有评论"],
                    ["WITHOUT_COMMENT", "无评论"],
                  ].map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      className={
                        draft.commentState === value ? "is-active" : ""
                      }
                      onClick={() => update("commentState", value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="filter-field-block">
                <strong>收听次数</strong>
                <select
                  className="filter-wide-select"
                  value={draft.listenCount}
                  onChange={(event) =>
                    update("listenCount", event.target.value)
                  }
                >
                  <option value="ANY">不限</option>
                  <option value="NONE">还没有听过</option>
                  <option value="ONE">1 次</option>
                  <option value="TWO_THREE">2–3 次</option>
                  <option value="FOUR_PLUS">4 次以上</option>
                </select>
              </div>
            </div>
          </details>

          <details>
            <summary>
              <Funnel aria-hidden="true" />
              平台与资料完整性
            </summary>
            <div className="filter-section-body">
              <div className="filter-field-block">
                <strong>平台链接</strong>
                <FilterChoices
                  options={PLATFORM_OPTIONS}
                  selected={draft.platforms}
                  onToggle={(value) => updateArray("platforms", value)}
                />
              </div>
              <div className="filter-field-block">
                <strong>需要整理</strong>
                <FilterChoices
                  options={COMPLETENESS_OPTIONS}
                  selected={draft.completeness}
                  onToggle={(value) => updateArray("completeness", value)}
                />
              </div>
              <div className="filter-field-block">
                <strong>数据可信度</strong>
                <FilterChoices
                  options={CONFIDENCE_OPTIONS}
                  selected={draft.confidence}
                  onToggle={(value) => updateArray("confidence", value)}
                />
              </div>
            </div>
          </details>

          <details>
            <summary>
              <Sparkle aria-hidden="true" />
              已核验的外部资料
            </summary>
            <div className="filter-section-body">
              <p className="filter-evidence-note">
                这里只使用已有精确信源或用户确认的数据。没有依据的字段保持为空，
                不会从标题、标签或艺人国籍自动推断。
              </p>
              {FACET_CONFIGS.map(([field, label, description]) => (
                <div className="filter-field-block" key={field}>
                  <div className="filter-field-label">
                    <span>
                      <strong>{label}</strong>
                      <small>{description}</small>
                    </span>
                    <em>{facetOptions[field].length || "暂无"}</em>
                  </div>
                  <FilterChoices
                    options={facetOptions[field].map((option) => [
                      option.value,
                      option.value,
                      option.count,
                    ])}
                    selected={draft[field]}
                    onToggle={(value) => updateArray(field, value)}
                    emptyText={`暂无已核验的${label}数据，不会自动猜测。`}
                  />
                </div>
              ))}
            </div>
          </details>
        </div>

        <footer className="filter-drawer-footer">
          <button
            type="button"
            className="filter-clear-button"
            onClick={() => setDraft(sanitizeLibraryFilters())}
            disabled={!activeFilterCount(draft)}
          >
            清除全部
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => onApply(sanitizeLibraryFilters(draft))}
          >
            显示 {previewCount} 张唱片
          </button>
        </footer>
      </aside>
    </div>
  );
}

function FilterChip({ children, onRemove }) {
  return (
    <button type="button" onClick={onRemove}>
      <span>{children}</span>
      <X aria-hidden="true" />
    </button>
  );
}

export function ActiveFilterChips({
  filters,
  artistIdentityState,
  releases,
  onChange,
  onOpen,
}) {
  const count = activeFilterCount(filters);
  const artistById = useMemo(
    () =>
      new Map(
        groupReleasesByArtistIdentity(releases, artistIdentityState).map(
          (group) => [group.id, group.artist],
        ),
      ),
    [artistIdentityState, releases],
  );
  if (!count) return null;

  function clearField(field) {
    onChange({ ...filters, [field]: EMPTY_LIBRARY_FILTERS[field] });
  }

  function removeArrayValue(field, value) {
    onChange({
      ...filters,
      [field]: filters[field].filter((item) => item !== value),
    });
  }

  const chips = [];
  if (filters.releaseDateFrom || filters.releaseDateTo) {
    chips.push(
      <FilterChip
        key="release-date"
        onRemove={() => {
          onChange({
            ...filters,
            releaseDateFrom: "",
            releaseDateTo: "",
          });
        }}
      >
        发行：{filters.releaseDateFrom || "最早"} →{" "}
        {filters.releaseDateTo || "现在"}
      </FilterChip>,
    );
  }
  if (filters.markedDateFrom || filters.markedDateTo) {
    chips.push(
      <FilterChip
        key="marked-date"
        onRemove={() => {
          onChange({
            ...filters,
            markedDateFrom: "",
            markedDateTo: "",
          });
        }}
      >
        标记：{filters.markedDateFrom || "最早"} →{" "}
        {filters.markedDateTo || "现在"}
      </FilterChip>,
    );
  }
  if (filters.listenedDateFrom || filters.listenedDateTo) {
    chips.push(
      <FilterChip
        key="listened-date"
        onRemove={() => {
          onChange({
            ...filters,
            listenedDateFrom: "",
            listenedDateTo: "",
          });
        }}
      >
        {filters.listenedDateMode === "FIRST" ? "首次听过" : "最近听过"}
      </FilterChip>,
    );
  }

  const arrayLabels = {
    releaseTypes: Object.fromEntries(RELEASE_TYPE_OPTIONS),
    markStatuses: Object.fromEntries(MARK_STATUS_OPTIONS),
    platforms: Object.fromEntries(PLATFORM_OPTIONS),
    completeness: Object.fromEntries(COMPLETENESS_OPTIONS),
    confidence: Object.fromEntries(CONFIDENCE_OPTIONS),
  };
  for (const field of Object.keys(arrayLabels)) {
    for (const value of filters[field]) {
      chips.push(
        <FilterChip
          key={`${field}-${value}`}
          onRemove={() => removeArrayValue(field, value)}
        >
          {arrayLabels[field][value] ?? value}
        </FilterChip>,
      );
    }
  }
  for (const artistId of filters.artistIds) {
    chips.push(
      <FilterChip
        key={artistId}
        onRemove={() => removeArrayValue("artistIds", artistId)}
      >
        {artistById.get(artistId) ?? "艺人"}
      </FilterChip>,
    );
  }
  for (const field of FACET_CONFIGS.map(([field]) => field)) {
    for (const value of filters[field]) {
      chips.push(
        <FilterChip
          key={`${field}-${value}`}
          onRemove={() => removeArrayValue(field, value)}
        >
          {value}
        </FilterChip>,
      );
    }
  }
  if (filters.ratingState !== "ANY") {
    chips.push(
      <FilterChip
        key="rating-state"
        onRemove={() => clearField("ratingState")}
      >
        {filters.ratingState === "RATED" ? "已评分" : "未评分"}
      </FilterChip>,
    );
  }
  if (filters.ratingMin !== "" || filters.ratingMax !== "") {
    chips.push(
      <FilterChip
        key="rating-range"
        onRemove={() =>
          onChange({ ...filters, ratingMin: "", ratingMax: "" })
        }
      >
        评分 {filters.ratingMin || "1"}–{filters.ratingMax || "10"}
      </FilterChip>,
    );
  }
  if (filters.commentState !== "ANY") {
    chips.push(
      <FilterChip
        key="comment"
        onRemove={() => clearField("commentState")}
      >
        {filters.commentState === "WITH_COMMENT" ? "有评论" : "无评论"}
      </FilterChip>,
    );
  }
  if (filters.listenCount !== "ANY") {
    chips.push(
      <FilterChip
        key="listen-count"
        onRemove={() => clearField("listenCount")}
      >
        {
          {
            NONE: "未听过",
            ONE: "听过 1 次",
            TWO_THREE: "听过 2–3 次",
            FOUR_PLUS: "听过 4 次以上",
          }[filters.listenCount]
        }
      </FilterChip>,
    );
  }

  return (
    <div className="active-filter-bar" aria-label="已应用筛选">
      <button
        type="button"
        className="active-filter-summary"
        onClick={onOpen}
      >
        <Funnel weight="fill" aria-hidden="true" />
        {count} 组筛选
      </button>
      <div>{chips}</div>
      <button
        type="button"
        className="active-filter-clear"
        onClick={() => onChange(sanitizeLibraryFilters())}
      >
        清除全部
      </button>
    </div>
  );
}
