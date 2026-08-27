# RecordShelf 文档维护约定

本文件用于回答两个长期问题：某次修改应该写到哪里，以及交付前如何确认代码与文档没有脱节。
产品行为仍以 [`PRD.md`](../PRD.md) 为最高层真相源。

## 文档职责

| 文档 | 负责内容 | 不应承载 |
|---|---|---|
| `PRD.md` | 产品规则、数据边界、失败行为、验收标准、当前实现基线 | 一次性的调试过程 |
| `app/AGENTS.md` | 编码与视觉实现不变量、安全约束、易回归点 | 版本流水账 |
| `docs/CHANGELOG.md` | 每个应用版本已经交付的变化、数据影响、验证结果和已知限制 | 尚未确定的产品设想 |
| `docs/MAC_APP.md` | Mac 构建、安装、签名、包名、资料位置与升级方式 | Web 端完整产品规格 |
| `docs/PHONE_PREVIEW.md` | 手机只读预览的部署、同步和隐私边界 | 本机可写流程 |
| `docs/LISTENING_GUIDE_SPEC.md` | 聆听指南的研究、状态、存储与生成细则 | 其他模块的通用规则 |
| `docs/ARTIST_DETAIL_PROMPT_PRD.md` | 艺人详情、探索目录、合作关系、公开档案、艺人介绍 Prompt 与动态视觉细则 | 已交付能力的版本流水账 |
| `docs/ROAM_SPEC.md` | 漫游点亮资格、国家映射、大洲目录、国家二级页与响应式规则 | 艺人公开资料研究本身的 Prompt 与来源细则 |
| `docs/APPLE_MUSIC_EDITORIAL_NOTES.md` | Apple Music 官方介绍的令牌、读取与缓存规则 | 用户手写介绍的通用数据模型 |
| `README.md` | 项目入口、能力概览、隐私提示和文档索引 | 重复的详细规范 |

## 变更分类

代码修改完成时，按下面的最小集合更新文档：

- 用户交互、文案、信息架构或响应式行为：更新 `PRD.md`、`app/AGENTS.md`（若属于长期不变量）和 `docs/CHANGELOG.md`。
- 数据结构、持久化、迁移、同步、去重或隐私边界：更新 `PRD.md`、`app/AGENTS.md`、`docs/CHANGELOG.md`，并补数据迁移与恢复说明。
- 外部平台读取、链接编辑、评分、封面或曲目适配：更新 `PRD.md` 对应专题章节、`app/AGENTS.md` 和 `docs/CHANGELOG.md`。
- Mac 窗口、图标、签名、版本或 DMG：额外更新 `docs/MAC_APP.md`。
- 手机远程预览：额外更新 `docs/PHONE_PREVIEW.md`。
- 聆听指南或 Apple 官方介绍：额外更新各自专题文档。
- 只改内部实现且行为不变：至少判断是否需要 Changelog；若版本、产物或维护风险变化，仍要记录。

## 提交前检查

1. `PRD.md` 顶部实现基线与 `app/package.json` 版本一致。
2. `docs/MAC_APP.md` 的 DMG 示例包名与当前版本一致。
3. 新增或改变的长期行为在 PRD 有规则，在需要时有 Given/When/Then 验收标准。
4. 容易被后续重构破坏的事件边界、持久化路径和隐私限制已经写入 `app/AGENTS.md`。
5. `docs/CHANGELOG.md` 说明本版本改变了什么、是否迁移私人数据，以及通过了哪些验证。
6. README 和专题文档中的相对链接可解析，没有指向已停用端口、旧包名或已删除命令。
7. 运行 `git diff --check`；涉及代码时同时运行与风险相称的测试、公开构建隐私检查和桌面构建检查。

## 维护原则

- 文档记录稳定结论，不复制聊天里的试探过程。
- 同一个规则只设一个主要真相源，其他文档使用链接或摘要，避免多处出现互相冲突的长文。
- 私人数据库路径可以写入文档，但私人内容、密钥、OAuth token、快照与生成的动态封面不得进入 Git。
- 版本发布后补写遗漏时，要在 Changelog 明确这是文档补录；不得悄悄把未实现能力写成已交付。

## 艺人主页与素材维护

- 艺人详情的 Apple Music、Spotify 与 YouTube Music 主页链接按稳定 `artist_id` 立即写入共享 `artistProfiles` 增量（`~/Library/Application Support/RecordShelf/shared-local-state.json`）；Web 与 Mac 必须读取同一份状态，不能另建浏览器端副本。含空格的未映射 ID（如 `raw-doja cat`）、`+`/`%20` 编码变体和已映射身份都应对准同一份 `platformLinks` 与本机 `media`。重新打开必须还原因用户保存而已经存在的链接和素材；不得因为空增量合并把它们清掉，也不得因此在每次打开时重新请求封面。
- 平台工具的可交互状态只取已确认并通过平台 URL 校验的 `artistProfiles.platformLinks`：有链接时使用高亮外链并以新标签页打开，无链接时渲染禁用的低强调按钮；不得让缺失平台图标承担“编辑链接”的隐式操作，编辑统一由独立铅笔入口完成。
- 链接只接受对应平台的精确 HTTPS 艺人主页，不能以搜索结果、专辑页或模糊名称代替。不提供设置页「匹配 Apple Music 艺人主页」或艺人详情编辑器内的专辑反查匹配；艺人主页只能由用户粘贴精确 Artist URL。不得按艺人姓名搜索 Apple 目录，也不得在保存链接后自动拉取封面或动态视觉；修改链接后，只有用户主动点击素材按钮才允许调用 `/api/artists/media`。
- `/api/artists/media` 只处理当前艺人：读取其 Apple Music Artist URL，按 Apple 公开目录同时请求 `editorialArtwork` 与 `editorialVideo`；静态图优先方形身份静图（`artwork` / `staticDetailSquare`），再横版 editorial hero 的 1400/1000，以及 Artwork Finder 同款 600px 兜底（必要时把 iTunes `artworkUrl100` 放大到 600×600），动态视觉优先方形 1:1 再回退 16:9，压缩为本机 H.264 MP4。本机文件名会把含空格的未映射艺人 ID 清理成安全 slug，不得把合法 HLS 误报为「地址无效」。超过 8 MB 时先自动截短时长，再降 fps/分辨率/crf，直到文件 ≤ 8 MB 后保留该 MP4；只有完全没有可播放视频时才回退静图。禁止抓取第三方 artwork-finder 页面，也禁止在打开艺人详情、同步 NeoDB 或启动客户端时批量扫描全库。
- 头部素材优先级固定为：本机动态 MP4（或尚未刷新的遗留 WebP）→ 已缓存艺人图 → RecordShelf 已收录专辑封面拼贴。请求失败时保留上一次可用素材与专辑拼贴，不显示破图，也不把错误缓存为成功结果。
- 艺人探索目录只接受已确认、带 storefront 的 Apple Music Artist URL。用户刷新时可用本机 MusicKit Developer Token；没有令牌时，只允许在这次明确点击内读取 Apple Web Player 的临时目录令牌，令牌不得返回客户端、记录日志或持久化。请求只包含公开艺人 URL；评分、评论、听过日期、状态和本地艺人映射全部留在客户端，目录与本地记录的匹配和完成度计算也在客户端完成。
- Git 只保留实现与空状态模型；艺人链接、缓存图片、动态视觉和请求结果都属于本机私人增量，不得提交到仓库。
