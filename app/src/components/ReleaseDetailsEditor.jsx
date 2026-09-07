import { useState } from "react";
import { buildReleaseDetailsPatch } from "../lib/releaseDetails.js";

export function ReleaseDetailsEditor({ release, onSave, onCancel }) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    const draft = Object.fromEntries(new FormData(event.currentTarget));
    setError("");
    try {
      const patch = buildReleaseDetailsPatch(release, draft);
      if (!Object.keys(patch).length) return onCancel();
      setSaving(true);
      await onSave(release.id, patch);
      onCancel();
    } catch (cause) {
      setError(cause.message || "资料未能保存，请重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form id="release-details-editor" className="release-details-editor" onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (!saving) onCancel();
        }
        if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
      }}>
      <h3>编辑资料</h3>
      <p>手动修改优先保留，后续同步不会覆盖。仅修改这张唱片的资料。</p>
      <fieldset disabled={saving}>
        <label>专辑名<input name="title" defaultValue={release.title} required maxLength={500} autoFocus /></label>
        <label>译名<input name="translatedTitle" defaultValue={release.translatedTitle ?? ""} maxLength={500} placeholder="可留空" /></label>
        <label className="release-details-wide">艺人名<textarea name="artists" defaultValue={(release.artists ?? []).join("\n")} required rows={2} maxLength={2000} aria-describedby="release-artists-help" />
          <small id="release-artists-help">多位艺人请换行填写，修改后会更新这张唱片的艺人归属。</small>
        </label>
        <label className="release-details-wide">发行时间<input name="releaseDate" defaultValue={release.releaseDate ?? ""} maxLength={10} placeholder="YYYY / YYYY-MM / YYYY-MM-DD" aria-describedby="release-date-help" />
          <small id="release-date-help">支持只填年份或年月；留空表示未知。</small>
        </label>
      </fieldset>
      {error ? <p className="form-field-error" role="alert">{error}</p> : null}
      <footer>
        <button type="button" className="secondary-button" onClick={onCancel} disabled={saving}>取消</button>
        <button type="submit" className="primary-button" disabled={saving}>{saving ? "正在保存…" : "保存修改"}</button>
      </footer>
    </form>
  );
}
