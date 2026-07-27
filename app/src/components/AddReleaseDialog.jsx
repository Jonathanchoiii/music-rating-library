import { useEffect, useState } from "react";
import { Plus, X } from "@phosphor-icons/react";
import {
  buildConfirmedExternalLinks,
  getDatePrecision,
  normalizeReleaseType,
} from "../lib/music.js";
import { RatingInput } from "./Rating.jsx";

const blankForm = {
  title: "",
  artists: "",
  releaseType: "LP",
  releaseDate: "",
  genres: "",
  coverUrl: "",
  neodbUrl: "",
  spotifyUrl: "",
  appleMusicUrl: "",
  listenedAt: new Date().toISOString().slice(0, 10),
  rating10: "",
  comment: "",
};

export function AddReleaseDialog({
  mode = "release",
  release,
  onClose,
  onSaveRelease,
  onSaveListening,
}) {
  const [form, setForm] = useState(blankForm);
  const [linkErrors, setLinkErrors] = useState({});

  useEffect(() => {
    if (mode === "listening") {
      setForm((current) => ({
        ...current,
        title: release?.title ?? "",
        artists: release?.artists?.join("; ") ?? "",
      }));
    }
  }, [mode, release]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    if (linkErrors[field]) {
      setLinkErrors((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
    }
  }

  function submit(event) {
    event.preventDefault();
    const now = new Date().toISOString();
    const entry = {
      id: `entry-${crypto.randomUUID()}`,
      listenedAt: form.listenedAt || null,
      listenedAtPrecision: getDatePrecision(form.listenedAt),
      ratedAt: form.rating10 ? now : null,
      rating10: form.rating10 ? Number(form.rating10) : null,
      comment: form.comment.trim() || null,
      source: "MANUAL",
      sourceUrl: null,
      markedAt: now,
      createdAt: now,
    };
    if (mode === "listening") {
      onSaveListening(release.id, entry);
      return;
    }
    const linkResult = buildConfirmedExternalLinks(form);
    setLinkErrors(linkResult.errors);
    if (Object.keys(linkResult.errors).length) return;
    onSaveRelease({
      id: `release-${crypto.randomUUID()}`,
      title: form.title.trim(),
      artists: form.artists
        .split(";")
        .map((artist) => artist.trim())
        .filter(Boolean),
      releaseType: normalizeReleaseType(form.releaseType),
      releaseDate: form.releaseDate || null,
      releaseDatePrecision: getDatePrecision(form.releaseDate),
      genres: form.genres
        .split(";")
        .map((genre) => genre.trim())
        .filter(Boolean),
      ...(form.genres.trim()
        ? { genreSource: "USER_CONFIRMED" }
        : {}),
      coverUrl: form.coverUrl.trim() || null,
      isPrivate: false,
      externalLinks: linkResult.externalLinks,
      listeningEntries: [entry],
    });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="form-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">
              {mode === "listening" ? "历史不会被覆盖" : "快速建立档案"}
            </span>
            <h2 id="add-dialog-title">
              {mode === "listening" ? `再次听《${release?.title}》` : "添加一张唱片"}
            </h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X aria-hidden="true" />
            <span className="sr-only">关闭</span>
          </button>
        </header>
        <form onSubmit={submit}>
          {mode === "release" ? (
            <>
              <label>
                发行标题 *
                <input
                  required
                  value={form.title}
                  onChange={(event) => update("title", event.target.value)}
                  placeholder="例如：Vespertine"
                />
              </label>
              <label>
                艺人 *
                <input
                  required
                  value={form.artists}
                  onChange={(event) => update("artists", event.target.value)}
                  placeholder="多位艺人用 ; 分隔"
                />
              </label>
              <div className="form-grid">
                <label>
                  类型
                  <select
                    value={form.releaseType}
                    onChange={(event) =>
                      update("releaseType", event.target.value)
                    }
                  >
                    {[
                      "LP",
                      "EP",
                      "SINGLE",
                      "COMPILATION",
                      "MIXTAPE",
                      "LIVE",
                      "SOUNDTRACK",
                      "OTHER",
                    ].map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                </label>
                <label>
                  发行日期
                  <input
                    value={form.releaseDate}
                    onChange={(event) =>
                      update("releaseDate", event.target.value)
                    }
                    placeholder="YYYY / YYYY-MM / YYYY-MM-DD"
                  />
                </label>
              </div>
              <label>
                流派
                <input
                  value={form.genres}
                  onChange={(event) => update("genres", event.target.value)}
                  placeholder="多个流派用 ; 分隔"
                />
              </label>
              <label>
                封面 URL
                <input
                  type="url"
                  value={form.coverUrl}
                  onChange={(event) => update("coverUrl", event.target.value)}
                  placeholder="https://"
                />
              </label>
              <fieldset className="platform-link-fields">
                <legend>平台链接（可选）</legend>
                <p>
                  填写精确条目或专辑地址，保存后会直接显示在发行详情页。
                </p>
                <label>
                  NeoDB 链接
                  <input
                    type="url"
                    inputMode="url"
                    value={form.neodbUrl}
                    onChange={(event) =>
                      update("neodbUrl", event.target.value)
                    }
                    placeholder="https://neodb.social/album/…"
                    aria-invalid={Boolean(linkErrors.neodbUrl)}
                    aria-describedby={
                      linkErrors.neodbUrl
                        ? "add-neodb-link-error"
                        : undefined
                    }
                  />
                  {linkErrors.neodbUrl ? (
                    <span
                      className="form-field-error"
                      id="add-neodb-link-error"
                      role="alert"
                    >
                      {linkErrors.neodbUrl}
                    </span>
                  ) : null}
                </label>
                <label>
                  Spotify 专辑链接
                  <input
                    type="url"
                    inputMode="url"
                    value={form.spotifyUrl}
                    onChange={(event) =>
                      update("spotifyUrl", event.target.value)
                    }
                    placeholder="https://open.spotify.com/album/…"
                    aria-invalid={Boolean(linkErrors.spotifyUrl)}
                    aria-describedby={
                      linkErrors.spotifyUrl
                        ? "add-spotify-link-error"
                        : undefined
                    }
                  />
                  {linkErrors.spotifyUrl ? (
                    <span
                      className="form-field-error"
                      id="add-spotify-link-error"
                      role="alert"
                    >
                      {linkErrors.spotifyUrl}
                    </span>
                  ) : null}
                </label>
                <label>
                  Apple Music 专辑链接
                  <input
                    type="url"
                    inputMode="url"
                    value={form.appleMusicUrl}
                    onChange={(event) =>
                      update("appleMusicUrl", event.target.value)
                    }
                    placeholder="https://music.apple.com/…/album/…"
                    aria-invalid={Boolean(linkErrors.appleMusicUrl)}
                    aria-describedby={
                      linkErrors.appleMusicUrl
                        ? "add-apple-link-error"
                        : undefined
                    }
                  />
                  {linkErrors.appleMusicUrl ? (
                    <span
                      className="form-field-error"
                      id="add-apple-link-error"
                      role="alert"
                    >
                      {linkErrors.appleMusicUrl}
                    </span>
                  ) : null}
                </label>
              </fieldset>
            </>
          ) : null}
          <label>
            听歌日期
            <input
              type="date"
              value={form.listenedAt}
              onChange={(event) => update("listenedAt", event.target.value)}
            />
          </label>
          <RatingInput
            value={form.rating10}
            onChange={(value) => update("rating10", value)}
          />
          <label>
            当时的评论
            <textarea
              rows="4"
              value={form.comment}
              onChange={(event) => update("comment", event.target.value)}
              placeholder="这一刻听到了什么？"
            />
          </label>
          <footer>
            <button type="button" className="secondary-button" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="primary-button">
              <Plus aria-hidden="true" />
              {mode === "listening" ? "保存这次收听" : "添加唱片"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
