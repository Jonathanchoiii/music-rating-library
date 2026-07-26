import { useEffect, useState } from "react";
import { Plus, X } from "@phosphor-icons/react";
import { getDatePrecision, normalizeReleaseType } from "../lib/music.js";
import { RatingInput } from "./Rating.jsx";

const blankForm = {
  title: "",
  artists: "",
  releaseType: "LP",
  releaseDate: "",
  genres: "",
  coverUrl: "",
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
      externalLinks: [],
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
