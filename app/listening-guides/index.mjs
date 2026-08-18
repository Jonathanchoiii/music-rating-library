import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const PROMPT_VERSION = "listening-guide.v1";
const DEFAULT_OPENAI_MODEL = "gpt-5.6-terra";
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const DEFAULT_PROVIDER = "OPENAI";
const PROVIDER_CONFIG_VERSION = 1;
export const LISTENING_GUIDE_PROVIDERS = Object.freeze({
  OPENAI: {
    id: "OPENAI",
    label: "OpenAI",
    defaultModel: DEFAULT_OPENAI_MODEL,
  },
  GEMINI: {
    id: "GEMINI",
    label: "Google Gemini",
    defaultModel: DEFAULT_GEMINI_MODEL,
  },
});
const MAX_BODY_BYTES = 256 * 1024;
const MAX_HISTORY_VERSIONS = 3;
const PILOT_IDENTITY = "sable, fable|bon iver";
const CODEX_RESEARCH_TIMEOUT_MS = 12 * 60 * 1000;
const STORE_LOCK_TIMEOUT_MS = 30 * 1000;
const STORE_LOCK_STALE_MS = 20 * 60 * 1000;
const CODEX_JOB_RETENTION_MS = 60 * 60 * 1000;
const CODEX_JOB_STAGES = new Set([
  "PREPARING",
  "SEARCHING",
  "VERIFYING",
  "WRITING",
  "SAVING",
  "COMPLETED",
]);
const CODEX_JOB_STAGE_ORDER = [
  "PREPARING",
  "SEARCHING",
  "VERIFYING",
  "WRITING",
  "SAVING",
  "COMPLETED",
];
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const APP_DIRECTORY = path.resolve(MODULE_DIRECTORY, "..");
let storeWriteQueue = Promise.resolve();
const codexResearchJobs = new Map();

const NULLABLE_STRING = { type: ["string", "null"] };
const STRING_ARRAY = { type: "array", items: { type: "string" } };
export const LISTENING_GUIDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["READY", "UNVERIFIED", "INSUFFICIENT_SOURCES"] },
    reason: NULLABLE_STRING,
    releaseIdentity: {
      type: "object",
      additionalProperties: false,
      properties: {
        originalTitle: { type: "string" },
        artists: STRING_ARRAY,
        releaseYear: NULLABLE_STRING,
        edition: NULLABLE_STRING,
      },
      required: ["originalTitle", "artists", "releaseYear", "edition"],
    },
    summary: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          sourceIds: STRING_ARRAY,
        },
        required: ["key", "title", "body", "sourceIds"],
      },
    },
    highlightTracks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          reason: { type: "string" },
          sourceIds: STRING_ARRAY,
        },
        required: ["title", "reason", "sourceIds"],
      },
    },
    credits: {
      type: "object",
      additionalProperties: false,
      properties: {
        releaseDate: NULLABLE_STRING,
        label: NULLABLE_STRING,
        producers: STRING_ARRAY,
        songwriters: STRING_ARRAY,
        recordingStudios: STRING_ARRAY,
      },
      required: ["releaseDate", "label", "producers", "songwriters", "recordingStudios"],
    },
    reception: {
      type: "object",
      additionalProperties: false,
      properties: {
        professional: NULLABLE_STRING,
        audience: NULLABLE_STRING,
        awardsAndCharts: NULLABLE_STRING,
      },
      required: ["professional", "audience", "awardsAndCharts"],
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          publisher: { type: "string" },
          author: NULLABLE_STRING,
          publishedAt: NULLABLE_STRING,
          url: { type: "string" },
          sourceType: {
            type: "string",
            enum: [
              "OFFICIAL",
              "INTERVIEW",
              "DATABASE",
              "PROFESSIONAL_REVIEW",
              "AWARD_CHART",
              "COMMUNITY",
            ],
          },
          accessedAt: { type: "string" },
          supports: STRING_ARRAY,
        },
        required: [
          "id",
          "title",
          "publisher",
          "author",
          "publishedAt",
          "url",
          "sourceType",
          "accessedAt",
          "supports",
        ],
      },
    },
    confidence: { type: ["string", "null"], enum: ["HIGH", "MEDIUM", null] },
  },
  required: [
    "status",
    "reason",
    "releaseIdentity",
    "summary",
    "sections",
    "highlightTracks",
    "credits",
    "reception",
    "sources",
    "confidence",
  ],
};

const CONFIRMED_LINK_STATUSES = new Set(["CONFIRMED", "AUTO_CONFIRMED"]);

const PILOT_SOURCES = [
  {
    id: "official-album",
    title: "SABLE, fABLE",
    publisher: "Bon Iver",
    author: null,
    publishedAt: "2025-04-11",
    url: "https://boniver.org/audio/sable-fable/",
    sourceType: "OFFICIAL",
    supports: ["orientation", "origin", "sound", "emotion_lyrics", "credits"],
  },
  {
    id: "official-announcement",
    title: "fABLE — Bon Iver",
    publisher: "Bon Iver",
    author: null,
    publishedAt: "2025-02-11",
    url: "https://boniver.org/announcements/2025/fable/",
    sourceType: "OFFICIAL",
    supports: ["orientation", "credits"],
  },
  {
    id: "new-yorker-interview",
    title: "Bon Iver Is Searching for the Truth",
    publisher: "The New Yorker",
    author: "Amanda Petrusich",
    publishedAt: "2025-03-23",
    url: "https://www.newyorker.com/culture/the-new-yorker-interview/bon-iver-is-searching-for-the-truth",
    sourceType: "INTERVIEW",
    supports: ["origin", "emotion_lyrics"],
  },
  {
    id: "guardian-interview",
    title: "Bon Iver on love, healing and SABLE, fABLE",
    publisher: "The Guardian",
    author: "Laura Snapes",
    publishedAt: "2025-04-11",
    url: "https://www.theguardian.com/music/2025/apr/11/bon-iver-justin-vernon-new-album",
    sourceType: "INTERVIEW",
    supports: ["origin", "visual", "emotion_lyrics"],
  },
  {
    id: "pitchfork-review",
    title: "Bon Iver: SABLE, fABLE Album Review",
    publisher: "Pitchfork",
    author: "Sam Sodomsky",
    publishedAt: "2025-04-11",
    url: "https://pitchfork.com/reviews/albums/bon-iver-sable-fable/",
    sourceType: "PROFESSIONAL_REVIEW",
    supports: ["sound", "reception", "recommendation"],
  },
  {
    id: "guardian-review",
    title: "SABLE, fABLE review – Justin Vernon’s most easy-going record yet",
    publisher: "The Guardian",
    author: "Alexis Petridis",
    publishedAt: "2025-04-11",
    url: "https://www.theguardian.com/music/2025/apr/11/bon-iver-sable-fable-review-justin-vernon-most-easy-going-record-yet",
    sourceType: "PROFESSIONAL_REVIEW",
    supports: ["sound", "reception", "recommendation"],
  },
  {
    id: "ap-review",
    title: "Music Review: Bon Iver’s ‘SABLE, fABLE’",
    publisher: "Associated Press",
    author: "Elise Ryan",
    publishedAt: "2025-04-10",
    url: "https://apnews.com/article/bon-iver-sable-fable-record-review-music-3f292e8cb5b9ede68fad98c54ff869ef",
    sourceType: "PROFESSIONAL_REVIEW",
    supports: ["sound", "reception"],
  },
  {
    id: "pantone-cover",
    title: "Bon Iver’s SABLE, fABLE Album Cover and Salmon Color",
    publisher: "Pantone",
    author: null,
    publishedAt: null,
    url: "https://www.pantone.com/na/en-us/articles/case-studies/bon-iver-sable-fable-album-cover-salmon-pantone-color",
    sourceType: "OFFICIAL",
    supports: ["visual"],
  },
  {
    id: "reddit-megathread",
    title: "Bon Iver — SABLE, fABLE Megathread",
    publisher: "Reddit / r/boniver",
    author: null,
    publishedAt: "2025-04-11",
    url: "https://www.reddit.com/r/boniver/comments/1jv9gcf/bon_iver_sable_fable_megathread/",
    sourceType: "COMMUNITY",
    supports: ["reception"],
  },
];

