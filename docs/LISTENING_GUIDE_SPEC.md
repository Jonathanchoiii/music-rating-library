# RecordShelf「聆听指南」功能规格

> 状态：第一版规划
> 更新日期：2026-08-09
> 适用端：RecordShelf 响应式 Web 与 macOS 客户端
> 上位规范：`../PRD.md`

## 1. 功能定位

「聆听指南」是发行详情页中的辅助阅读内容。它帮助用户在播放一张专辑时，快速理解作品的创作背景、声音线索、重点曲目、视觉表达、专业评价与听众回响。

它不是：

- 对用户评论的自动改写；
- 没有来源的 AI 乐评；
- 独立于发行详情的新内容社区；
- 打开详情页就反复联网刷新的动态内容；
- 全库后台自动批量生成任务。

核心原则：

1. **身份先于写作。** 先确认具体发行版本，再研究与生成。
2. **证据先于完整。** 没有可靠证据就省略，宁可短也不补写。
3. **一次生成，长期复用。** 普通打开详情页只读本地缓存。
4. **专业与 UGC 分开。** 不把单一媒体或少数社区帖子写成共识。
5. **私人数据不外发。** 外部检索只使用公开发行身份字段。
6. **视觉属于 RecordShelf。** 参考图只借鉴“边听边读”的节奏，不复制深色沉浸卡、渐变、玻璃或额外品牌系统。

## 2. 用户目标

用户打开一张正在播放或准备重听的专辑时，应能完成三件事：

1. 在 10 秒内知道它处于艺人怎样的创作阶段；
2. 在播放过程中获得具体、可验证的声音与重点曲目线索；
3. 理解专业媒体和普通听众如何回应这张作品，并能查看原始来源。

## 3. 入口与页面位置

### 3.1 位置

「聆听指南」放在现有发行详情抽屉中：

```text
发行资料与封面
平台跳转按钮
收听时间线
聆听指南             ← 新增
合并其他条目
```

这样让用户先回看自己的收听与评分历史，再继续阅读作品背景；指南与重复条目更正之间保持清楚的数据层级，也不会改变现有详情页路由或信息架构。

### 3.2 空状态

尚未生成时，只展示一个克制的段落入口，不展示大面积空卡：

- 小标题：`聆听指南`
- 副文案：`从可靠资料整理这张专辑的背景、声音线索与外界回响。`
- 主操作：`生成聆听指南`
- 辅助说明：`只会发送公开的专辑身份信息，不会发送评分、评论或听过时间。`

第一次使用生成能力时，操作前进行一次隐私确认。确认内容需要说明具体检索与生成服务；同一服务配置不重复确认，服务发生变化时重新确认。

### 3.3 已生成状态

默认展示：

- `聆听指南` 标题；
- 60–100 字摘要；
- 2–4 首“值得留意”曲目（只有存在可靠证据时）；
- `展开阅读`；
- 最近生成日期；
- 低强调的 `更新` 操作。

首次生成成功后自动展开全文。之后重新打开详情页时默认折叠到摘要，保留用户本次会话中的展开状态。

### 3.4 全文结构

展开后严格沿用七个内容段落：

1. 坐标与初印象
2. 灵感与诞生
3. 听感解构
4. 情绪流变与歌词
5. 视觉互文
6. 回响与勋章
7. 结语与推荐

七个标题保留，但各段篇幅按证据密度变化。没有具体轶事、奖项或视觉意图时缩短对应段落，不显示“暂无资料”等占位文本。

### 3.5 来源

全文底部增加默认折叠的 `参考资料 · N`：

- 每条展示媒体或机构名、文章标题、来源类型和外链；
- 正文中的事实与来源使用稳定编号关联，如 `[S1]`；
- 专业乐评、官方资料、数据库、奖项榜单和社区讨论使用不同的文本标签，但不新增高饱和颜色体系；
- 失效来源仍保留标题与访问日期，并标记“链接可能已失效”，不静默删除历史证据。

## 4. 视觉与响应式

### 4.1 视觉继承

必须复用现有 RecordShelf token 和组件：

- 背景：`var(--bg)` / `var(--surface)`；
- 正文：`var(--text)`；
- 元数据：`var(--muted)` / `var(--muted-dark)`；
- 交互：`var(--accent)` / `var(--accent-soft)`；
- 分隔：`var(--line)`；
- 圆角：现有 `--radius-control`；
- 按钮：现有 `secondary-button`、`text-button` 和图标体系。

