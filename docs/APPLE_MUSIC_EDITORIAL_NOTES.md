# RecordShelf「专辑介绍」：Apple Music 官方编辑介绍

> 状态：第一版实现
> 适用端：RecordShelf 响应式 Web（`127.0.0.1:4173`）与 macOS 客户端
> 上位规范：`../PRD.md`

## 1. 功能定位

发行详情抽屉中的「专辑介绍」始终出现。用户可以手写或粘贴介绍，保存在本机
共享音乐库里；若已配置 MusicKit Developer Token 且有可解析的 Apple Music
专辑链接，也可以读取官方 `editorialNotes` 原文，并在不同地区 × 语言的官方
文案之间切换。手写与官方原文互不覆盖。

它不是：

- 机器翻译；「多语言」指 Apple 官方已有的本地化版本；
- AI 改写或摘要；
- 独立的 Apple Music 文案聚合、归档或对比数据库；
- 网页抓取；不使用 `music.apple.com` 页面内部 token。

与「聆听指南」的分工：本模块是专辑短文（手写或平台官方原文），位置紧随
平台跳转按钮；「聆听指南」是带来源的长阅读，仍在收听时间线之后。

## 2. 位置

```text
发行资料与封面
平台跳转按钮
专辑介绍             ← 本模块
收听时间线
聆听指南
合并其他条目
```

没有可解析的 Apple Music 专辑链接时，模块仍显示，只提供手写入口，不请求
官方 API。用户手写保存在发行记录的 `albumIntroduction` 字段，走共享用户
增量，NeoDB 同步不得覆盖。官方缓存仍只写
`Application Support/RecordShelf/apple-music-editorial-notes.json`。

## 3. 链接识别

`app/src/lib/appleMusicUrl.js` 的 `parseAppleMusicAlbumUrl` 是纯函数，
Web、桌面端与服务端共用：

- 只接受 `https:` 与 `music.apple.com` / `www.music.apple.com`；
- 路径必须是 `/{storefront}/album/…/{albumId}`；
- `storefront` 为两位地区代码并转小写；`albumId` 必须是数字字符串，
  按字符串处理而不转 `number`；
- 忽略 tracking query 与 hash；单曲分享链接的 `?i=<songId>` 被忽略，
  仍按 path 中的 album ID 处理；
- 带凭据的 URL、artist / playlist / station 链接一律返回 `null`；
- 不主动请求任意重定向地址，因此本期不支持短链接。

## 4. 服务端

`app/apple-music-notes/index.mjs` 同时挂载在 Vite dev 中间件与 Electron
本地服务器上，对外只有一个只读接口：

```text
GET /api/apple-music/editorial-notes?url=<专辑链接>&mode=quick|full&locale=<产品语言>&refresh=1
```

### 4.1 鉴权

Developer Token 只在服务端读取，按以下顺序解析：

1. 环境变量 `APPLE_MUSIC_DEVELOPER_TOKEN`；
2. 私人文件 `~/Library/Application Support/RecordShelf/apple-music-developer-token`（权限 `0600`）。

令牌不进入客户端 bundle、日志、接口响应或错误详情。缺失时返回
`APPLE_MUSIC_NOT_CONFIGURED`，且不发出任何网络请求。

### 4.2 查询策略

快速扫描（`mode=quick`，默认）目标集合为链接自身的 storefront、产品语言
对应的 storefront，加上常用市场 `us gb tw hk cn jp kr fr de es mx br ca au sg`，
去重后执行：

1. 跨 storefront 时用 `filter[equivalents]` 解析目标地区的 album ID；
   源 storefront 直接使用源 album ID；
2. 读取该 storefront 的 `defaultLanguageTag + supportedLanguageTags` 并去重；
3. 逐个 language tag 请求专辑，优先取 `standard`，缺失时降级到 `short`；
4. 空文案不进入结果；
5. 单个地区或语言失败不影响其余结果，只累加 `failedRequests`。

完整扫描（`mode=full`）扫描 `/v1/storefronts` 返回的全部 storefront，由
界面上的「查找更多语言版本」触发；本项目没有后台任务基础设施，因此不为
此引入队列。两种模式返回同一套结果模型。

### 4.3 并发、重试与缓存

- 全局并发上限 5，storefront 与 language 两层任务展平后统一调度；
- `429/500/502/503/504` 最多重试 3 次，优先尊重 `Retry-After`，否则指数
  退避加 jitter；`401/403` 不重试，返回鉴权错误；
- `404`、等价 ID 为空、某语言没有文案都视为正常缺失；
- 缓存写入 `~/Library/Application Support/RecordShelf/apple-music-editorial-notes.json`
  （权限 `0600`，原子写入 + 文件锁）：storefront 列表 7 天，等价 ID 与
  文案结果 3 天；缓存 key 为
  `schemaVersion|sourceAlbumId|targetStorefront|languageTag`；
