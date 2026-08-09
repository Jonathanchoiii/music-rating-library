import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LISTENING_GUIDE_SCHEMA,
  publicListeningGuideIdentity,
  readListeningGuideStore,
  saveCodexResearchGuide,
} from "../listening-guides/index.mjs";

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libraryPath = path.join(appDirectory, ".private", "neodb-library.local.json");
const progressPath = path.join(appDirectory, ".private", "listening-guide-codex-progress.json");
const daemonLogPath = path.join(appDirectory, ".private", "listening-guide-codex-batch.log");
const daemonPidPath = path.join(appDirectory, ".private", "listening-guide-codex-batch.pid");
const promptPath = path.join(appDirectory, "prompts", "listening-guide.v1.md");
const cliPath = process.env.RECORDSHELF_CODEX_CLI || "codex";
let progressWriteQueue = Promise.resolve();

if (process.argv.includes("--daemon")) {
  let runningPid = null;
  try {
    runningPid = Number.parseInt(await fs.readFile(daemonPidPath, "utf8"), 10);
    if (Number.isFinite(runningPid)) process.kill(runningPid, 0);
  } catch {
    runningPid = null;
  }
  if (runningPid) {
    process.stdout.write(`${JSON.stringify({ event: "ALREADY_RUNNING", pid: runningPid, logPath: daemonLogPath })}\n`);
    process.exit(0);
  }

  await fs.mkdir(path.dirname(daemonLogPath), { recursive: true });
  const logHandle = await fs.open(daemonLogPath, "a", 0o600);
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), ...process.argv.slice(2).filter((value) => value !== "--daemon")],
    {
      cwd: appDirectory,
      detached: true,
      env: process.env,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    },
  );
  child.unref();
  await fs.writeFile(daemonPidPath, `${child.pid}\n`, { mode: 0o600 });
  await logHandle.close();
  process.stdout.write(`${JSON.stringify({ event: "STARTED_DAEMON", pid: child.pid, logPath: daemonLogPath, progressPath })}\n`);
  process.exit(0);
}