禁止为该功能新增：

- 深色整页主题；
- 封面取色渐变背景；
- 玻璃拟态、发光或重阴影；
- 大型宣传标题；
- 与现有详情抽屉不一致的卡片圆角和字体。

### 4.2 文字层级

建议沿用当前详情页的密度：

| 内容 | 桌面 | 窄屏 | 说明 |
|---|---:|---:|---|
| 区块标题 | 21 px | 20 px | 与“收听时间线”同级 |
| 文章小标题 | 15–16 px | 15 px | 650–700 字重 |
| 正文 | 14–15 px | 15 px | 行高 1.75–1.9 |
| 来源与时间 | 11–12 px | 11–12 px | 灰色元数据 |

正文单行阅读宽度控制在约 38–46 个中文字符，避免在宽抽屉里形成过长行。段落之间使用留白和细分隔线，不把七段分别做成七张卡片。

### 4.3 桌面端

- 指南与抽屉正文同宽；
- 展开时在当前抽屉内纵向阅读，不打开二级模态框；
- 更新、来源与折叠控制靠近区块标题，避免与平台按钮争夺主操作；
- 用户关闭抽屉后，后台生成任务继续执行。

### 4.4 移动端和窄屏

- 保持详情页的单列滚动；
- 生成按钮最小点击区域 44×44 px；
- 标题、状态和更新时间允许换行，不横向滚动；
- 摘要默认最多显示约六行，展开后显示全文；
- 重点曲目使用紧凑文本列表，不使用横向卡片轮播；
- 来源链接整行可点，外链图标与文字对齐。

## 5. 状态设计

| 状态 | 用户可见反馈 | 可执行操作 |
|---|---|---|
| `EMPTY` | 尚未生成 | 生成聆听指南 |
| `CONSENT_REQUIRED` | 说明发送字段与服务 | 同意并生成 / 取消 |
| `QUEUED` | 已加入任务 | 可关闭详情 |
| `VERIFYING` | 正在确认专辑版本 | 可关闭详情 |
| `RESEARCHING` | 正在查找可靠资料 | 可关闭详情 |
| `WRITING` | 正在整理聆听指南 | 可关闭详情 |
| `READY` | 显示摘要或全文 | 展开、收起、更新、查看来源 |
| `UNVERIFIED` | 无法确认具体发行版本 | 补充精确链接后重试 |
| `INSUFFICIENT_SOURCES` | 身份已确认，但可靠资料不足 | 查看已确认来源 / 稍后更新 |
| `FAILED` | 生成未完成，旧版本仍保留 | 重试 |

生成中使用三段式文字进度，不使用虚假的百分比。更新失败时继续展示旧指南，并在标题附近提示“本次更新失败，正在显示上一版”。

## 6. 触发、缓存与更新规则

1. 每个稳定 Release ID 最多同时存在一个生成任务。
2. 打开详情、刷新页面、修改评分或记录听歌均不得自动触发生成。NeoDB 同步只为本轮新增或身份发生变化的 Release 建立/更新一次本地指南档案；已有正文不得自动重新联网或重写。
3. 首次入库或同步回填时，系统先按稳定 Release ID 建立缓存。研究服务可用且身份、证据达标时写入 `READY`；否则写入 `INSUFFICIENT_SOURCES` 空正文档案，严禁以模板内容充数。一次任务内部允许搜索并打开多个来源。“只检索一次”指不因重复打开页面或普通同步而再次运行整套任务，不是把研究限制为一个搜索请求。
4. 生成成功后保存正文、结构化字段、来源、生成时间、提示词版本与发行身份指纹。
5. 用户点击 `更新` 才重新联网。更新前展示最近生成日期，并明确会覆盖当前版本；服务端先保留上一版，只有新版本成功才切换。
6. 发行身份字段变化时更新缓存中的公开身份快照并显示“专辑资料已变化，指南可能需要更新”；不得自动联网或自动覆盖成功正文。
7. 标准版、Deluxe、Remaster、Live 与同名不同发行分别缓存，不能共享正文。
8. 本地删除或合并发行时，指南跟随用户最终保留的 Release ID；若两边都有指南，必须保留两版供用户选择，不能自动拼接。

