import { useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  Check,
  FileCsv,
  UploadSimple,
  Warning,
  X,
} from "@phosphor-icons/react";
import {
  classifyImportedRelease,
  csvRowToRelease,
  detectHeaderMap,
  parseCsvFile,
} from "../lib/music.js";

const statusLabels = {
  READY: "可导入",
  WARNING: "有提醒",
  DUPLICATE: "疑似重复",
  INVALID: "无法导入",
};

export function ImportDialog({ releases, onClose, onCommit }) {
  const fileInput = useRef(null);
  const [fileName, setFileName] = useState("");
  const [headerMap, setHeaderMap] = useState(null);
  const [rawRows, setRawRows] = useState([]);
  const [parseErrors, setParseErrors] = useState([]);

  const preview = useMemo(() => {
    if (!headerMap) return [];
    return rawRows.map((row, index) =>
      classifyImportedRelease(
        csvRowToRelease(row, headerMap, index + 2),
        releases,
      ),
    );
  }, [rawRows, headerMap, releases]);

  const counts = useMemo(
    () =>
      preview.reduce((result, item) => {
        result[item.status] = (result[item.status] ?? 0) + 1;
        return result;
      }, {}),
    [preview],
  );

  async function handleFile(file) {
    if (!file) return;
    const result = await parseCsvFile(file);
    const headers = result.meta.fields ?? [];
    setFileName(file.name);
    setRawRows(result.data);
    setParseErrors(result.errors);
    setHeaderMap(detectHeaderMap(headers));
  }

  function commit() {
    const imported = preview
      .filter((item) => ["READY", "WARNING"].includes(item.status))
      .map((item) => item.release);
    const appendEntries = preview
      .filter((item) => item.status === "DUPLICATE" && item.duplicateOf)
      .map((item) => ({
        releaseId: item.duplicateOf,
        entry: item.release.listeningEntries[0],
      }));
    onCommit({ imported, appendEntries, fileName });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">先预览，再写入</span>
            <h2 id="import-title">导入 CSV</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X aria-hidden="true" />
            <span className="sr-only">关闭</span>
          </button>
        </header>
        {!rawRows.length ? (
          <button
            type="button"
            className="dropzone"
            onClick={() => fileInput.current?.click()}
          >
            <FileCsv aria-hidden="true" />
            <strong>选择 CSV 文件</strong>
            <span>支持 UTF-8、引号、逗号和评论换行</span>
          </button>
        ) : (
          <>
            <div className="import-summary">
              <div>
                <FileCsv aria-hidden="true" />
                <span>
                  <strong>{fileName}</strong>
                  {rawRows.length} 行 · 已自动识别字段
                </span>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={() => fileInput.current?.click()}
              >
                <ArrowCounterClockwise aria-hidden="true" />
                换一个文件
              </button>
            </div>
            <div className="status-strip">
              {Object.entries(statusLabels).map(([status, label]) => (
                <span className={`status-${status.toLowerCase()}`} key={status}>
                  {label} {counts[status] ?? 0}
                </span>
              ))}
            </div>
            {parseErrors.length ? (
              <div className="import-warning">
                <Warning aria-hidden="true" />
                CSV 解析器报告 {parseErrors.length} 个格式提醒，请检查预览。
              </div>
            ) : null}
            <div className="import-table-wrap">
              <table className="import-table">
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>发行</th>
                    <th>艺人</th>
                    <th>类型</th>
                    <th>评分</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.slice(0, 100).map((item, index) => (
                    <tr key={`${item.release.id}-${index}`}>
                      <td>
                        <span
                          className={`status-badge status-${item.status.toLowerCase()}`}
                        >
                          {statusLabels[item.status]}
                        </span>
                      </td>
                      <td>{item.release.title || "—"}</td>
                      <td>{item.release.artists.join("、") || "—"}</td>
                      <td>{item.release.releaseType}</td>
                      <td>
                        {item.release.listeningEntries[0].rating10 ?? "未评分"}
                      </td>
                      <td>
                        {[...item.errors, ...item.warnings].join("；") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(event) => handleFile(event.target.files?.[0])}
        />
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!preview.some((item) => item.status !== "INVALID")}
            onClick={commit}
          >
            {rawRows.length ? <Check aria-hidden="true" /> : <UploadSimple aria-hidden="true" />}
            导入 {preview.filter((item) => item.status !== "INVALID").length} 条
          </button>
        </footer>
      </section>
    </div>
  );
}