- `refresh=1` 绕过文案缓存，仍受并发与重试限制；
- 单次扫描的专辑请求预算为 200，超出部分记为 `partial`。

### 4.4 清理与去重

服务端按白名单只保留 `<b> <i> <br>`，丢弃全部属性与其他标签，并输出
`html`（用于富文本展示）与 `plainText`（用于 hash 与无 HTML 展示）。
去重 key 是 `plainText` 经实体解码、NFKC、NBSP 转空格、合并空白、trim
后的 SHA-256；相同正文只保留一个版本并合并 `sources`，同一语言在不同地区
的不同正文仍是多个版本。

### 4.5 错误码

```text
INVALID_APPLE_MUSIC_URL
UNSUPPORTED_APPLE_MUSIC_RESOURCE
APPLE_MUSIC_NOT_CONFIGURED
APPLE_MUSIC_UNAUTHORIZED
APPLE_MUSIC_RATE_LIMITED
APPLE_MUSIC_ALBUM_NOT_FOUND
APPLE_MUSIC_NO_EDITORIAL_NOTES
APPLE_MUSIC_UPSTREAM_ERROR
```

「这张专辑没有官方介绍」是正常结果而不是失败：接口返回 `200`、
`versions: []` 和 `emptyReason: "APPLE_MUSIC_NO_EDITORIAL_NOTES"`，
让界面展示空状态而不是错误。日志只记录 provider、请求路径、HTTP status、
attempt 和耗时，不记录令牌或上游响应正文。

## 5. 界面

- 模块始终渲染。空状态提供「添加介绍」；已有手写时提供「编辑」和「清除」。
- 下拉名称是「文案版本」，不是「国家或地区」。有手写时第一项为「我写的」，
  默认选中手写；只有一个版本时显示静态标签。
- 官方版本 label 优先可识别的名字：`语言 · N 个地区`、`语言（地区） · 完整介绍`、
  `语言 · 短导语`；`short` 必须标注「短导语」。语言与地区名走
  `Intl.DisplayNames`，无法识别时回退到原始 tag / storefront 代码。
- 官方默认版本顺序：产品语言完全匹配 → 源 storefront 默认语言 → 同基础语言 →
  英文 → 稳定排序；同一档内完整介绍优先于短导语。用户已选择的版本若仍存在
  则优先恢复，完整扫描补充新版本时不切走当前选择。
- 手写按纯文本展示（`pre-wrap`），不走 HTML。有专辑链接时右侧保留
  「在 Apple Music 中打开」（`rel="noopener noreferrer"`）；「编辑 / 清除 /
  添加介绍」放在页脚左侧，使用 50% 黑而不是强调色。不在页脚标注手写或
  官方来源文案。
- 部分失败时展示成功结果加一行非阻断说明；未配置令牌且没有手写时，提示可
  自己添加，不把令牌错误当成唯一内容。

## 6. 数据边界

Apple 文案是可刷新的外部元数据缓存，不写入共享音乐数据库，也不复制成用户
原创正文。它不进入 `shared-local-state.json`，因此不会覆盖用户手写内容。

用户手写介绍保存在发行记录的 `albumIntroduction`，进入
`recordshelf-user-state-v2` 的 metadata overrides / userReleases，随 Web 与
Mac 共享增量同步。NeoDB 同步不得改写该字段。手写最长 20,000 字，保存时解码
常见 HTML 实体（例如从网页复制来的 `&amp;`），按纯文本存储。

## 7. 公开发布前的协议检查

Apple Developer Program License Agreement（3.3.6(D) 附近）限制 MusicKit
内容的使用，明确举例说明来自 MusicKit API 的封面与音乐相关文字不应脱离
音乐播放或歌单管理单独使用。

因此：本地、内部研究或未公开原型可以先完成技术验证；不要把本功能扩展成
独立的 Apple Music 编辑文案聚合、归档、导出或对比数据库；必须保留来源与
Apple Music 原内容入口。正式公开发布前，产品负责人需要核对开发者账户中
届时生效的最新协议，并评估 RecordShelf 是否需要结合 Apple Music 播放或
歌单管理能力。技术实现不等于合规确认。

## 8. 参考

- [Apple Music API](https://developer.apple.com/documentation/applemusicapi)
- [Generating Developer Tokens](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens)
- [Get a Catalog Album](https://developer.apple.com/documentation/applemusicapi/get-a-catalog-album)
- [EditorialNotes](https://developer.apple.com/documentation/applemusicapi/editorialnotes)
- [Storefronts.Attributes](https://developer.apple.com/documentation/applemusicapi/storefronts/attributes-data.dictionary)
- [Managing Content Ratings, Alternate Versions, and Equivalencies](https://developer.apple.com/documentation/applemusicapi/managing-content-ratings-alternate-versions-and-equivalencies)
- [Apple Developer Program License Agreement](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/)
