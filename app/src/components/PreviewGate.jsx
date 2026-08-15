import { useState } from "react";
import { loginRemotePreview } from "../lib/remotePreview.js";

const MESSAGES = {
  login: "这是你的私人只读档案。输入预览密码后继续。",
  setup: "还没有配置预览密码。请先在 Vercel 或本机 Application Support 里设置 RECORDSHELF_PREVIEW_PASSWORD。",
  empty: "Mac 还没有上传成功的快照。请在电脑上运行 npm run remote-preview:sync 或打开设置里的「同步到手机预览」。",
  error: "暂时无法读取远程快照。请确认 Vercel Blob 已配置，并在 Mac 上重新同步一次。",
};

export function PreviewGate({ status = "login", onReady }) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      await loginRemotePreview(password);
      onReady?.();
    } catch {
      setMessage("密码不正确。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="preview-gate">
      <img src="/recordshelf-logo.png" alt="" width="48" height="48" />
      <p className="eyebrow">RecordShelf</p>
      <h1>只读预览</h1>
      <p>{MESSAGES[status] ?? MESSAGES.login}</p>
      {status === "login" ? (
        <form onSubmit={submit}>
          <label htmlFor="preview-password">预览密码</label>
          <input
            id="preview-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? "正在进入" : "进入档案"}
          </button>
          {message ? <p className="preview-gate-error">{message}</p> : null}
        </form>
      ) : null}
    </main>
  );
}