const PILOT_SECTIONS = [
  {
    key: "orientation",
    title: "1. 坐标与初印象",
    body: "《SABLE, fABLE》是 Bon Iver 于 2025 年 4 月 11 日发行的第五张录音室专辑。它把 2024 年先行发布的三曲《SABLE,》放在开端，再接上九首更明亮的“fABLE”章节：前者像一间只剩人声、木吉他与踏板钢棒吉他的空房，后者则缓缓把门推开，让灵魂乐、柔软的合成器和流行旋律进来。最适合把它视作一条完整的情绪弧线，而不是两张风格相反的作品。",
    sourceIds: ["official-album", "official-announcement", "pitchfork-review"],
  },
  {
    key: "origin",
    title: "2. 灵感与诞生",
    body: "Justin Vernon 把《SABLE,》形容为一次诚实的拆解：巡演后的焦虑、身份压力和关系里的愧疚，被压缩进几乎没有遮蔽物的演奏。到了“fABLE”，视角从自我审判转向重新相信亲密关系。专辑主要在威斯康星的 April Base 完成，Vernon 与制作人 Jim-E Stack 延续合作，但这次不再把技术当作迷雾，而是让编曲帮助歌曲从阴影走向有体温的日光。",
    sourceIds: ["official-album", "new-yorker-interview", "guardian-interview"],
  },
  {
    key: "sound",
    title: "3. 听感解构",
    body: "前三首的留白非常重要：呼吸、指板摩擦与踏板钢棒吉他的拖曳都被保留下来。转入《Short Story》后，音色开始增厚；《Walk Home》的节拍、和声与键盘把 Bon Iver 熟悉的数字处理变得更圆润。《Everything Is Peaceful Love》甚至带着福音与八十年代软摇滚的开阔感。整张唱片仍有切片、变声和颗粒感，却不再刻意把旋律藏起来。",
    sourceIds: ["official-album", "pitchfork-review", "guardian-review", "ap-review"],
  },
  {
    key: "emotion_lyrics",
    title: "4. 情绪流变与歌词",
    body: "情绪核心不是简单的“由悲转喜”，而是承认痛苦之后，学习让快乐变得可信。《S P E Y S I D E》像一封不求回信的道歉，《Awards Season》把孤独推到最静的地方；随后《Short Story》成为一道门槛，后半段开始谈同行、归家与身体重新感到安全。Vernon 的文字仍保留碎片感，但反复出现的距离、赦免和相伴，让整张专辑拥有清楚的方向。",
    sourceIds: ["official-album", "new-yorker-interview", "guardian-interview"],
  },
  {
    key: "visual",
    title: "5. 视觉互文",
    body: "封面把黑色方块放在鲑鱼粉底色中央，延续《SABLE,》近乎封闭的视觉，同时用暖色暗示“fABLE”的生命感。视觉由长期合作者 Eric Timothy Carlson 与摄影师 Graham Tolbert 共同发展。它没有用人物或叙事图像解释音乐，而是用两块颜色把专辑的结构直接摆在眼前：黑色没有消失，只是终于被更大的暖色包围。",
    sourceIds: ["guardian-interview", "pantone-cover"],
  },
  {
    key: "reception",
    title: "6. 回响与勋章",
    body: "专业评价大体认可它从低语走向灵魂乐的结构。Pitchfork 强调“fABLE”里更直接的喜悦与流行触感，《卫报》把它视为 Vernon 最松弛、最易亲近的作品之一；美联社则认为部分数码 R&B 拼贴仍显得疏离，提醒听者这不是一张毫无摩擦的治愈唱片。社区讨论也常在两极之间摆动：有人偏爱《SABLE,》的裸露，有人更珍惜后半段久违的明亮。",
    sourceIds: ["pitchfork-review", "guardian-review", "ap-review", "reddit-megathread"],
  },
  {
    key: "recommendation",
    title: "7. 结语与推荐",
    body: "第一次听，请不要跳过前三首，也别在《Awards Season》结束后停下；留意它与《Short Story》之间那次近乎换气般的转场。想理解唱片的骨架，可以先抓住《S P E Y S I D E》《Walk Home》和《There’s A Rhythmn》：一首负责面对旧伤，一首让身体重新前进，一首把希望安放在不完美的日常里。夜里用耳机从头听完，会比随机播放更接近它真正的叙事。",
    sourceIds: ["official-album", "pitchfork-review", "guardian-review"],
  },
];

function cleanText(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeIdentityPart(value) {
  return cleanText(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s，、/／]+/g, " ")
    .trim();
}

export function publicIdentityKey(identity = {}) {
  return `${normalizeIdentityPart(identity.originalTitle ?? identity.title)}|${normalizeIdentityPart((identity.artists ?? []).join(" "))}`;
}

export function isPilotIdentity(identity = {}) {
  return publicIdentityKey(identity) === PILOT_IDENTITY;
}

export function getListeningGuidePath() {
  if (process.env.RECORDSHELF_LISTENING_GUIDES_PATH) {
    return path.resolve(process.env.RECORDSHELF_LISTENING_GUIDES_PATH);
  }
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "RecordShelf",
    "listening-guides.json",
  );
}

export function getOpenAiKeyPath() {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "RecordShelf",
    "openai-api-key",
  );
}

export function getGeminiKeyPath() {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "RecordShelf",
    "gemini-api-key",
  );
}