## 7. 专辑身份确认

生成请求只允许发送以下公开目录字段：

- 稳定 Release ID（只用于本地关联，不发送给第三方搜索）；
- 发行时原语言标题；
- 艺人完整署名；
- 发行年份或日期；
- 类型和版本属性；
- 已确认的 NeoDB、MusicBrainz、Apple Music、Spotify 公开 ID 或链接；
- 可选的公开曲目表。

禁止发送：

- 用户评分；
- 用户评论；
- 听过时间；
- 收藏状态；
- 艺人私有映射或重复项判断；
- NeoDB OAuth token；
- 其他私人笔记。

身份确认优先级：

1. 已确认的精确平台 ID 与规范链接；
2. 原语言标题 + 完整艺人署名 + 版本 + 发行年份；
3. 曲目表交叉确认。

仅凭译名、封面相似、标题相似或艺人国籍不得开始写作。无法确认时返回 `UNVERIFIED`，不保存半成品正文。

## 8. 检索与证据策略

### 8.1 来源优先级

1. 官方网站、唱片公司、正式采访、创作者声明和唱片内页；
2. MusicBrainz、官方流媒体目录及可靠行业数据库；
3. 有署名和编辑制度的专业音乐媒体；
4. 奖项、榜单与认证的官方网站；
5. AOTY、Rate Your Music、Reddit、Last.fm 等社区；
6. 经过交叉验证的其他来源。

搜索结果摘要、AI 摘要、无出处转载、内容农场不得作为关键事实的唯一依据。

### 8.2 专业评价与 UGC

- 专业媒体评价必须显示媒体名称、作者（若有）、日期、评分（若有）和原文链接；
- 不将某一家媒体观点写成“乐评界公认”；
- UGC 只总结多个独立讨论中反复出现的体验；
- 单一 Reddit 帖子只能写成“有听众提到”，不能写成普遍共识；
- 专业评价与用户评价在数据和文章表达中保持分离。

### 8.3 引用与歌词

- 优先转述，不大段复制受版权保护的乐评或歌词；
- 直接引文必须很短、可核对并绑定来源；
- 歌词以主题概括为主；确有必要时只引用极短片段并标注曲名；
- 翻译歌词时注明“意译”，不得伪装成官方译文。

## 9. 内容结构与输出

### 9.1 正文

- 简体中文；
- 目标长度约 800–1000 个中文字符，不把引用和来源列表计入；
- 原语言标题作为主标题，译名只作辅助；
- 语气温暖、自信、克制，像深夜电台主持人；
- 避免百科堆砌、营销套话、学术腔和无依据的价值判断。

### 9.2 结构化输出

```ts
type ListeningGuideStatus =
  | "EMPTY"
  | "QUEUED"
  | "VERIFYING"
  | "RESEARCHING"
  | "WRITING"
  | "READY"
  | "UNVERIFIED"
  | "INSUFFICIENT_SOURCES"
  | "FAILED";

interface ListeningGuide {
  id: string;
  releaseId: string;
  status: ListeningGuideStatus;
  identityFingerprint: string;
  releaseIdentitySnapshot: {
    originalTitle: string;
    artists: string[];
    releaseDate: string | null;
    releaseType: string | null;
    editionTypes: string[];
    externalIdentities: Array<{
      provider: string;
      idOrUrl: string;
    }>;
  };
  summary: string | null;
  sections: Array<{
    key:
      | "orientation"
      | "origin"
      | "sound"
      | "emotion_lyrics"
      | "visual"
      | "reception"
      | "recommendation";
    title: string;
    body: string;
    sourceIds: string[];
  }>;
  highlightTracks: Array<{
    title: string;
    reason: string;
    sourceIds: string[];
  }>;
  credits: Record<string, string | string[] | null>;
  reception: {
    professional: string | null;
    audience: string | null;
    awardsAndCharts: string | null;
  };
  sources: Array<{
    id: string;
    title: string;
    publisher: string;
    author: string | null;
    publishedAt: string | null;
    url: string;
    sourceType:
      | "OFFICIAL"
      | "INTERVIEW"
      | "DATABASE"
      | "PROFESSIONAL_REVIEW"
      | "AWARD_CHART"
      | "COMMUNITY";
    accessedAt: string;
    supports: string[];
  }>;
  confidence: "HIGH" | "MEDIUM" | null;
  promptVersion: string;
  provider: string;
  generatedAt: string | null;
  updatedAt: string;
  previousVersionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}
```