function integerArgument(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const limit = integerArgument("limit", Number.POSITIVE_INFINITY);
const concurrency = Math.min(integerArgument("concurrency", 1), 3);
const retryFailures = process.argv.includes("--retry-failures");

async function readProgress() {
  try {
    const parsed = JSON.parse(await fs.readFile(progressPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { completed: {}, failures: {} };
  } catch (error) {
    if (error?.code === "ENOENT") return { completed: {}, failures: {} };
    throw error;
  }
}

async function writeProgress(progress) {
  await fs.mkdir(path.dirname(progressPath), { recursive: true });
  const temporaryPath = `${progressPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(progress, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporaryPath, progressPath);
  await fs.chmod(progressPath, 0o600);
}

function persistProgress(progress) {
  const snapshot = JSON.parse(JSON.stringify(progress));
  const pending = progressWriteQueue.then(() => writeProgress(snapshot));
  progressWriteQueue = pending.catch(() => {});
  return pending;
}

async function runCodexOnce(prompt, schemaPath, outputPath) {
  const args = [
    "--search",
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-C",
    appDirectory,
  ];
  if (process.env.RECORDSHELF_CODEX_MODEL) {
    args.push("--model", process.env.RECORDSHELF_CODEX_MODEL);
  }
  args.push("-");

  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd: appDirectory,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("CODEX_RESEARCH_TIMEOUT"));
    }, 12 * 60 * 1000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`CODEX_EXIT_${code ?? signal}: ${stderr.trim()}`));
    });
    child.stdin.end(prompt);
  });
}

async function runCodex(prompt, schemaPath, outputPath) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await runCodexOnce(prompt, schemaPath, outputPath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      const message = String(error?.message ?? error);
      const rateLimited = /429|rate.?limit|usage.?limit|too many requests/i.test(message);
      const delayMs = rateLimited ? 15 * 60 * 1000 : attempt * 30 * 1000;
      process.stdout.write(
        `${JSON.stringify({ event: "RETRY", attempt, delaySeconds: delayMs / 1000, reason: message.slice(0, 500) })}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

const rawLibrary = JSON.parse(await fs.readFile(libraryPath, "utf8"));
const releases = Array.isArray(rawLibrary) ? rawLibrary : rawLibrary.releases ?? [];
const releaseById = new Map(releases.map((release) => [release.id, release]));
const promptTemplate = await fs.readFile(promptPath, "utf8");
const store = await readListeningGuideStore();
const progress = await readProgress();
progress.completed ??= {};
progress.failures ??= {};

const queue = Object.entries(store.guides)
  .filter(([releaseId, guide]) => {
    if (guide?.status === "READY") return false;
    if (guide?.provider === "CODEX_CHATGPT_WEB_RESEARCH") return false;
    if (progress.completed[releaseId]) return false;
    if (!retryFailures && progress.failures[releaseId]) return false;
    return releaseById.has(releaseId);
  })
  .slice(0, limit);

const totals = {
  queued: queue.length,
  processed: 0,
  ready: 0,
  insufficient: 0,
  unverified: 0,
  failed: 0,
};

async function processRelease([releaseId]) {
  const release = releaseById.get(releaseId);
  const identity = publicListeningGuideIdentity(release);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "recordshelf-codex-guide-"));
  const schemaPath = path.join(temporaryDirectory, "schema.json");
  const outputPath = path.join(temporaryDirectory, "result.json");
  try {
    await fs.writeFile(schemaPath, `${JSON.stringify(LISTENING_GUIDE_SCHEMA)}\n`);
    const prompt = `${promptTemplate
      .replace("{{RELEASE_IDENTITY_JSON}}", JSON.stringify(identity, null, 2))
      .replace("{{SOURCE_BUNDLE_JSON}}", "[]")}\n\n额外执行要求：使用本次 Codex 任务提供的实时网页搜索完成研究。只研究这一张发行；不要读取或修改 RecordShelf 文件，不要使用用户评分、评论或听过时间。来源 URL 必须是你实际搜索并打开核验过的页面。最终只返回符合指定 JSON Schema 的 JSON。`;
    await runCodex(prompt, schemaPath, outputPath);
    const payload = JSON.parse(await fs.readFile(outputPath, "utf8"));
    const { guide } = await saveCodexResearchGuide(releaseId, identity, payload);
    progress.completed[releaseId] = {
      status: guide.status,
      title: identity.originalTitle,
      artists: identity.artists,
      finishedAt: new Date().toISOString(),
    };
    delete progress.failures[releaseId];
    totals.processed += 1;
    if (guide.status === "READY") totals.ready += 1;
    else if (guide.status === "UNVERIFIED") totals.unverified += 1;
    else totals.insufficient += 1;
    await persistProgress(progress);
    process.stdout.write(`${JSON.stringify({ releaseId, title: identity.originalTitle, status: guide.status, totals })}\n`);
  } catch (error) {
    totals.processed += 1;
    totals.failed += 1;
    progress.failures[releaseId] = {
      title: identity.originalTitle,
      artists: identity.artists,
      error: String(error?.message ?? error).slice(0, 2000),
      failedAt: new Date().toISOString(),
    };
    await persistProgress(progress);
    process.stdout.write(`${JSON.stringify({ releaseId, title: identity.originalTitle, status: "FAILED", error: progress.failures[releaseId].error, totals })}\n`);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

let cursor = 0;
async function worker() {
  while (cursor < queue.length) {
    const item = queue[cursor];
    cursor += 1;
    await processRelease(item);
  }
}

process.stdout.write(`${JSON.stringify({ event: "START", concurrency, totals })}\n`);
await Promise.all(Array.from({ length: concurrency }, () => worker()));
process.stdout.write(`${JSON.stringify({ event: "COMPLETE", totals })}\n`);
await fs.rm(daemonPidPath, { force: true }).catch(() => {});