export function getProviderConfigPath() {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "RecordShelf",
    "listening-guide-provider.json",
  );
}

function normalizedProvider(value) {
  const provider = cleanText(value, 30).toUpperCase();
  return LISTENING_GUIDE_PROVIDERS[provider] ? provider : "";
}

function providerKeyPath(provider) {
  return provider === "GEMINI" ? getGeminiKeyPath() : getOpenAiKeyPath();
}

function environmentProviderKey(provider) {
  if (provider === "GEMINI") {
    return cleanText(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY, 1000);
  }
  return cleanText(process.env.OPENAI_API_KEY, 1000);
}

export async function readProviderKey(provider) {
  const providerId = normalizedProvider(provider);
  if (!providerId) return { key: "", source: null };
  const environmentKey = environmentProviderKey(providerId);
  if (environmentKey) return { key: environmentKey, source: "ENVIRONMENT" };
  try {
    return {
      key: cleanText(await fs.readFile(providerKeyPath(providerId), "utf8"), 1000),
      source: "PRIVATE_FILE",
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { key: "", source: null };
    throw error;
  }
}

export async function saveProviderKey(provider, apiKey) {
  const providerId = normalizedProvider(provider);
  if (!providerId) {
    const error = new Error("INVALID_AI_PROVIDER");
    error.statusCode = 400;
    throw error;
  }
  const value = cleanText(apiKey, 1000);
  if (value.length < 20) {
    const error = new Error("INVALID_PROVIDER_API_KEY");
    error.statusCode = 400;
    throw error;
  }
  const keyPath = providerKeyPath(providerId);
  await fs.mkdir(path.dirname(keyPath), { recursive: true });
  await fs.writeFile(keyPath, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(keyPath, 0o600);
}

export async function removeProviderKey(provider) {
  const providerId = normalizedProvider(provider);
  if (!providerId) return;
  await fs.rm(providerKeyPath(providerId), { force: true });
}

function defaultProviderConfig() {
  return {
    schemaVersion: PROVIDER_CONFIG_VERSION,
    activeProvider: DEFAULT_PROVIDER,
    models: Object.fromEntries(
      Object.values(LISTENING_GUIDE_PROVIDERS).map((provider) => [
        provider.id,
        provider.defaultModel,
      ]),
    ),
  };
}

export async function readProviderConfig(configPath = getProviderConfigPath()) {
  const fallback = defaultProviderConfig();
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
    const activeProvider = normalizedProvider(parsed.activeProvider) || DEFAULT_PROVIDER;
    const models = { ...fallback.models };
    for (const provider of Object.keys(LISTENING_GUIDE_PROVIDERS)) {
      models[provider] =
        cleanText(parsed.models?.[provider], 120) ||
        LISTENING_GUIDE_PROVIDERS[provider].defaultModel;
    }
    return { ...fallback, activeProvider, models };
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function saveProviderConfig(
  updates = {},
  configPath = getProviderConfigPath(),
) {
  const current = await readProviderConfig(configPath);
  const activeProvider = normalizedProvider(updates.activeProvider || current.activeProvider);
  if (!activeProvider) {
    const error = new Error("INVALID_AI_PROVIDER");
    error.statusCode = 400;
    throw error;
  }
  const next = {
    ...current,
    activeProvider,
    models: { ...current.models },
  };
  if (updates.model !== undefined) {
    const model = cleanText(updates.model, 120);
    if (!/^[a-zA-Z0-9._:-]{3,120}$/.test(model)) {
      const error = new Error("INVALID_PROVIDER_MODEL");
      error.statusCode = 400;
      throw error;
    }
    next.models[activeProvider] = model;
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(configPath, 0o600);
  return next;
}

export async function providerPublicStatus() {
  const config = await readProviderConfig();
  const providers = {};
  for (const provider of Object.keys(LISTENING_GUIDE_PROVIDERS)) {
    const credentials = await readProviderKey(provider);
    providers[provider] = {
      configured: Boolean(credentials.key),
      source: credentials.source,
      model: config.models[provider],
      label: LISTENING_GUIDE_PROVIDERS[provider].label,
    };
  }
  const active = providers[config.activeProvider];
  return {
    activeProvider: config.activeProvider,
    providers,
    configured: Boolean(active?.configured),
    source: active?.source ?? null,
    model: active?.model ?? "",
  };
}

async function removeAllProviderSettings() {
  await Promise.all(
    Object.keys(LISTENING_GUIDE_PROVIDERS).map((provider) => removeProviderKey(provider)),
  );
  await fs.rm(getProviderConfigPath(), { force: true });
}

function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: null, guides: {}, history: {} };
}

export async function readListeningGuideStore(storePath = getListeningGuidePath()) {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath, "utf8"));
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      guides: parsed.guides && typeof parsed.guides === "object" ? parsed.guides : {},
      history: parsed.history && typeof parsed.history === "object" ? parsed.history : {},
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(storePath, store) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const temporaryPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, storePath);
    await fs.chmod(storePath, 0o600);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function sanitizeIdentity(payload = {}) {
  return {
    originalTitle: cleanText(payload.originalTitle ?? payload.title, 300),
    artists: Array.isArray(payload.artists)
      ? payload.artists.map((artist) => cleanText(artist, 200)).filter(Boolean).slice(0, 12)
      : [],
    releaseDate: cleanText(payload.releaseDate, 20) || null,
    releaseType: cleanText(payload.releaseType, 40) || null,
    editionTypes: Array.isArray(payload.editionTypes)
      ? payload.editionTypes.map((value) => cleanText(value, 80)).filter(Boolean).slice(0, 12)
      : [],
    externalIdentities: Array.isArray(payload.externalIdentities)
      ? payload.externalIdentities
          .map((value) => ({
            provider: cleanText(value?.provider, 50),
            idOrUrl: cleanText(value?.idOrUrl, 1000),
          }))
          .filter((value) => value.provider && value.idOrUrl)
          .slice(0, 12)
      : [],
  };
}

export function publicListeningGuideIdentity(release = {}) {
  return sanitizeIdentity({
    originalTitle: release.title,
    artists: release.artists,
    releaseDate: release.releaseDate,
    releaseType: release.releaseType,
    editionTypes: release.editionTypes ?? release.versionAttributes ?? [],
    externalIdentities: (release.externalLinks ?? [])
      .filter((link) => CONFIRMED_LINK_STATUSES.has(link?.status))
      .map((link) => ({ provider: link.provider, idOrUrl: link.url })),
  });
}

