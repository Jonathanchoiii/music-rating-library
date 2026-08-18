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
- `app/desktop-release/RecordShelf-0.1.22-arm64.dmg`

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
- 手机在 Mac 关机后浏览需要只读网站快照，见
  [手机只读预览](PHONE_PREVIEW.md)。iCloud Drive 只作文件备份。
- 两端修改按稳定 ID 三方合并；同一字段冲突时保留共享文件里更新更晚的值，
  删除和人工取舍不会被旧端复活。每次写入前自动保存上一 revision，滚动保留
  最近 20 份私有恢复快照。
- 从旧版升级时，应用只迁移已确认的 `4173` Web 增量。历史 `5173` 状态已停用，
  不得再自动并入或覆盖当前共享文件。
- 窗口顶部保留可拖拽区域，可按住顶部空白处移动 Mac 窗口。
- Dock、应用窗口和 DMG 使用打包内同一份用户提供的 `record` 品牌图标。安装版由 `.app` bundle 的 `icon.icns` 交给 macOS 管理，启动时不得再调用 `app.dock.setIcon()` 用 PNG 覆盖；否则未打开时正常、打开后会变成没有系统遮罩的方形图标。若升级后仍显示缓存图标，先完全退出旧进程，再从新构建的 `.app` 启动。
- 发行详情的平台图标由前端组件局部接管右键菜单，用于添加、修改或清除链接。Electron 主进程不得全局禁用 `context-menu`，否则会让该编辑入口以及未来其他右键操作一起失效。
- 客户端持有 Electron 单实例锁；重复打开同一当前版本时只恢复并聚焦原窗口，不会重复占用 `4173`。若端口由不支持单实例锁的历史 RecordShelf 进程占用，则不得静默复用旧页面；应提示用户完全退出旧客户端后重开，避免代码已更新但界面仍表现为旧版本。尤其注意从废纸篓启动的 `.app` 也可能继续占用端口。
- 更新代码或基础数据库后，重新执行 `npm run build:desktop` 生成新版应用。
- 升级前建议先在“设置”中使用“备份音乐库”下载完整 JSON，并备份上述共享状态文件。

每次发布的用户可见变化、数据影响与验证结果见
[版本变更记录](CHANGELOG.md)。
