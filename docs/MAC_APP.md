# RecordShelf macOS 本地应用

RecordShelf 的 macOS 包装版会把当前 `.private/neodb-library.local.json`
作为本地初始资料构建进应用。公开 Web 构建与 GitHub 仓库仍不包含这份资料。

## 构建

在 `app/` 目录执行：

```bash
npm run build:desktop
```

输出：

- `app/desktop-release/mac-arm64/RecordShelf.app`
- `app/desktop-release/RecordShelf-0.1.2-arm64.dmg`

生成的 `.app` 与 DMG 包含构建当时的私人音乐资料，不要公开上传或分享。

## 使用与资料

- 双击 `RecordShelf.app` 即可启动，不需要打开 Codex。
- 应用使用本机临时签名，适合当前 Mac 直接运行；它没有 Apple Developer
  公证，不应作为面向公众分发的安装包。
- 应用使用固定本地地址 `http://127.0.0.1:4173`，兼容已有本地资料和
  NeoDB OAuth 回调。
- Web 和 Mac 应用共同读写：
  `~/Library/Application Support/RecordShelf/shared-local-state.json`。
  删除、手动合并、疑似重复条目取舍、艺人映射、筛选和安全的同步状态都会
  在两端恢复；NeoDB 登录 token 不会写入该文件。
- 两端修改按稳定 ID 三方合并；同一字段冲突时保留共享文件里更新更晚的值，
  删除和人工取舍不会被旧端复活。每次写入前自动保存上一 revision，滚动保留
  最近 20 份私有恢复快照。
- 从旧版升级时，应用会自动迁移已有 Web 增量。历史上使用过 `5173` 的资料
  也可通过在该端口加载新版一次并入同一共享文件。
- 窗口顶部保留可拖拽区域，可按住顶部空白处移动 Mac 窗口。
- 更新代码或基础数据库后，重新执行 `npm run build:desktop` 生成新版应用。
- 升级前建议先在“设置”中导出完整 JSON，并备份上述共享状态文件。