function fingerprint(identity) {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

async function acquireStoreFileLock(storePath) {
  const lockPath = `${storePath}.lock`;
  const startedAt = Date.now();
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  while (Date.now() - startedAt < STORE_LOCK_TIMEOUT_MS) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return async () => {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const details = await fs.stat(lockPath);
        if (Date.now() - details.mtimeMs > STORE_LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const error = new Error("LISTENING_GUIDE_STORE_BUSY");
  error.statusCode = 503;
  throw error;
}

function withStoreLock(storePath, task) {
  const run = async () => {
    const release = await acquireStoreFileLock(storePath);
    try {
      return await task();
    } finally {
      await release();
    }
  };
  const pending = storeWriteQueue.then(run, run);
  storeWriteQueue = pending.catch(() => {});
  return pending;
}

function confirmedIdentitySources(identity, accessedAt) {
  return identity.externalIdentities.map((entry, index) => ({
    id: `identity-${index + 1}`,
    title: `${entry.provider} 精确条目`,
    publisher: entry.provider,
    author: null,
    publishedAt: null,
    url: entry.idOrUrl,
    sourceType: "DATABASE",
    supports: ["identity"],
    accessedAt,
  }));
}

export function createFallbackGuide(releaseId, rawIdentity, now = new Date()) {
  const identity = sanitizeIdentity(rawIdentity);
  const updatedAt = now.toISOString();
  return {
    id: `guide-${randomUUID()}`,
    releaseId: cleanText(releaseId, 200),
    status: "INSUFFICIENT_SOURCES",
    identityFingerprint: fingerprint(identity),
    releaseIdentitySnapshot: identity,
    summary: null,
    sections: [],
    highlightTracks: [],
    credits: {},
    reception: {
      professional: null,
      audience: null,
      awardsAndCharts: null,
    },
    sources: confirmedIdentitySources(identity, updatedAt),
    confidence: null,
    promptVersion: PROMPT_VERSION,
    provider: "RECORDSHELF_LOCAL_FALLBACK",
    generatedAt: null,
    updatedAt,
    previousVersionId: null,
    needsRefresh: false,
    errorCode: "RESEARCH_PROVIDER_UNAVAILABLE",
    errorMessage: "已建立指南档案；尚无足够的可核验研究资料，正文保持留空。",
  };
}

export function createPilotGuide(releaseId, rawIdentity, now = new Date()) {
  const identity = sanitizeIdentity(rawIdentity);
  if (!isPilotIdentity(identity)) {
    const error = new Error("PILOT_RELEASE_ONLY");
    error.statusCode = 409;
    throw error;
  }
  const generatedAt = now.toISOString();
  return {
    id: `guide-${randomUUID()}`,
    releaseId: cleanText(releaseId, 200),
    status: "READY",
    identityFingerprint: fingerprint(identity),
    releaseIdentitySnapshot: identity,
    summary: "从《SABLE,》的自我拆解，到“fABLE”重新容纳爱与日光，Bon Iver 用一张唱片完成了由阴影走向亲密的慢速换气。",
    sections: PILOT_SECTIONS,
    highlightTracks: [
      {
        title: "S P E Y S I D E",
        reason: "最接近唱片裸露内核的一首：道歉、留白与踏板钢棒吉他彼此牵引。",
        sourceIds: ["official-album", "new-yorker-interview"],
      },
      {
        title: "Walk Home",
        reason: "后半段的暖色中心，节拍与和声让“重新前进”真正进入身体。",
        sourceIds: ["official-album", "guardian-review"],
      },
      {
        title: "There’s A Rhythmn",
        reason: "不把希望写成口号，而是把它放回日常关系与重复的生活节奏。",
        sourceIds: ["official-album", "pitchfork-review"],
      },
    ],
    credits: {
      primaryArtist: "Bon Iver",
      principalWriter: "Justin Vernon",
      producers: ["Justin Vernon", "Jim-E Stack"],
      label: "Jagjaguwar",
      releasedAt: "2025-04-11",
    },
    reception: {
      professional: "Pitchfork 与《卫报》肯定其更直接的灵魂乐与流行触感；美联社对部分数码拼贴保留意见。",
      audience: "社区听感存在分歧：部分听众偏爱《SABLE,》的极简裸露，也有人更喜欢后半段的温暖与开放。",
      awardsAndCharts: null,
    },
    sources: PILOT_SOURCES.map((source) => ({ ...source, accessedAt: generatedAt })),
    confidence: "HIGH",
    promptVersion: PROMPT_VERSION,
    provider: "RECORDSHELF_PILOT_RESEARCH",
    generatedAt,
    updatedAt: generatedAt,
    previousVersionId: null,
    needsRefresh: false,
    errorCode: null,
    errorMessage: null,
  };
}

export async function savePilotGuide(
  releaseId,
  identity,
  { refresh = false, storePath = getListeningGuidePath(), now = new Date() } = {},
) {
  return withStoreLock(storePath, async () => {
    const store = await readListeningGuideStore(storePath);
    const current = store.guides[releaseId] ?? null;
    if (current && !refresh) return { guide: current, cached: true };
    const guide = createPilotGuide(releaseId, identity, now);
    if (current) {
      guide.previousVersionId = current.id;
      store.history[releaseId] = [current, ...(store.history[releaseId] ?? [])].slice(
        0,
        MAX_HISTORY_VERSIONS,
      );
    }
    store.guides[releaseId] = guide;
    store.updatedAt = guide.updatedAt;
    await writeStore(storePath, store);
    return { guide, cached: false };
  });
}

function extractResponseText(responsePayload) {
  for (const item of responsePayload?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        return content.text.trim();
      }
    }
  }
  return "";
}

function extractSearchSources(responsePayload) {
  const sources = [];
  for (const item of responsePayload?.output ?? []) {
    if (item?.type !== "web_search_call") continue;
    for (const source of item?.action?.sources ?? []) {
      if (!source?.url) continue;
      sources.push({ url: source.url, title: source.title ?? source.url });
    }
  }
  return sources;
}

function extractGeminiResponseText(responsePayload) {
  if (typeof responsePayload?.output_text === "string") {
    return responsePayload.output_text.trim();
  }
  const interactionText = (responsePayload?.steps ?? [])
    .filter((step) => step?.type === "model_output")
    .flatMap((step) => step?.content ?? step?.output ?? [])
    .map((item) => (typeof item?.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("")
    .trim();
  if (interactionText) return interactionText;
  return (responsePayload?.candidates ?? [])
    .flatMap((candidate) => candidate?.content?.parts ?? [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("")
    .trim();
}

function extractGeminiSearchSources(responsePayload) {
  const sources = [];
  const addSource = (source) => {
    const url = source?.url ?? source?.uri;
    if (!url) return;
    sources.push({
      url,
      title: cleanText(source?.title, 500) || url,
    });
  };
  for (const step of responsePayload?.steps ?? []) {
    if (step?.type === "google_search_result") {
      for (const source of step?.result ?? step?.results ?? []) addSource(source);
    }
    if (step?.type !== "model_output") continue;
    for (const content of step?.content ?? step?.output ?? []) {
      for (const annotation of content?.annotations ?? []) {
        if (annotation?.type === "url_citation") {
          addSource(annotation?.url_citation ?? annotation);
        }
      }
    }
  }
  for (const candidate of responsePayload?.candidates ?? []) {
    for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
      if (!chunk?.web?.uri) continue;
      sources.push({
        url: chunk.web.uri,
        title: cleanText(chunk.web.title, 500) || chunk.web.uri,
      });
    }
  }
  return sources;
}

function parseModelJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

function normalizeSourceUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function normalizedResearchGuide(
  releaseId,
  identity,
  payload,
  responsePayload,
  now,
  providerMetadata = {},
) {
  const generatedAt = now.toISOString();
  const searchedSources = Array.isArray(providerMetadata.searchedSources)
    ? providerMetadata.searchedSources
    : extractSearchSources(responsePayload);
  const allowedUrls = new Map(
    [
      ...searchedSources,
      ...identity.externalIdentities.map((entry) => ({
        url: entry.idOrUrl,
        title: `${entry.provider} 精确条目`,
      })),
    ].map((source) => [normalizeSourceUrl(source.url), source]),
  );
  const sources = (Array.isArray(payload?.sources) ? payload.sources : [])
    .filter((source) => allowedUrls.has(normalizeSourceUrl(source?.url)))
    .map((source, index) => ({
      id: cleanText(source.id, 50) || `S${index + 1}`,
      title:
        cleanText(source.title, 500) ||
        allowedUrls.get(normalizeSourceUrl(source.url)).title,
      publisher: cleanText(source.publisher, 200) || null,
      author: cleanText(source.author, 200) || null,
      publishedAt: cleanText(source.publishedAt, 30) || null,
      url: source.url,
      sourceType: cleanText(source.sourceType, 50) || "DATABASE",
      supports: Array.isArray(source.supports)
        ? source.supports.map((value) => cleanText(value, 80)).filter(Boolean).slice(0, 20)
        : [],
      accessedAt: generatedAt,
    }));
  const sourceIds = new Set(sources.map((source) => source.id));
  const modelIdentity = {
    originalTitle: payload?.releaseIdentity?.originalTitle,
    artists: payload?.releaseIdentity?.artists,
  };
  const identityMatches = publicIdentityKey(modelIdentity) === publicIdentityKey(identity);
  const sections = (Array.isArray(payload?.sections) ? payload.sections : [])
    .map((section) => ({
      key: cleanText(section.key, 50),
      title: cleanText(section.title, 200),
      body: cleanText(section.body, 5000),
      sourceIds: Array.isArray(section.sourceIds)
        ? section.sourceIds.filter((id) => sourceIds.has(id))
        : [],
    }))
    .filter((section) => section.key && section.title && section.body && section.sourceIds.length);
  const ready =
    payload?.status === "READY" &&
    identityMatches &&
    sources.length >= 2 &&
    sections.length === 7 &&
    cleanText(payload.summary, 2000);

  if (!ready) {
    return {
      ...createFallbackGuide(releaseId, identity, now),
      status: identityMatches ? "INSUFFICIENT_SOURCES" : "UNVERIFIED",
      sources,
      provider: providerMetadata.provider || "OPENAI_RESPONSES_WEB_SEARCH",
      model: providerMetadata.model || null,
      errorCode: identityMatches ? "INSUFFICIENT_SOURCES" : "UNVERIFIED",
      errorMessage:
        cleanText(payload?.reason, 500) ||
        (identityMatches
          ? "联网研究未取得足够的可核验证据，正文保持留空。"
          : "联网结果无法确认属于同一发行版本，正文保持留空。"),
    };
  }

  return {
    id: `guide-${randomUUID()}`,
    releaseId: cleanText(releaseId, 200),
    status: "READY",
    identityFingerprint: fingerprint(identity),
    releaseIdentitySnapshot: identity,
    summary: cleanText(payload.summary, 2000),
    sections,
    highlightTracks: (Array.isArray(payload.highlightTracks) ? payload.highlightTracks : [])
      .map((track) => ({
        title: cleanText(track.title, 300),
        reason: cleanText(track.reason, 1000),
        sourceIds: Array.isArray(track.sourceIds)
          ? track.sourceIds.filter((id) => sourceIds.has(id))
          : [],
      }))
      .filter((track) => track.title && track.reason && track.sourceIds.length)
      .slice(0, 6),
    credits: payload.credits && typeof payload.credits === "object" ? payload.credits : {},
    reception:
      payload.reception && typeof payload.reception === "object"
        ? payload.reception
        : { professional: null, audience: null, awardsAndCharts: null },
    sources,
    confidence: ["HIGH", "MEDIUM"].includes(payload.confidence)
      ? payload.confidence
      : "MEDIUM",
    promptVersion: PROMPT_VERSION,
    provider: providerMetadata.provider || "OPENAI_RESPONSES_WEB_SEARCH",
    model:
      providerMetadata.model ||
      process.env.RECORDSHELF_OPENAI_MODEL ||
      DEFAULT_OPENAI_MODEL,
    responseId:
      cleanText(providerMetadata.responseId, 200) ||
      cleanText(responsePayload?.id, 200) ||
      null,
    generatedAt,
    updatedAt: generatedAt,
    previousVersionId: null,
    needsRefresh: false,
    errorCode: null,
    errorMessage: null,
  };
}

export function normalizedCodexResearchGuide(releaseId, rawIdentity, payload, now = new Date()) {
  const identity = sanitizeIdentity(rawIdentity);
  const sourceAllowlist = (Array.isArray(payload?.sources) ? payload.sources : [])
    .map((source) => ({ url: source?.url, title: source?.title }))
    .filter((source) => normalizeSourceUrl(source.url));
  const guide = normalizedResearchGuide(
    releaseId,
    identity,
    payload,
    {
      id: null,
      output: [{ type: "web_search_call", action: { sources: sourceAllowlist } }],
    },
    now,
  );
  return {
    ...guide,
    provider: "CODEX_CHATGPT_WEB_RESEARCH",
    model: process.env.RECORDSHELF_CODEX_MODEL || "chatgpt-account-default",
    responseId: null,
  };
}

export async function saveCodexResearchGuide(
  releaseId,
  rawIdentity,
  payload,
  { storePath = getListeningGuidePath(), now = new Date(), force = false } = {},
) {
  return withStoreLock(storePath, async () => {
    const store = await readListeningGuideStore(storePath);
    const current = store.guides[releaseId] ?? null;
    if (current?.status === "READY" && !force) {
      return { guide: current, cached: true };
    }
    const guide = normalizedCodexResearchGuide(releaseId, rawIdentity, payload, now);
    if (current) {
      guide.previousVersionId = current.id;
      store.history[releaseId] = [current, ...(store.history[releaseId] ?? [])].slice(
        0,
        MAX_HISTORY_VERSIONS,
      );
    }
    store.guides[releaseId] = guide;
    store.updatedAt = guide.updatedAt;
    await writeStore(storePath, store);
    return { guide, cached: false };
  });
}

async function resolveCodexExecutable() {
  const configured = cleanText(process.env.RECORDSHELF_CODEX_CLI, 1000);
  const candidates = [
    configured,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next trusted local installation path.
    }
  }
  return "codex";
}

function codexPrompt(identity, template) {
  return `${template
    .replace("{{RELEASE_IDENTITY_JSON}}", JSON.stringify(identity, null, 2))
    .replace("{{SOURCE_BUNDLE_JSON}}", "[]")}\n\n额外执行要求：使用本次 Codex 任务提供的实时网页搜索完成研究。只研究这一张发行；不要读取或修改 RecordShelf 文件，不要使用用户评分、评论或听过时间。来源 URL 必须是你实际搜索并打开核验过的页面。最终只返回符合指定 JSON Schema 的 JSON。`;
}

export async function requestCodexResearch({
  identity: rawIdentity,
  timeoutMs = CODEX_RESEARCH_TIMEOUT_MS,
  executable,
  onProgress = () => {},
} = {}) {
  const identity = sanitizeIdentity(rawIdentity);
  if (!identity.originalTitle || !identity.artists.length) {
    throw providerRequestError("INVALID_RELEASE_IDENTITY", 400);
  }
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recordshelf-codex-guide-manual-"),
  );
  const schemaPath = path.join(temporaryDirectory, "schema.json");
  const outputPath = path.join(temporaryDirectory, "result.json");
  const promptTemplate = await fs.readFile(
    path.join(APP_DIRECTORY, "prompts", "listening-guide.v1.md"),
    "utf8",
  );
  const cliPath = executable || (await resolveCodexExecutable());
  const args = [
    "--search",
    "exec",
    "--json",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-C",
    temporaryDirectory,
  ];
  if (process.env.RECORDSHELF_CODEX_MODEL) {
    args.push("--model", process.env.RECORDSHELF_CODEX_MODEL);
  }
  args.push("-");

  try {
    onProgress({ stage: "PREPARING" });
    await fs.writeFile(schemaPath, `${JSON.stringify(LISTENING_GUIDE_SCHEMA)}\n`, {
      mode: 0o600,
    });
    await new Promise((resolve, reject) => {
      const child = spawn(cliPath, args, {
        cwd: temporaryDirectory,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      let stdout = "";
      let stdoutRaw = "";
      let settled = false;
      let latestStage = "";
      const reportStage = (stage) => {
        if (!CODEX_JOB_STAGES.has(stage) || latestStage === stage) return;
        latestStage = stage;
        onProgress({ stage });
      };
      reportStage("SEARCHING");
      const verifyTimer = setTimeout(() => reportStage("VERIFYING"), 20_000);
      const writingTimer = setTimeout(() => reportStage("WRITING"), 55_000);
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(verifyTimer);
        clearTimeout(writingTimer);
        callback();
      };
      child.stdout.on("data", (chunk) => {
        stdoutRaw = `${stdoutRaw}${chunk}`.slice(-32_000);
        stdout = `${stdout}${chunk}`;
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            const eventType = cleanText(event?.type, 100).toLowerCase();
            const itemType = cleanText(event?.item?.type, 100).toLowerCase();
            if (eventType.includes("web_search") || itemType.includes("web_search")) {
              reportStage("SEARCHING");
            } else if (itemType === "reasoning") {
              reportStage("VERIFYING");
            } else if (itemType === "agent_message") {
              reportStage("WRITING");
            }
          } catch {
            // Codex progress is optional; never expose or depend on raw output.
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-8000);
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(providerRequestError("CODEX_RESEARCH_TIMEOUT", 504)));
      }, timeoutMs);
      child.once("error", (error) => {
        const code = error?.code === "ENOENT" ? "CODEX_CLI_UNAVAILABLE" : "CODEX_RESEARCH_FAILED";
        finish(() => reject(providerRequestError(code, 503)));
      });
      child.once("exit", (code) => {
        if (code === 0) {
          finish(resolve);
          return;
        }
        const diagnostic = `${stderr}\n${stdoutRaw}`;
        const errorCode = /not supported when using Codex with a ChatGPT account/i.test(diagnostic)
          ? "CODEX_MODEL_UNSUPPORTED"
          : /login|auth|sign.?in|unauthorized/i.test(diagnostic)
            ? "CODEX_AUTH_REQUIRED"
            : "CODEX_RESEARCH_FAILED";
        finish(() => reject(providerRequestError(errorCode, 502)));
      });
      child.stdin.end(codexPrompt(identity, promptTemplate));
    });
    return JSON.parse(await fs.readFile(outputPath, "utf8"));
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

function publicCodexJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    releaseId: job.releaseId,
    status: job.status,
    stage: job.stage,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt ?? null,
    error: job.error ?? null,
    activity: (job.activity ?? []).map(({ stage, at }) => ({ stage, at })),
  };
}

function updateCodexJobStage(job, stage, now = new Date()) {
  if (!CODEX_JOB_STAGES.has(stage) || job.stage === stage) return;
  if (
    CODEX_JOB_STAGE_ORDER.indexOf(stage) <
    CODEX_JOB_STAGE_ORDER.indexOf(job.stage)
  ) {
    return;
  }
  const at = now.toISOString();
  job.stage = stage;
  job.updatedAt = at;
  job.activity ??= [];
  job.activity.push({ stage, at });
}

function pruneCodexJobs() {
  const cutoff = Date.now() - CODEX_JOB_RETENTION_MS;
  for (const [releaseId, job] of codexResearchJobs) {
    if (job.status !== "RUNNING" && Date.parse(job.finishedAt ?? 0) < cutoff) {
      codexResearchJobs.delete(releaseId);
    }
  }
}

export function getCodexListeningGuideJob(releaseId) {
  pruneCodexJobs();
  return publicCodexJob(codexResearchJobs.get(cleanText(releaseId, 200)));
}

export function startCodexListeningGuideJob(
  releaseId,
  rawIdentity,
  { runner = requestCodexResearch, storePath = getListeningGuidePath(), now = () => new Date() } = {},
) {
  const safeReleaseId = cleanText(releaseId, 200);
  const identity = sanitizeIdentity(rawIdentity);
  if (!safeReleaseId || !identity.originalTitle || !identity.artists.length) {
    throw providerRequestError("INVALID_RELEASE_IDENTITY", 400);
  }
  const existing = codexResearchJobs.get(safeReleaseId);
  if (existing?.status === "RUNNING") return publicCodexJob(existing);

  const startedAt = now().toISOString();
  const job = {
    id: `codex-guide-job-${randomUUID()}`,
    releaseId: safeReleaseId,
    status: "RUNNING",
    stage: "PREPARING",
    startedAt,
    updatedAt: startedAt,
    finishedAt: null,
    error: null,
    activity: [{ stage: "PREPARING", at: startedAt }],
  };
  codexResearchJobs.set(safeReleaseId, job);
  job.promise = Promise.resolve()
    .then(() =>
      runner({
        identity,
        onProgress: ({ stage } = {}) => updateCodexJobStage(job, stage, now()),
      }),
    )
    .then((payload) => {
      updateCodexJobStage(job, "SAVING", now());
      return saveCodexResearchGuide(safeReleaseId, identity, payload, {
        storePath,
        now: now(),
        force: true,
      });
    })
    .then(() => {
      job.status = "COMPLETED";
      job.finishedAt = now().toISOString();
      updateCodexJobStage(job, "COMPLETED", now());
    })
    .catch((error) => {
      const safeErrors = new Set([
        "CODEX_CLI_UNAVAILABLE",
        "CODEX_AUTH_REQUIRED",
        "CODEX_RESEARCH_TIMEOUT",
        "CODEX_MODEL_UNSUPPORTED",
        "INVALID_RELEASE_IDENTITY",
      ]);
      job.status = "FAILED";
      job.finishedAt = now().toISOString();
      job.error = safeErrors.has(error?.message)
        ? error.message
        : "CODEX_RESEARCH_FAILED";
    });
  return publicCodexJob(job);
}

export async function researchListeningGuide(releaseId, rawIdentity, options = {}) {
  const identity = sanitizeIdentity(rawIdentity);
  const providerConfig = await readProviderConfig();
  const provider =
    normalizedProvider(options.provider || providerConfig.activeProvider) || DEFAULT_PROVIDER;
  const { key } = await readProviderKey(provider);
  if (!key) {
    const error = new Error("RESEARCH_PROVIDER_UNAVAILABLE");
    error.statusCode = 503;
    throw error;
  }
  const promptPath = new URL("../prompts/listening-guide.v1.md", import.meta.url);
  const prompt = (await fs.readFile(promptPath, "utf8")).replace(
    "{{RELEASE_IDENTITY_JSON}}",
    JSON.stringify(identity, null, 2),
  ).replace("{{SOURCE_BUNDLE_JSON}}", "[]");
  const fetchImpl = options.fetchImpl || fetch;
  const model =
    (provider === "GEMINI"
      ? process.env.RECORDSHELF_GEMINI_MODEL
      : process.env.RECORDSHELF_OPENAI_MODEL) ||
    providerConfig.models[provider] ||
    LISTENING_GUIDE_PROVIDERS[provider].defaultModel;
  const research =
    provider === "GEMINI"
      ? await requestGeminiResearch({ key, model, prompt, fetchImpl })
      : await requestOpenAiResearch({ key, model, prompt, fetchImpl });
  const guide = normalizedResearchGuide(
    releaseId,
    identity,
    parseModelJson(research.outputText),
    research.responsePayload,
    options.now ?? new Date(),
    research.providerMetadata,
  );

  const storePath = options.storePath ?? getListeningGuidePath();
  return withStoreLock(storePath, async () => {
    const store = await readListeningGuideStore(storePath);
    const current = store.guides[releaseId] ?? null;
    if (current) {
      guide.previousVersionId = current.id;
      store.history[releaseId] = [current, ...(store.history[releaseId] ?? [])].slice(
        0,
        MAX_HISTORY_VERSIONS,
      );
    }
    store.guides[releaseId] = guide;
    store.updatedAt = guide.updatedAt;
    await writeStore(storePath, store);
    return { guide, cached: false };
  });
}

function providerRequestError(code, statusCode) {
  const error = new Error(code);
  error.statusCode = statusCode || 502;
  return error;
}

export async function requestOpenAiResearch({ key, model, prompt, fetchImpl = fetch }) {
  const apiResponse = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: "medium" },
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
      text: {
        format: {
          type: "json_schema",
          name: "recordshelf_listening_guide",
          strict: true,
          schema: LISTENING_GUIDE_SCHEMA,
        },
      },
      input: prompt,
    }),
  });
  const responsePayload = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    throw providerRequestError("OPENAI_REQUEST_FAILED", apiResponse.status);
  }
  const outputText = extractResponseText(responsePayload);
  if (!outputText) throw providerRequestError("OPENAI_EMPTY_RESPONSE", 502);
  return {
    outputText,
    responsePayload,
    providerMetadata: {
      provider: "OPENAI_RESPONSES_WEB_SEARCH",
      model,
      responseId: responsePayload?.id,
      searchedSources: extractSearchSources(responsePayload),
    },
  };
}