`LOW` 置信度不得进入 `READY`。证据不足应进入 `INSUFFICIENT_SOURCES`，而不是生成低可信正文。

## 10. 本地存储与 Web/Mac 共用

聆听指南属于可再生成但需要持久化和备份的派生内容。它不能塞入现有发行增量字段，也不能只存在某个浏览器 origin。

第一版本地实现建议：

- 主文件：`~/Library/Application Support/RecordShelf/listening-guides.json`；
- 历史版本：`~/Library/Application Support/RecordShelf/listening-guide-history/`；
- Web `127.0.0.1:4173` 与 macOS 客户端通过同一组本地 API 读写；
- 浏览器 `localStorage` 只保存展开/折叠等界面偏好，不保存正文；
- 完整 JSON 导出和备份必须包含指南、来源与版本信息；
- 公开构建不得包含私人唱片对应的指南缓存或 API 凭证。

指南写入使用临时文件 + 原子替换。更新前保留上一版；至少保留最近 3 个成功版本和最近一次失败摘要。

未来迁移到服务端数据库时，使用 `release_id` 外键与 Owner ID 隔离，不能用标题作为关联键。

## 11. API 契约

```text
GET  /api/releases/:id/listening-guide
POST /api/releases/:id/listening-guide/generate
POST /api/releases/:id/listening-guide/refresh
POST /api/listening-guides/backfill
GET  /api/listening-guide-jobs/:jobId
GET  /api/releases/:id/listening-guide/history
POST /api/releases/:id/listening-guide/restore/:versionId
```

生成或更新响应应尽快返回任务 ID：

```json
{
  "jobId": "lgj_...",
  "releaseId": "release-...",
  "status": "VERIFYING"
}
```

要求：

- 同一 Release ID 的并发请求返回同一活动任务；
- `generate` 在已有 `READY` 时返回缓存，不联网；
- `refresh` 必须由用户明确触发；
- `backfill` 只创建缺失档案或更新公开身份快照，必须幂等，且不得刷新已有成功正文；
- 任务可在详情页关闭后继续；
- 任何响应不得返回 API key、OAuth token、完整搜索调试日志或不应公开的用户数据；
- 前端不得直接持有搜索或模型服务密钥。

## 12. 服务与密钥

功能使用“检索适配器 + 生成适配器”，不把产品绑定到单一厂商：

```text
Release identity
  → Search adapter
  → Source fetch/normalize
  → Evidence validator
  → Prompt renderer
  → Generation adapter
  → Schema validator
  → Atomic local store
```

密钥只能存在服务端环境变量、macOS Keychain 或本地私有配置中。不得写入 Git、前端 bundle、完整 JSON 导出或共享状态文件。

没有可用凭证时：

- 已生成内容仍可阅读；
- 生成按钮显示“尚未配置聆听指南服务”；
- 提供进入设置的入口；
- 其他唱片管理功能保持可用。

本地第一版在“设置 → AI 聆听指南”中支持 OpenAI 与 Google Gemini 两个可信预设。两家的 API Key 分别写入 `~/Library/Application Support/RecordShelf/openai-api-key` 与 `~/Library/Application Support/RecordShelf/gemini-api-key`，活动提供商和模型名写入同目录 `listening-guide-provider.json`；文件权限均为 `0600`。密钥不得进入共享音乐数据库、localStorage、指南缓存、JSON/CSV 导出、日志、Git、公开构建、客户端 bundle 或 DMG 资源，也不得通过设置接口回显。`OPENAI_API_KEY` 与 `GEMINI_API_KEY` / `GOOGLE_API_KEY` 环境变量可覆盖本机私有文件。

单张手动更新按当前选择使用 OpenAI Responses API 的托管 `web_search`，或 Gemini 固定官方域名上的 Google Search grounding 与结构化输出。请求强制执行联网检索，并只发送第 7 节的公开发行身份字段。服务端必须把模型列出的来源 URL 与实际搜索返回的 URL 白名单交叉核对；未被搜索结果或用户确认精确链接支持的 URL、段落和重点曲目不得保存。身份不一致、少于两个可靠来源或七段正文证据不完整时，保存 `UNVERIFIED` / `INSUFFICIENT_SOURCES` 空正文，不覆盖为伪完整文章。