export async function requestGeminiResearch({ key, model, prompt, fetchImpl = fetch }) {
  const safeModel = cleanText(model, 120);
  if (!/^[a-zA-Z0-9._:-]{3,120}$/.test(safeModel)) {
    throw providerRequestError("INVALID_PROVIDER_MODEL", 400);
  }
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/interactions";
  const apiResponse = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      model: safeModel,
      input: prompt,
      tools: [{ type: "google_search" }],
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: LISTENING_GUIDE_SCHEMA,
      },
    }),
  });
  const responsePayload = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    const errorCode =
      apiResponse.status === 429
        ? "GEMINI_QUOTA_EXCEEDED"
        : [401, 403].includes(apiResponse.status)
          ? "GEMINI_API_KEY_INVALID"
          : apiResponse.status === 404
            ? "GEMINI_MODEL_UNAVAILABLE"
            : apiResponse.status === 400
              ? "GEMINI_REQUEST_INVALID"
              : apiResponse.status >= 500
                ? "GEMINI_TEMPORARILY_UNAVAILABLE"
                : "GEMINI_REQUEST_FAILED";
    throw providerRequestError(errorCode, apiResponse.status);
  }
  const outputText = extractGeminiResponseText(responsePayload);
  if (!outputText) throw providerRequestError("GEMINI_EMPTY_RESPONSE", 502);
  return {
    outputText,
    responsePayload,
    providerMetadata: {
      provider: "GEMINI_GOOGLE_SEARCH",
      model: safeModel,
      responseId: responsePayload?.id ?? responsePayload?.responseId,
      searchedSources: extractGeminiSearchSources(responsePayload),
    },
  };
}

export async function backfillListeningGuides(
  releases,
  { storePath = getListeningGuidePath(), now = new Date() } = {},
) {
  return withStoreLock(storePath, async () => {
    const store = await readListeningGuideStore(storePath);
    const result = {
      total: Array.isArray(releases) ? releases.length : 0,
      created: 0,
      existing: 0,
      identityUpdated: 0,
      ready: 0,
      insufficient: 0,
      skipped: 0,
    };
    let changed = false;
    const timestamp = now.toISOString();

    for (const rawRelease of Array.isArray(releases) ? releases : []) {
      const releaseId = cleanText(rawRelease?.id, 200);
      const identity = sanitizeIdentity(rawRelease);
      if (!releaseId || !identity.originalTitle || !identity.artists.length) {
        result.skipped += 1;
        continue;
      }
      const nextFingerprint = fingerprint(identity);
      const current = store.guides[releaseId] ?? null;
      if (!current) {
        const guide = isPilotIdentity(identity)
          ? createPilotGuide(releaseId, identity, now)
          : createFallbackGuide(releaseId, identity, now);
        store.guides[releaseId] = guide;
        result.created += 1;
        result[guide.status === "READY" ? "ready" : "insufficient"] += 1;
        changed = true;
        continue;
      }

      result.existing += 1;
      result[current.status === "READY" ? "ready" : "insufficient"] += 1;
      if (current.identityFingerprint !== nextFingerprint) {
        store.guides[releaseId] = {
          ...current,
          identityFingerprint: nextFingerprint,
          releaseIdentitySnapshot: identity,
          sources:
            current.status === "READY"
              ? current.sources
              : confirmedIdentitySources(identity, timestamp),
          needsRefresh: current.status === "READY",
          identityChangedAt: timestamp,
          updatedAt: timestamp,
        };
        result.identityUpdated += 1;
        changed = true;
      }
    }

    if (changed) {
      store.updatedAt = timestamp;
      await writeStore(storePath, store);
    }
    return result;
  });
}