MVP 不接受任意第三方 Base URL、自定义请求头或通用“兼容接口”，因为这些字段可能把已保存密钥发送给未知主机。后续增加 Anthropic 或其他提供商时，必须新增固定官方主机、认证、搜索工具、结构化输出、来源元数据提取、错误脱敏与测试适配器，而不是开放任意转发。

全库批量研究作为后续可选任务使用 Batch API，不与 NeoDB 普通同步绑定。批量任务必须由用户明确启动，先显示唱片数、模型和费用风险，支持分批、暂停、断点续跑和失败重试；已是 `READY` 的条目默认跳过。单张“重新联网核对”始终保留，不依赖批量任务。

## 13. 提示词版本

生产提示词需作为版本化资源保存，例如：

```text
app/prompts/listening-guide.v1.md
```

提示词必须包含：角色、输入字段白名单、身份确认、来源层级、专业/UGC 分离、七段结构、引用限制、结构化输出和失败状态。修改提示词版本不会自动重写已有指南；只有用户主动更新时使用新版本。

## 14. 可访问性

- 生成、展开、更新和来源链接均可键盘操作；
- 展开按钮使用 `aria-expanded` 和 `aria-controls`；
- 生成状态使用 `aria-live="polite"`，不反复朗读每次内部步骤；
- 来源外链说明会打开新页面；
- 不能只靠颜色表示 `READY`、失败或身份未确认；
- 减少动态效果模式下不使用持续闪烁或骨架扫光。

## 15. MVP 范围与分阶段实现

### 阶段 A：结构与本地持久化

- 详情页新增空、生成中、成功、失败、无法确认五类界面状态；
- 使用固定 fixture 验证七段正文、重点曲目和来源布局；
- 建立本地指南存储、版本与 Web/Mac 共用 API；
- 加入完整 JSON 导出与恢复。

### 阶段 B：单张专辑真实生成

- 接入一个检索服务和一个生成服务；
- 先以少量有精确 Apple Music/MusicBrainz/NeoDB 身份的专辑验证；
- 加入身份指纹、证据白名单、结构校验与失败保护；
- 记录耗时、来源数量与失败原因，不记录私人字段。

### 阶段 C：体验与可靠性

- 后台任务和详情关闭后继续；
- 更新保留上一版；
- 来源失效与历史版本恢复；
- 桌面、390 px 手机、键盘和减少动态效果回归测试。

### 不在首版

- 全库 1,800 张自动批量生成；
- 定时自动刷新；
- AI 根据用户评分改写内容；
- 自动发布或分享；
- 曲目级百科页面；
- 站内音乐播放控制或播放进度同步。

## 16. 验收标准

1. 未生成的发行详情不会发起任何搜索或模型请求。
2. 用户首次生成时能清楚知道哪些公开字段会被发送，评分、评论和听过时间不会离开本机。
3. 同一 Release ID 重复打开详情只读取本地缓存。
4. 已有指南只有点击 `更新` 才重新联网。
5. 无法确认版本时不生成正文，并给出可操作的补充链接建议。
6. 生成成功后展示七段正文、可选重点曲目、来源数量、生成日期与置信度。
7. 每个关键事实可通过来源编号追溯；专业评价与社区评价不会混为一谈。
8. 更新失败时旧指南仍完整可读。
9. Web 4173 与 macOS 客户端读取同一份指南数据；任一端生成后另一端可见。
10. 标准版与 Deluxe 等版本不会共享或覆盖指南。
11. 完整 JSON 导出包含指南正文、来源和版本；公开构建不包含私人指南数据与凭证。
12. 详情页视觉仍使用 RecordShelf 现有字体、色彩、按钮、圆角和分隔线，在桌面与窄屏均不横向溢出。

## 17. 实现前需确认的唯一外部依赖

进入真实联网实现前，需要 Owner 选择或提供：

- 检索服务；
- 生成模型服务；
- 密钥保存方式；
- 单次生成可接受的费用或调用上限。

这些选择不影响阶段 A 的界面、存储与测试，因此阶段 A 可以先实施。