function json(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

async function requestJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("BODY_TOO_LARGE");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("INVALID_JSON");
    error.statusCode = 400;
    throw error;
  }
}

export async function handleListeningGuideRequest(request, response) {
  const url = new URL(request.url, "http://127.0.0.1:4173");
  if (url.pathname === "/api/listening-guides/statuses") {
    if (request.method !== "GET") {
      json(response, 405, { error: "METHOD_NOT_ALLOWED" });
      return true;
    }
    const store = await readListeningGuideStore();
    json(response, 200, {
      updatedAt: store.updatedAt,
      statuses: Object.fromEntries(
        Object.entries(store.guides).map(([releaseId, guide]) => [
          releaseId,
          guide?.status ?? "EMPTY",
        ]),
      ),
    });
    return true;
  }
  if (url.pathname === "/api/listening-guides/provider") {
    try {
      if (request.method === "GET") {
        json(response, 200, await providerPublicStatus());
        return true;
      }
      if (request.method === "PUT") {
        const payload = await requestJson(request);
        const provider = normalizedProvider(payload.provider || DEFAULT_PROVIDER);
        if (!provider) {
          const error = new Error("INVALID_AI_PROVIDER");
          error.statusCode = 400;
          throw error;
        }
        const existing = await readProviderKey(provider);
        if (cleanText(payload.apiKey, 1000)) {
          await saveProviderKey(provider, payload.apiKey);
        } else if (!existing.key) {
          const error = new Error("PROVIDER_API_KEY_REQUIRED");
          error.statusCode = 400;
          throw error;
        }
        await saveProviderConfig({ activeProvider: provider, model: payload.model });
        json(response, 200, await providerPublicStatus());
        return true;
      }
      if (request.method === "DELETE") {
        const requestedProvider = normalizedProvider(url.searchParams.get("provider"));
        if (url.searchParams.has("provider") && !requestedProvider) {
          const error = new Error("INVALID_AI_PROVIDER");
          error.statusCode = 400;
          throw error;
        }
        if (requestedProvider) {
          await removeProviderKey(requestedProvider);
        } else {
          await removeAllProviderSettings();
        }
        json(response, 200, await providerPublicStatus());
        return true;
      }
      json(response, 405, { error: "METHOD_NOT_ALLOWED" });
      return true;
    } catch (error) {
      const safeErrors = new Set([
        "INVALID_AI_PROVIDER",
        "INVALID_PROVIDER_API_KEY",
        "INVALID_PROVIDER_MODEL",
        "PROVIDER_API_KEY_REQUIRED",
      ]);
      json(response, error?.statusCode ?? 500, {
        error: safeErrors.has(error?.message) ? error.message : "PROVIDER_ERROR",
      });
      return true;
    }
  }
  if (url.pathname === "/api/listening-guides/backfill") {
    try {
      if (request.method !== "POST") {
        json(response, 405, { error: "METHOD_NOT_ALLOWED" });
        return true;
      }
      const payload = await requestJson(request);
      const result = await backfillListeningGuides(payload.releases);
      json(response, 200, result);
      return true;
    } catch (error) {
      json(response, error?.statusCode ?? 500, {
        error: error?.message ?? "LISTENING_GUIDE_BACKFILL_ERROR",
      });
      return true;
    }
  }
  const match = url.pathname.match(
    /^\/api\/releases\/([^/]+)\/listening-guide(?:\/(generate|refresh|codex-refresh))?$/,
  );
  if (!match) return false;
  const releaseId = decodeURIComponent(match[1]);
  const action = match[2] ?? null;
  try {
    if (!action && request.method === "GET") {
      const store = await readListeningGuideStore();
      const identity = {
        originalTitle: url.searchParams.get("title") ?? "",
        artists: url.searchParams.getAll("artist"),
      };
      json(response, 200, {
        status: store.guides[releaseId]?.status ?? "EMPTY",
        guide: store.guides[releaseId] ?? null,
        codexJob: getCodexListeningGuideJob(releaseId),
        pilotEligible: isPilotIdentity(identity),
        phase: "CACHE_V1",
      });
      return true;
    }
    if (action === "codex-refresh" && request.method === "POST") {
      const payload = await requestJson(request);
      const currentStore = await readListeningGuideStore();
      const job = startCodexListeningGuideJob(releaseId, payload);
      json(response, 202, {
        guide: currentStore.guides[releaseId] ?? null,
        codexJob: job,
        phase: "CODEX_LOCAL_V1",
      });
      return true;
    }
    if (["generate", "refresh"].includes(action) && request.method === "POST") {
      const payload = await requestJson(request);
      const currentStore = await readListeningGuideStore();
      const current = currentStore.guides[releaseId] ?? null;
      if (action === "generate" && current?.status === "READY") {
        json(response, 200, { guide: current, cached: true, phase: "CACHE_V1" });
        return true;
      }
      const result = await researchListeningGuide(releaseId, payload);
      json(response, 200, { ...result, phase: "CACHE_V1" });
      return true;
    }
    json(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  } catch (error) {
    json(response, error?.statusCode ?? 500, {
      error: error?.message ?? "LISTENING_GUIDE_ERROR",
    });
    return true;
  }
}
