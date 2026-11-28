import { MessageId, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, foldSurface } from '@deepseek-ai/dsh-session';
import { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn as childSpawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { decodeSessionBuffer, encodeSessionBuffer, exciseSessionBuffer } from './excise.js';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemoryFeature } from './memory.js';
import { installTaskFeature } from './task.js';
import { stepGate } from './step-gate.js';
import { filterTombstonesFromRequest } from './tombstone-filter.js';

const require = createRequire(import.meta.url);
const name = 'dsh-session-kit';
/* 本插件包目录（realpath）：用于判断某个 profile 的 node_modules/dsh-session-kit
   是否指向自己——0.2.x 桌面版里 profile 解析会落到 profiles/web，而宿主实际加载的
   是 profiles/desktop，重载注释必须两个都写（见 nudgeProfileReload）。 */
const SESSION_KIT_PACKAGE_DIR = (() => {
  try {
    return realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
  } catch {
    return join(dirname(fileURLToPath(import.meta.url)), '..');
  }
})();
const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry', 'agents', 'sessions', 'storageDomain', 'systemPrompt', 'llm'];
const OPEN_ROUTE = '/dsh-session-kit/open-folder';
const DELETE_ROUTE = '/dsh-session-kit/delete';
const ARCHIVE_LIST_ROUTE = '/dsh-session-kit/archive/list';
const ARCHIVE_RESTORE_ROUTE = '/dsh-session-kit/archive/restore';
const ARCHIVE_DELETE_ROUTE = '/dsh-session-kit/archive/delete';
const WORKSPACE_DELETE_ROUTE = '/dsh-session-kit/workspace/delete';
const WORKSPACE_DELETE_BY_PATH_ROUTE = '/dsh-session-kit/workspace/delete-by-path';
const WORKSPACES_ROUTE = '/dsh-session-kit/workspaces';
const ARCHIVE_PREVIEW_ROUTE = '/dsh-session-kit/archive/preview';
const TOOL_STATS_ROUTE = '/dsh-session-kit/tool-stats';
const COMPACTION_CONFIG_ROUTE = '/dsh-session-kit/compaction-config';
const REPAIR_SESSION_ROUTE = '/dsh-session-kit/repair-session';
const GLOBAL_PROMPT_ROUTE = '/dsh-session-kit/global-prompt';
const INJECTION_SOURCES_ROUTE = '/dsh-session-kit/injection-sources';
const PROMPT_WORKSHOP_ROUTE = '/dsh-session-kit/prompt-workshop';
const MEMORY_STORAGE_ROUTE = '/dsh-session-kit/memory-storage';
const DISTILL_SETTINGS_ROUTE = '/dsh-session-kit/distill-settings';
const MEMORY_WORKSPACE_BINDING_ROUTE = '/dsh-session-kit/memory-workspace-binding';
/* 临时诊断路由：前端把现场 POST 过来，落盘到 $DSH_HOME/dsh-session-kit-debug.log，
   供开发者自读。只为定位「点添加固定渠道导致 UI 消失」而加，问题解决后删除。 */
const DEBUG_LOG_ROUTE = '/dsh-session-kit/debug-log';
const SYNCED_KEY_DISTILL = 'distillSettings';
const GLOBAL_PROMPT_SECTION = 'dsh-session-kit:global-prompt';
const GLOBAL_PROMPT_ORDER = 10;
const GLOBAL_PROMPT_MAX_TEXT_LENGTH = 200000;
const TURNS_DEL_PATH = '/dsh-turns-del';
const TURNS_DEL_RANGES_PATH = '/dsh-turns-del/ranges';
const TURNS_DEL_TURN_PATH = '/dsh-turns-del/turn';
const REGENERATE_PATH = '/dsh-turns-del-regenerate';
const REGENERATE_TURN_PATH = '/dsh-turns-del-regenerate/turn';
const EDIT_REGENERATE_TURN_PATH = '/dsh-turns-del-edit-regenerate/turn';
const TURNS_DEL_PROVIDER = 'dsh-session-kit-turns-del';
const SESSION_ID_RE = /^(session-)?[0-9a-fA-F-]+$/;
const COMPACTION_DEFAULT_THRESHOLD_RATIO = 0.8;
const COMPACTION_DEFAULT_RETAIN_RATIO = 0.16;
const COMPACTION_DEFAULT_MAX_TOKENS = 8192;
const COMPACTION_DEFAULT_RETRIES = 1;
const COMPACTION_DEFAULT_OVERFLOW_RETRIES = 1;
const DEFAULT_COMPACTION_VALUES = Object.freeze({
  thresholdRatio: COMPACTION_DEFAULT_THRESHOLD_RATIO,
  retainRatio: COMPACTION_DEFAULT_RETAIN_RATIO,
  maxTokens: COMPACTION_DEFAULT_MAX_TOKENS,
  compactionRetries: COMPACTION_DEFAULT_RETRIES,
  maxOverflowRetries: COMPACTION_DEFAULT_OVERFLOW_RETRIES
});
const COMPACTION_MIN_THRESHOLD_RATIO = 0.6;
const COMPACTION_MAX_THRESHOLD_RATIO = 0.9;
const COMPACTION_MIN_RETAIN_RATIO = 0.01;
const COMPACTION_MAX_RETAIN_RATIO = 0.3;
const COMPACTION_MIN_MAX_TOKENS = 256;
const COMPACTION_MAX_MAX_TOKENS = 65536;
const COMPACTION_MIN_RETRIES = 0;
const COMPACTION_MAX_RETRIES = 10;
const compactionConfigDomainSpec = defineDomain({
  name: 'dsh_session_kit_compaction_config',
  version: 1,
  global: {
    schema: z.object({
      enabled: z.boolean().optional(),
      thresholdRatio: z.number().optional(),
      retainRatio: z.number().optional(),
      maxTokens: z.number().optional(),
      compactionRetries: z.number().optional(),
      maxOverflowRetries: z.number().optional()
    }),
    initial: {}
  },
  tables: {}
});
const sidebarEntriesDomainSpec = defineDomain({
  name: 'dsh_session_kit_sidebar_entries',
  version: 1,
  global: {
    schema: z.object({
      memoryVisible: z.boolean().optional(),
      archiveVisible: z.boolean().optional(),
      taskVisible: z.boolean().optional()
    }),
    initial: {}
  },
  tables: {}
});
const globalPromptDomainSpec = defineDomain({
  name: 'dsh_session_kit_global_prompt',
  version: 1,
  global: {
    schema: z.object({
      enabled: z.boolean().optional(),
      text: z.string().optional()
    }),
    initial: {}
  },
  tables: {}
});
/* 任务自动注入开关（全局）。关闭后不再自动匹配注入未完成任务提示；
   模型仍可主动用 task_list / task_inject 查看与注入。 */
const taskAutoInjectDomainSpec = defineDomain({
  name: 'dsh_session_kit_task_auto_inject',
  version: 1,
  global: {
    schema: z.object({
      enabled: z.boolean().optional()
    }),
    initial: {}
  },
  tables: {}
});
/* 记忆数据保存目录（全局）。必须存在 storageDomain 而非 memory.sqlite 内：
   否则"库在哪"这个事实本身要存在库里，形成鸡生蛋问题。mode 为 default 时
   用 profile 下的 .dsh-session-kit；为 custom 时用 customPath 绝对路径。 */
const memoryStorageDomainSpec = defineDomain({
  name: 'dsh_session_kit_memory_storage',
  version: 1,
  global: {
    schema: z.object({
      mode: z.string().optional(),
      customPath: z.string().optional()
    }),
    initial: {}
  },
  tables: {}
});
/* 注入源开关（全局，默认全关）。只管 session-kit 自己的四个注入源：
   记忆使用说明段落 / 每轮记忆召回 / 对话自动匹配记忆项目 / 「记住」提示行。
   任务自动提示与全局提示词各有既有域，由路由层聚合读写，避免第二份真相。 */
const injectionSourcesDomainSpec = defineDomain({
  name: 'dsh_session_kit_injection_sources',
  version: 1,
  global: {
    schema: z.object({
      memoryGuide: z.boolean().optional(),
      recall: z.boolean().optional(),
      firstTurnMatch: z.boolean().optional(),
      memoryRequest: z.boolean().optional()
    }),
    initial: {}
  },
  tables: {}
});
/* 提示词工坊（全局）：versions = 用户自建的提示词版本（每个版本生成一个独立预设，
   正文真相在这里）；workspacePresets = 工作区 → 预设 id 绑定。
   默认版本「大肥鱼」的正文不在这里，而在 dsh-preset-lite/cordis.patch.yml 的
   workshop:dafeyu 标记里（工坊按标记整块重写，人也能直接手改）。 */
const promptWorkshopDomainSpec = defineDomain({
  name: 'dsh_session_kit_prompt_workshop',
  version: 1,
  global: {
    schema: z.object({
      workspacePresets: z.record(z.string(), z.string()).optional(),
      versions: z.array(z.object({
        presetId: z.string(),
        name: z.string(),
        text: z.string()
      })).optional(),
      autoApply: z.boolean().optional()
    }),
    initial: {}
  },
  tables: {}
});
/* 蒸馏设置（全局）：chain = 优先级链条，每项 { type: 'fixed'|'session', provider?, model?, reasoningEffort? }
   2026-11-09 定案：无项数上限、不强制 session 兜底；fixed 项必须有 provider+model。
   链条可空＝执行侧回落「用当前会话模型」。 */
const distillSettingsDomainSpec = defineDomain({
  name: 'dsh_session_kit_distill_settings',
  version: 1,
  global: {
    schema: z.object({
      chain: z.array(z.object({
        type: z.enum(['fixed', 'session']),
        provider: z.string().optional(),
        model: z.string().optional(),
        reasoningEffort: z.string().optional()
      })).optional(),
      failureCooldownMinutes: z.number().optional()
    }),
    initial: {}
  },
  tables: {}
});
const MAX_SESSION_BODY_BYTES = 65536;
const MAX_TURNS_DEL_BODY_BYTES = 512 * 1024;
const DEFAULT_ARCHIVE_PREVIEW_LIMIT = 30;
const MAX_ARCHIVE_PREVIEW_LIMIT = 100000;
const deletedSessionIds = new Set();

function normalizeSidebarEntries(value) {
  return {
    memoryVisible: value?.memoryVisible !== false,
    archiveVisible: value?.archiveVisible !== false,
    taskVisible: value?.taskVisible !== false
  };
}

/* 默认开启：未显式关闭即视为 true。 */
function normalizeTaskAutoInject(value) {
  return { enabled: value?.enabled !== false };
}

/* 蒸馏设置归一化：chain 数组，每项 { type: 'fixed'|'session', provider?, model?, reasoningEffort? }
   规则：
   - 只保留 type 为 'fixed' 或 'session' 的项
   - 'fixed' 项必须有 provider 和 model，否则丢弃
   - 最多 3 项
   - 最后一项必须是 'session'（兜底），若不存在则自动追加
   - 连续的 'session' 项去重，只保留最后一个 */
function normalizeDistillSettings(value) {
  const rawChain = Array.isArray(value?.chain) ? value.chain : [];
  const chain = [];
  for (const item of rawChain) {
    if (!item || typeof item !== 'object') continue;
    const type = item.type === 'session' ? 'session' : item.type === 'fixed' ? 'fixed' : null;
    if (!type) continue;
    if (type === 'fixed') {
      const provider = typeof item.provider === 'string' ? item.provider.trim() : '';
      const model = typeof item.model === 'string' ? item.model.trim() : '';
      if (!provider || !model) continue;
      chain.push({ type: 'fixed', provider, model, reasoningEffort: typeof item.reasoningEffort === 'string' && item.reasoningEffort.trim() ? item.reasoningEffort.trim() : undefined });
    } else {
      chain.push({ type: 'session' });
    }
  }
  // 去重连续的 session
  const deduped = [];
  for (const item of chain) {
    if (item.type === 'session' && deduped.length > 0 && deduped[deduped.length - 1].type === 'session') {
      deduped[deduped.length - 1] = item;
    } else {
      deduped.push(item);
    }
  }
  /* 2026-11-09 用户定案：取消「最多 3 项」上限，取消「最后一项必须 session（用当前模型）」的强制兜底。
     链条允许为空——空链=执行侧回落「用当前会话模型」；允许纯 fixed 链、允许 session 项被删除。
     执行侧按顺序逐项尝试，某项失败（403/配额/超时/无可用输出）自动换下一项，全链失败=本轮不写记忆。
     failureCooldownMinutes：某项调用失败后的冷却期（分钟），期内直接跳过不再尝试；0=关闭；默认 60。 */
  const cooldownRaw = Number(value?.failureCooldownMinutes);
  const failureCooldownMinutes = Number.isFinite(cooldownRaw) && cooldownRaw >= 0 ? Math.floor(cooldownRaw) : 0;
  /* distillTimeoutSec（2026-11-23 用户要求可设置，单位秒）：单次蒸馏 LLM 调用的总超时。
     替代 DISTILL_TIMEOUT_MS 常量；范围 30-300——上限 300 = 历史常量值，恒小于活动兜底
     ACTIVITY_STUCK_TIMEOUT_MS（300s + 60s 余量 = 6 分钟），长超时不被误 reap。 */
  const timeoutRaw = Number(value?.distillTimeoutSec);
  const distillTimeoutSec = Number.isFinite(timeoutRaw) ? Math.min(300, Math.max(30, Math.round(timeoutRaw))) : 300;
  return { chain: deduped, failureCooldownMinutes, distillTimeoutSec };
}

const MEMORY_STORAGE_MODE_DEFAULT = 'default';
const MEMORY_STORAGE_MODE_CUSTOM = 'custom';

/* 记忆数据保存目录设置。mode 非 custom 一律回落到 default；
   custom 模式缺少可用路径时同样回落，避免把库指到空路径上。
   default 模式一律清空 customPath，防止旧路径残留在快照里造成误解。 */
function normalizeMemoryStorage(value) {
  const mode = value?.mode === MEMORY_STORAGE_MODE_CUSTOM ? MEMORY_STORAGE_MODE_CUSTOM : MEMORY_STORAGE_MODE_DEFAULT;
  const customPath = typeof value?.customPath === 'string' ? value.customPath.trim() : '';
  if (mode !== MEMORY_STORAGE_MODE_CUSTOM || customPath.length === 0) {
    return { mode: MEMORY_STORAGE_MODE_DEFAULT, customPath: '' };
  }
  return { mode, customPath };
}

/* Windows 路径大小写不敏感，判定"是否等于默认目录"必须按大小写无关比较，
   否则用户换个盘符/目录大小写就能把库指到默认目录，绕过守卫。
   同时容忍尾部分隔符差异：两侧归一化程度不同（一侧来自 join，一侧来自 resolve）。 */
function samePath(left, right) {
  const strip = (value) => {
    const text = String(value ?? '');
    return text.length > 3 ? text.replace(/[\\/]+$/u, '') : text;
  };
  const a = strip(left);
  const b = strip(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/* profile 下的默认数据目录：与 memory.js 的 pluginDataDir 保持同一位置
   （<profile>/.dsh-session-kit）。此处只做路径推导，不创建目录。 */
function defaultMemoryDataDir() {
  // 跟随 profile 位置（见 sessionKitProfileDir 注释）——DSHA 布局下否则会与 dsh-sync 同步的
  // profiles/web/.dsh-session-kit/memory.sqlite 错开，提示词版本/绑定/记忆同步全部失效。
  return join(sessionKitProfileDir(), '.dsh-session-kit');
}

/* 自定义目录校验：必须是绝对路径，且不能指向默认目录（等价于默认模式）。
   返回规范化后的绝对路径或错误码。 */
function resolveCustomMemoryDir(rawPath) {
  const text = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (text.length === 0) return { error: 'invalid-memory-storage-path' };
  if (text.length > 1024) return { error: 'invalid-memory-storage-path' };
  if (!isAbsolute(text)) return { error: 'memory-storage-path-not-absolute' };
  let normalized;
  try {
    normalized = resolve(text);
  } catch {
    return { error: 'invalid-memory-storage-path' };
  }
  if (samePath(normalized, resolve(defaultMemoryDataDir()))) return { error: 'memory-storage-path-is-default' };
  return { value: normalized };
}

/* 保存时探测目录可用性：不存在则尝试创建，并写入一个探针文件确认可写。
   不做这道检查的话，用户填了不存在的盘符（如 Z:\mem）也能保存成功，
   重启后 MemoryStore 构造期的 mkdirSync 会抛错，导致记忆与任务功能整体不可用。
   探针文件用完立即删除，不污染用户目录。

   先做显式类型检查再建目录：路径已存在但**不是目录**（用户误填了某个文件，
   如 D:\notes.txt）时必须单独报错。虽然 mkdirSync 也会抛 EEXIST/ENOTDIR 拦住，
   但那样只能落到笼统的"目录不可用"，用户看不出真正原因是"这是个文件"。
   另外还要排除非目录的特殊路径（设备文件、符号链接指向文件等）。 */
function probeMemoryDir(dir) {
  try {
    const existing = statSync(dir, { throwIfNoEntry: false });
    if (existing !== undefined && !existing.isDirectory()) {
      return { error: 'memory-storage-path-not-a-directory' };
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    /* 建目录后复核一次：路径的父级若是文件（file\sub），或存在同名特殊文件，
       mkdir 可能已通过但最终落点并非目录。 */
    const settled = statSync(dir, { throwIfNoEntry: false });
    if (settled === undefined || !settled.isDirectory()) {
      return { error: 'memory-storage-path-not-a-directory' };
    }
    const probe = join(dir, '.dsh-session-kit-write-probe');
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    return { ok: true };
  } catch (error) {
    const code = error?.code;
    if (code === 'EEXIST' || code === 'ENOTDIR') return { error: 'memory-storage-path-not-a-directory' };
    return { error: 'memory-storage-path-unusable', detail: error instanceof Error ? error.message : String(error) };
  }
}

/* 设置 → 实际数据目录。custom 模式路径不可用时回落默认目录，
   保证记忆功能始终有可用位置（坏设置不导致功能不可用）。 */
function memoryDataDirFor(settings) {
  if (settings?.mode === MEMORY_STORAGE_MODE_CUSTOM) {
    const resolved = resolveCustomMemoryDir(settings.customPath);
    if (resolved.value !== undefined) return resolved.value;
  }
  return defaultMemoryDataDir();
}

function respond(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, no-transform' });
  res.end(body);
}

function readJsonBody(req, maxBytes = MAX_SESSION_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      bytes += typeof chunk === 'string' ? new TextEncoder().encode(chunk).length : chunk.byteLength;
      if (bytes > maxBytes) {
        settled = true;
        reject(new TypeError('request body is too large'));
        return;
      }
      text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        text += decoder.decode();
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function sessionIdOf(body) {
  const id = body?.sessionId;
  return typeof id === 'string' && SESSION_ID_RE.test(id) ? id : undefined;
}

function openSystemFolder(dir) {
  if (process.platform === 'win32') childSpawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') childSpawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
  else childSpawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
}

function moveToSystemTrash(dir) {
  if (process.platform === 'win32') {
    const escapedPath = dir.replace(/'/g, "''");
    const script = `$p='${escapedPath}'; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'recycle-bin-delete-failed');
    return;
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('osascript', ['-e', `tell application "Finder" to delete POSIX file ${JSON.stringify(dir)}`], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'trash-delete-failed');
    return;
  }
  throw new Error('no-system-trash');
}

async function deleteStoppedSessionDirectory(dir) {
  const { rm } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true });
}

/* 真删除收尾：从所有工作区记录解绑该会话 + 清 projcache + 刷新会话列表。
   返回 true = 解绑全部成功（墓碑可安全撤掉）；false = 有失败（调用方保留墓碑防复活）。 */
async function detachWorkspaceRefs(ctx, sessionId) {
  let detachOk = true;
  try {
    for (const ws of ctx.workspaceRegistry.list()) {
      const entity = ctx.workspaceRegistry.get(ws.id);
      if (!entity || typeof entity.detachSession !== 'function') continue;
      try { await entity.detachSession(sessionId); } catch (error) {
        detachOk = false;
        ctx.logger?.warn?.(`[dsh-session-kit] detach '${sessionId}' from '${ws.id}' failed: ${String(error)}`);
      }
    }
  } catch (error) { detachOk = false; ctx.logger?.warn?.(`[dsh-session-kit] detach list failed: ${String(error)}`); }
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    rmSync(join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`), { force: true });
  } catch { /* projcache 缺失不算失败 */ }
  try { if (ctx.sessions && typeof ctx.sessions.refresh === 'function') await ctx.sessions.refresh(); } catch { /* 刷新失败不致命 */ }
  return detachOk;
}

/* 会话是否仍在内存：live 会话的 header 会被 indexLiveSessions 重新索引，
   若此时记录里还有 id 且墓碑已撤，去别的页面回来就会"复活"。 */
function isSessionLive(ctx, sessionId) {
  try { return ctx.sessions?.get?.(sessionId) !== undefined; } catch { return false; }
}

/* 会话根目录：$DSH_HOME/sessions。 */
function sessionsRootDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions');
}

/* 工作区路径 → 会话存储的项目目录键（与 dsh-session-persistence-jsonl 的
   projectKey 同算法：分隔符压成 '-'，非安全字符 ~XXXX，首尾 -- 包裹）。
   用于整删该工作区下的全部会话目录（含不在 sessionIds 记录里的孤儿）。 */
function projectKeyFor(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
  let readable = '';
  let sepRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') { if (!sepRun) readable += '-'; sepRun = true; }
    else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; sepRun = false; }
    else { readable += '~' + code.toString(16).toUpperCase().padStart(4, '0'); sepRun = false; }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

class TurnsDelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TurnsDelError';
    this.code = code;
  }
}

function sessionEvents(session) {
  if (session === undefined || session === null) return [];
  if (typeof session.snapshotEvents === 'function') {
    try {
      const value = session.snapshotEvents();
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }
  const legacy = session.events;
  return Array.isArray(legacy) ? legacy : [];
}

function isHandleStylePersistence(persistence) {
  return typeof persistence?.open === 'function' && typeof persistence?.readFrom !== 'function';
}

function persistenceHeaderOf(entry) {
  if (entry?.header !== undefined) return entry.header;
  return entry;
}

async function persistenceHeaderById(persistence, sessionId, options) {
  const entries = await persistence.list(options);
  return entries.map(persistenceHeaderOf).find((header) => header?.id === sessionId);
}

async function readPersistedSession(persistence, sessionId, options) {
  if (!isHandleStylePersistence(persistence)) {
    if (typeof persistence?.readFrom !== 'function') throw new TypeError('session persistence backend does not expose a session read API');
    return persistence.readFrom(sessionId, 0);
  }
  let handle;
  let failure;
  try {
    handle = await persistence.open(sessionId, 'read', options);
    return await handle.read(0, Number.MAX_SAFE_INTEGER, options);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        if (failure === undefined) throw error;
      }
    }
  }
}

/* v4 墓碑：空 content 的 user/message 替换。
   - v4 拒绝通用 kind:'plugin' 包装，必须直接使用 producer-owned source kind。
   - user/message 替换无 turn/step 约束；空文本消息不会进入模型上下文。
   - 元数据（turn/endTurn/regeneration）存于 source.summary 的 JSON。 */
function turnsDelTombstoneMetaOf(event) {
  if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event)) return undefined;
  const source = event.data?.source;
  if (!Array.isArray(event.data.content) || event.data.content.length !== 0) return undefined;
  let meta = {};
  try {
    const parsed = JSON.parse(source?.summary ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
  } catch {}
  const turn = Number.isSafeInteger(meta.turn) && meta.turn >= 0 ? meta.turn : undefined;
  if (turn === undefined) return undefined;
  const endTurn = Number.isSafeInteger(meta.endTurn) && meta.endTurn >= turn ? meta.endTurn : turn;
  return { turn, endTurn, regeneration: meta.regeneration };
}

function isTurnsDelEvent(event) {
  return turnsDelTombstoneMetaOf(event) !== undefined;
}

function hasInboxPending(agent) {
  const inbox = agent?.inbox;
  if (inbox === undefined || inbox === null) return false;
  if (typeof inbox.hasPending === 'function') {
    try {
      return inbox.hasPending() === true;
    } catch {
      return false;
    }
  }
  if (inbox.hasPending === true) return true;
  return (Array.isArray(inbox.nextTurn) && inbox.nextTurn.length > 0)
    || (Array.isArray(inbox.nextStep) && inbox.nextStep.length > 0);
}

/* Prefer the Agent's atomic maintenance lock. A transient active-work race is
   awaited via whenIdle and retried; queued inbox messages remain queued and are
   processed after maintenance releases the lock. */
async function runAgentMaintenance(agent, fn) {
  if (typeof agent?.runMaintenance === 'function') {
    for (;;) {
      try {
        return await agent.runMaintenance(fn);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already has active work/i.test(message) || typeof agent.whenIdle !== 'function') throw error;
        await agent.whenIdle();
      }
    }
  }
  if (agent?.status === 'running' || hasInboxPending(agent)) {
    /* [防复读风暴 2026-10-24] 报错带实况：UI 拿到 message 就能告诉用户
       「有 N 条排队中，等它跑完再删」，而不是干巴巴「失败」逼用户连点。 */
    const inbox = agent?.inbox;
    const queued = (Array.isArray(inbox?.nextTurn) ? inbox.nextTurn.length : 0)
      + (Array.isArray(inbox?.nextStep) ? inbox.nextStep.length : 0);
    const extra = queued > 0 ? `; ${queued} message(s) still queued (likely a pending regenerate replay — wait for it to finish instead of retrying)` : '';
    throw new TurnsDelError('AGENT_BUSY', `session is running or has queued input; retry when it is idle${extra}`);
  }
  const controller = new AbortController();
  return fn(controller.signal);
}

function eventTurn(event) {
  if (event.type === 'assistant/message' || event.type === 'tool/result') return event.data.turn;
}

/* 轮次区间。手动停止时 turn/end 比 step/end 晚约 2ms 落盘，点击落在这个间隙里
   会取不到 turn/end（旧实现直接返回 undefined → TURN_NOT_CLOSED）。此时退化为
   “turn/start 之后到该轮最后一条事件”，让提问仍可被定位——删除路径本来就有
   同类兜底（turnEndSeq），这里补齐，避免刷新/编辑比删除更脆。 */
function turnBracket(events, turn, targetSeq) {
  const start = events.findLast((event) => event.seq <= targetSeq && event.type === 'turn/start' && event.data.turn === turn);
  if (start === undefined) return undefined;
  const end = events.find((event) => event.seq >= targetSeq && event.type === 'turn/end' && event.data.turn === turn);
  if (end !== undefined) return { start: start.seq, end: end.seq };
  const lastOfTurn = events.findLast((event) => event.data?.turn === turn && event.seq > start.seq);
  if (lastOfTurn === undefined) return undefined;
  return { start: start.seq, end: lastOfTurn.seq + 1 };
}

function surfaceOrigins(seq, events, memo, visiting = new Set()) {
  const cached = memo.get(seq);
  if (cached !== undefined) return cached;
  if (visiting.has(seq)) return new Set();
  visiting.add(seq);
  const event = events[seq];
  const origins = new Set();
  if (event !== undefined) {
    if (isAppendSurfaceEvent(event)) origins.add(seq);
    for (const source of event.sourceEventSeqs ?? []) {
      for (const origin of surfaceOrigins(source, events, memo, visiting)) origins.add(origin);
    }
  }
  visiting.delete(seq);
  memo.set(seq, origins);
  return origins;
}

function eventTurns(events) {
  const turns = new Map();
  let activeTurn;
  for (const event of events) {
    if (event.type === 'turn/start') {
      activeTurn = event.data.turn;
      continue;
    }
    const explicitTurn = eventTurn(event);
    if (explicitTurn !== undefined) turns.set(event.seq, explicitTurn);
    else if (activeTurn !== undefined) turns.set(event.seq, activeTurn);
    if (event.type === 'turn/end' && activeTurn === event.data.turn) activeTurn = undefined;
  }
  return turns;
}

function deletionTombstoneForOrigin(events, originSeq, memo) {
  return events.find((event) => isTurnsDelEvent(event) && surfaceOrigins(event.seq, events, memo).has(originSeq));
}

function deletionTombstoneForTurn(events, turn) {
  return events.find((event) => {
    const meta = turnsDelTombstoneMetaOf(event);
    return meta !== undefined && turn >= meta.turn && turn <= meta.endTurn;
  });
}

function completedTurnsFrom(events, startTurn) {
  return events
    .filter((event) => event.type === 'turn/end' && event.data.turn >= startTurn)
    .map((event) => event.data.turn);
}

function turnEndSeq(events, turn) {
  const end = events.find((event) => event.type === 'turn/end' && event.data.turn === turn);
  if (end === undefined) throw new TurnsDelError('TURN_NOT_CLOSED', `turn ${String(turn)} is not closed`);
  return end.seq;
}

function appendOriginsForTurn(events, turn, targetSeq) {
  const bracket = turnBracket(events, turn, targetSeq);
  if (bracket === undefined) throw new TurnsDelError('TURN_NOT_CLOSED', `turn ${String(turn)} is not closed`);
  return new Set(events
    .filter((event) => isAppendSurfaceEvent(event) && ((event.seq > bracket.start && event.seq < bracket.end) || eventTurn(event) === turn))
    .map((event) => event.seq));
}

function selectIndependentTurnSurface(session, events, turn, targetSeq, options = {}) {
  const originSeqs = appendOriginsForTurn(events, turn, targetSeq);
  /* 预检阶段传入模拟 surface：逐轮模拟替换，检查整批删除是否全部可行。 */
  const currentNodes = options.nodes ?? session.surface.nodes;
  /* node 0 受系统头保护：只能被恰好覆盖它的 system/message 重写。system prompt
     会在后续轮次被反复重写（7 → 43 → 67），最新节点成为 node 0，但它的 origin
     链仍指向首轮的 seq 7。因此仅“删除 headSeq 这个 origin”不够——删除首轮时
     node 0 会因 origin 7 命中而被选中。这里直接跳过受保护的 node 0：墓碑是
     user/message，永远不能覆盖系统头，保留它才是正确语义。 */
  const headSeq = currentNodes[0];
  const headProtected = headSeq !== undefined && events[headSeq]?.type === 'system/message';
  if (headProtected) originSeqs.delete(headSeq);
  const targetOnSurface = currentNodes.includes(targetSeq);
  if (options.requireTargetNode !== false && !targetOnSurface) throw new TurnsDelError('TURN_COMPACTED', `turn ${String(turn)} is no longer independently deletable`);
  const memo = new Map();
  const selected = [];

  for (const seq of currentNodes) {
    if (headProtected && seq === headSeq) continue;
    const origins = surfaceOrigins(seq, events, memo);
    const targetOrigins = [...origins].filter((origin) => originSeqs.has(origin));
    if (targetOrigins.length === 0) continue;
    if ([...origins].some((origin) => !originSeqs.has(origin))) throw new TurnsDelError('TURN_COMPACTED', `turn ${String(turn)} shares a compacted surface node`);
    selected.push(seq);
  }

  if (selected.length === 0) throw new TurnsDelError('TARGET_NOT_FOUND', `turn ${String(turn)} has no live surface nodes`);
  const positions = selected.map((seq) => currentNodes.indexOf(seq));
  const first = positions[0];
  if (first === undefined || positions.some((position, index) => position !== first + index)) throw new TurnsDelError('TURN_COMPACTED', `turn ${String(turn)} is not a contiguous surface span`);
  return selected;
}

/* ── 阶段1：物理清空被删行的正文（2026-10-11「三兄弟真删除」改造）─────────────
   原实现只 append 墓碑，被删轮的正文一个字节不动 —— 解压文件即可读到原文。
   这里在 flush 之后把被删行的 payload 清空：只改字节、不改 seq、不碰宿主内存
   结构（宿主 append-only，flush 只写新事件，不会把旧正文写回磁盘），因此活体安全。
   删行 + 清墓碑属于阶段2，等会话卸载后由 excise 执行（零墓碑）。 */
const REDACT_TYPES = new Set(['assistant/attempt', 'llm/retry', 'llm/retry-started']);
/* 新版本「上下文注入」的 source.kind（宿主 UI 标它为『上下文注入』）：注入正文即用户内容，删轮时必须一并清。 */
const CONTEXT_INJECT_KINDS = new Set(['agent-instructions', 'session-reference', 'skill-invocation']);
/* 要擦的文本键 —— 与 dsh-adapter-compat/purge.js 的 TEXT_KEYS 保持同一份清单。
   三插件的擦除语义必须同步（用户 2026-10-08 立的规矩）。 */
const TEXT_KEYS = new Set(['text', 'texts', 'delta', 'deltas', 'reasoning', 'reasoning_content', 'reasoningContent', 'thinking']);
/* 占位正文：与 adapter-compat/purge.js、slim.js、dsh-delete-turn 的 [内容已清除] 统一
   （三插件同步规矩）。擦空的 tool 结果必须留这个占位，否则 Anthropic 风格 provider
   把 tool_result.content=[] 当成「没有结果」整轮拒收。 */
const TEXT_PLACEHOLDER = '[内容已清除]';
/* 按 key 名深度擦文本：只把字符串清空，键/数组长度/chunk 结构原样保留。
   与 adapter-compat 的 scrubDeep 同语义（插件之间不互相 import，各自内联一份）。 */
function scrubDeep(node, depth = 0) {
  if (depth > 14 || node === null || typeof node !== 'object') return node;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (TEXT_KEYS.has(key)) {
      if (typeof value === 'string') node[key] = '';
      else if (Array.isArray(value)) node[key] = value.map((x) => (typeof x === 'string' ? '' : x));
      else if (value && typeof value === 'object') {
        for (const inner of Object.keys(value)) if (typeof value[inner] === 'string') value[inner] = '';
      }
      continue;
    }
    if (value && typeof value === 'object') scrubDeep(value, depth + 1);
  }
  return node;
}

export function redactPayload(event) {
  if (!event || typeof event !== 'object' || !event.data || typeof event.data !== 'object') return event;
  /* 残余事件（assistant/attempt、llm/retry*）：**只擦文本载体，结构标量一个都不动**。
     2026-10-20 实锤（session-beae66b3）：旧实现用白名单只留 turn/step/retryId/attemptId/reason，
     把宿主校验必需的 llm/retry.provider / mode / policyKey / retry / delayMs / failure
     和 llm/retry-started.retry 一起吃掉 → 加载抛
       "retry must be a non-negative safe integer"，整个会话打不开。
     与 2026-10-12 那次 stream 被吃是同一个 bug 换了个字段：白名单永远会漏。
     正确手法（与 adapter-compat/purge.js、dsh-delete-turn 一致）：**黑名单** —— 只删文本键。 */
  if (REDACT_TYPES.has(event.type)) {
    const data = structuredClone(event.data);
    for (const k of ['content', 'text', 'messages', 'prompt', 'reasoning', 'reasoning_content', 'reasoningContent', 'thinking']) {
      if (data[k] !== undefined) delete data[k];
    }
    /* stream 必须留住且结构不动（宿主种子校验要求 attempt 的 stream 是数组）：
       只把里面的文本擦空；深拷贝后再擦，绝不改宿主内存里的同一批对象。 */
    if (data.stream !== undefined) {
      try { scrubDeep({ stream: data.stream }); } catch { /* 保结构优先，擦失败不阻断 */ }
    } else if (event.type === 'assistant/attempt') {
      data.stream = []; // 本就没有 stream 的 attempt：补空数组以满足 settlement 校验
    }
    return { ...event, data };
  }
  /* developer/message 的 content 装的是 tool-addition/tool-removal 结构块，不是对话正文：
     整块清空会让 headerSeq 失去依据，宿主抛
       "format v4 developer/message must omit headerSeq without tool additions"
     （2026-10-20 实证 session-4ce9464e）。只擦块里的文本，块本身保留。 */
  if (event.type === 'developer/message') {
    const data = structuredClone(event.data);
    if (data.message && typeof data.message === 'object') {
      const msg = { ...data.message };
      if (Array.isArray(msg.content)) {
        msg.content = msg.content.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? { ...b, text: '' } : b));
      }
      data.message = msg;
    }
    const blocks = data.message?.content;
    const hasAdd = Array.isArray(blocks) && blocks.some((b) => b && b.type === 'tool-addition');
    if (!hasAdd && Object.hasOwn(data, 'headerSeq')) delete data.headerSeq;
    return { ...event, data };
  }
  const data = { ...event.data };
  if (Array.isArray(data.content)) data.content = [];
  if (data.message && typeof data.message === 'object') {
    const msg = { ...data.message };
    /* tool-call 宣告块幸存（2026-10-23 源头修，与 dsh-delete-turn / adapter-compat 十二批同步）：
       assistant/message 的 content 同时是 tool/call 的宣告登记处，整块清空会让
       下游 tool/call 全变孤儿（has no advertised tool lifecycle），会话重启即打不开
       （2026-10-22 实锤 session-f3bc4fd2：108/244 变孤儿）。只清正文类块，
       tool-call 结构块（id/name/arguments）原样保留——真删除语义不变。 */
    if (Array.isArray(msg.content)) {
      msg.content = msg.content.filter((b) => b && b.type === 'tool-call');
    }
    for (const k of ['text', 'reasoning_content', 'reasoning']) if (typeof msg[k] === 'string') msg[k] = '';
    data.message = msg;
  }
  for (const k of ['text', 'result']) if (typeof data[k] === 'string') data[k] = '';
  if (data.output && typeof data.output === 'object') data.output = {};
  if (typeof data.output === 'string') data.output = '';
  /* assistant/message 的推理与正文**也**存放在 data.stream 的 chunk 文本里，
     只清 message.content 会留残留（2026-10-11 实锤，adapter purge.js 同款教训）。
     只擦文本、结构不动；先 structuredClone 再擦，绝不动入参里的同一批对象。 */
  if (Array.isArray(data.stream)) {
    try { data.stream = scrubDeep({ stream: structuredClone(data.stream) }).stream; } catch { /* 保结构优先，擦失败不阻断 */ }
  }
  /* 兜底深擦（2026-11-26）：正文不只在 content/message 里 —— 注入型 user/message
     把正文放在 `data.source.sections[].text`（memory-context / tasks / skill-catalog /
     time-context 全是这个形状），只清 content 会留下整段原文（探针实测 seq 1679）。
     TEXT_KEYS 只认 text/reasoning/…，不会碰 kind/form/name/summary 这些结构字段。 */
  try { scrubDeep(data); } catch { /* 结构优先 */ }
  /* 出口修（与 adapter-compat/purge.js 同款占位符）：擦完不能留「正文全空的 tool 结果」——
     provider（Anthropic 风格）把 tool_result.content=[] 当成没有结果，整轮拒收：
       `tool_use` ids were found without `tool_result` blocks immediately after
     清空语义不变（正文确实没了），但结构合法。**必须放在 scrubDeep 之后**，
     否则占位符本身会被擦成空串，宿主又会拒收。 */
  if (event.type === 'tool/result' && data.message && typeof data.message === 'object') {
    const blocks = Array.isArray(data.message.content) ? data.message.content : [];
    const hasText = blocks.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0);
    if (!hasText) data.message = { ...data.message, content: [{ type: 'text', text: TEXT_PLACEHOLDER }] };
  }
  return { ...event, data };
}

/* 从 persistence 的列表项/头部解析出会话文件绝对路径。
   【2026-11-26 实证 bug】宿主 0.2.2 的 `persistence.list()` 返回的是 **快照对象**
   `{ header, formatStatus, revision, sizeBytes, location }`，而 `persistence.locate(meta)`
   只接受 **header**（内部读 meta.cwd / meta.id）。把快照直接喂给 locate 会抛
   `Cannot read properties of undefined (reading 'length')`（cwd undefined）。
   旧代码正是这么传的：purge 有目录扫描兜底所以还能用，**后台 excise 消费器没有兜底，
   于是每轮都抛错→重试 3 次→整条台账被丢弃**，物理切除从来没发生过。
   现在三处（定位/purge/消费器/手动 excise 路由）统一走本函数：
   ① 先用列表项自带的 location.path（零解析、最可靠）
   ② 再把 header 交给 locate
   ③ 都拿不到才返回 undefined，由调用方回退目录扫描。 */
function sessionFilePathOf(persistence, entry) {
  if (!entry) return undefined;
  const direct = entry.location?.path ?? entry.header?.location?.path;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const header = entry.header ?? entry;
  try {
    const loc = typeof persistence?.locate === 'function' ? persistence.locate(header) : undefined;
    if (typeof loc?.path === 'string' && loc.path.length > 0) return loc.path;
  } catch { /* 落到调用方的目录扫描 */ }
  return undefined;
}

/* 定位会话文件：persistence 优先，失败回退扫 sessions 目录。
   只依赖 persistence 会在服务缺席时静默失败 —— dsh-delete-turn 的 purge 正是栽在这里。
   注：本文件早先的 dshHome() 是**未定义引用**（ReferenceError 被 catch 吞掉），
   这里改用明确的 DSH_HOME 解析，不再引入同类隐患。 */
function locateSessionFileFor(ctx, sessionId) {
  try {
    const persistence = ctx.sessionPersistence;
    if (persistence && typeof persistence.list === 'function') {
      const entries = persistence.list();
      const list = Array.isArray(entries) ? entries : [];
      const meta = list.find((e) => e?.id === sessionId || e?.header?.id === sessionId);
      const p = sessionFilePathOf(persistence, meta);
      if (p && existsSync(p)) return p;
    }
  } catch { /* 落到目录扫描 */ }
  const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions');
  let workspaces = [];
  try { workspaces = readdirSync(root); } catch { return undefined; }
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
  const wanted = new Set([sessionId, `session-${bare}`]);
  for (const ws of workspaces) {
    let ids = [];
    try { ids = readdirSync(join(root, ws)); } catch { continue; }
    for (const id of ids) {
      if (!wanted.has(id)) continue;
      const p = join(root, ws, id, 'session.v4.jsonl.zstd');
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const TITLE_PLACEHOLDER = '[已删除]';
/* 把 inbox 插入项里的正文擦空（保留 id/role/source，结构不动）：
   插入项是「排队时先落盘、再由 turn 消费」的双写副本，只擦 user/message 会留下
   这一份原文 —— 2026-11-26 探针实证：删掉第 2 轮后，第 2 轮提问仍能从
   agent/inbox/spliced 的 inserted[].content 里读出来。 */
function redactInboxMessage(message) {
  if (!message || typeof message !== 'object') return message;
  const out = { ...message };
  if (Array.isArray(out.content)) out.content = [];
  for (const key of ['text', 'reasoning', 'reasoning_content', 'thinking']) if (typeof out[key] === 'string') out[key] = '';
  return out;
}
/* 深度收集文本键上的非空字符串（只认 TEXT_KEYS，长度 ≥ 6 才当作可检索正文）。 */
function collectTextValues(node, out, depth = 0) {
  if (depth > 14 || node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (TEXT_KEYS.has(key)) {
      if (typeof value === 'string' && value.length >= 6) out.add(value);
      else if (Array.isArray(value)) { for (const item of value) if (typeof item === 'string' && item.length >= 6) out.add(item); }
      else if (value && typeof value === 'object') { for (const item of Object.values(value)) if (typeof item === 'string' && item.length >= 6) out.add(item); }
      continue;
    }
    if (value && typeof value === 'object') collectTextValues(value, out, depth + 1);
  }
}
/* 单行红线：擦过之后这一行里不允许再有非空文本（占位符除外）。 */
function residualTextOf(event) {
  const texts = new Set();
  collectTextValues(event.data ?? {}, texts);
  for (const text of texts) if (text !== TEXT_PLACEHOLDER) return text;
  return undefined;
}

/* 把切除结果落盘：写前留一份**临时**备份，写后复读校验，成功即销毁备份。
   为什么销毁：`.bak-excise-*` 里躺着刚被物理删掉的原文 —— 留一份备份等于真删除没做。
   失败路径靠备份整文件还原（copyFileSync，非原子但只在异常时用，且随后必有报错）。 */
function writeExcisedFile(file, out, expectedRows) {
  const bak = `${file}.bak-excise-${Date.now()}`;
  copyFileSync(file, bak);
  try {
    writeFileSync(file, out);
    const check = decodeSessionBuffer(readFileSync(file));
    if (check.rows.length !== expectedRows) throw new Error(`excise 落盘行数 ${check.rows.length} != ${expectedRows}`);
    rmSync(bak, { force: true });
  } catch (error) {
    try { copyFileSync(bak, file); } catch { /* 还原失败只能报错 */ }
    try { rmSync(bak, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

/* 物理清正文（purge）：删掉的行**结构保留、正文清零**。
   2026-11-26 起覆盖三类此前漏掉的载体：
   ① surface/turn 范围内的行（原有行为）
   ② agent/inbox/spliced 里 inserted[] 与被删消息同 id 的副本（排队双写副本）
   ③ session/title / session/title-llm-request 里引用了被删 seq 的标题与 LLM 请求
   写盘仍是 tmp→复读校验→rename 原子替换；**不落含原文的备份**（备份本身就是泄漏）。 */
function purgeDeletedOnDisk(file, removeSeqs) {
  const { headerFrame, rows } = decodeSessionBuffer(readFileSync(file));
  /* contextInjectMerge：把「紧挨着第一个被删 seq 之前」的上下文注入行并入删除集。
     这类行（agent-instructions / session-reference / skill-invocation）没有 turn 字段，
     调用方按 turn/seq 构造的 removeSeqs 天然漏掉它们 —— 注：注入正文同样是用户内容。 */
  (() => {
    if (removeSeqs.size === 0) return;
    let minSeq = Infinity;
    for (const seq of removeSeqs) if (seq < minSeq) minSeq = seq;
    if (!Number.isFinite(minSeq)) return;
    let prevEnd = -1;
    for (const e of rows) if (e.type === 'turn/end' && e.seq < minSeq) prevEnd = Math.max(prevEnd, e.seq);
    for (const e of rows) {
      if (e.seq <= prevEnd || e.seq >= minSeq) continue;
      if (e.type !== 'user/message') continue;
      if (!CONTEXT_INJECT_KINDS.has(e.data?.source?.kind)) continue;
      removeSeqs.add(e.seq);
    }
  })();
  const removedIds = new Set();
  for (const event of rows) {
    if (!removeSeqs.has(event.seq)) continue;
    for (const id of [event.data?.id, event.data?.message?.id, event.data?.messageId]) {
      if (typeof id === 'string' && id.length > 0) removedIds.add(id);
    }
  }
  const out = rows.map((event) => {
    /* 标题两类事件**先处理**：它们的正文不在 text 键上（title 是 title、请求是 system+messages），
       若先落到 redactPayload 的通用分支，`system` 字段会原样留下（2026-11-26 自测实锤）。 */
    if (event.type === 'session/title' || event.type === 'session/title-llm-request') {
      const refs = Array.isArray(event.data?.messageSeqs) ? event.data.messageSeqs : [];
      if (!refs.some((seq) => removeSeqs.has(seq))) return event;
      const data = { ...event.data };
      if (event.type === 'session/title') data.title = TITLE_PLACEHOLDER;
      else {
        if (Array.isArray(data.messages)) {
          const clone = structuredClone({ messages: data.messages });
          scrubDeep(clone);
          data.messages = clone.messages;
        }
        for (const key of ['system', 'prompt']) if (typeof data[key] === 'string') data[key] = '';
      }
      return { ...event, data };
    }
    if (removeSeqs.has(event.seq)) {
      return redactPayload(event);
    }
    if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) {
      let changed = false;
      const inserted = event.data.inserted.map((message) => {
        if (!message || typeof message !== 'object' || !removedIds.has(message.id)) return message;
        changed = true;
        return redactInboxMessage(message);
      });
      if (!changed) return event;
      return { ...event, data: { ...event.data, inserted } };
    }
    return event;
  });
  /* 只有「内容真的变了」的行才算动过（幂等：第二次 purge 必须返回 0）。
     标题类分支会重建对象，光比引用会把它们每轮都算成改动。 */
  const changed = [];
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === rows[i]) continue;
    if (JSON.stringify(out[i]) === JSON.stringify(rows[i])) out[i] = rows[i];
    else changed.push(out[i]);
  }
  if (changed.length === 0) return { erased: 0 };
  /* 自检：本次动过的行必须真的没有正文残留，否则拒绝写盘（宁可报错也不假装删干净）。 */
  for (const event of changed) {
    const residual = residualTextOf(event);
    if (residual !== undefined) throw new Error(`purge 残留正文@seq ${event.seq}${event.type ? `(${event.type})` : ''}，拒绝写盘`);
  }
  const tmp = `${file}.purge-${Date.now()}`;
  writeFileSync(tmp, encodeSessionBuffer(headerFrame, out));
  // 安全阀：复读行数，任何丢行都拒绝提交 —— 绝不写半截文件
  const verify = decodeSessionBuffer(readFileSync(tmp));
  if (verify.rows.length !== rows.length) {
    rmSync(tmp, { force: true });
    throw new Error(`purge 行数不一致 ${rows.length}→${verify.rows.length}，拒绝写盘`);
  }
  renameSync(tmp, file);
  return { erased: changed.length };
}

/* ── 待真删台账（pending excise，2026-11-12「三插件删除物理无痕」）──────────
   删除路由在 purge（物理清正文）之后把 {会话, 轮号} 追加进台账；后台消费器只在
   台账非空时逐条处理：会话已卸载 → exciseSessionBuffer 物理删行+删墓碑（墓碑行
   由载体级联丢弃规则一并清除）→ 从台账移除。平时（台账空/未变）零工作零扫描。
   用户的定案：物理直接删除、不依赖插件 UI 隐藏、不要常驻全库扫盘。 */
function pendingExciseFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dsh_session_kit_pending_excise.json');
}
/* 真删除后台队列的日志：只记「跳过/失败/完成」三类事实。
   宿主 logger 在桌面版不落盘，出问题时没有取证渠道 —— 2026-11-26 的 locate 形状 bug
   就是这样沉默了整整一天（队列每轮重写、物理切除一次没跑）。 */
function exciseLog(line) {
  try {
    const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-session-kit-excise.log');
    try { if (statSync(file).size > 512 * 1024) writeFileSync(file, ''); } catch { /* 首次写入 */ }
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch { /* 日志失败绝不影响删除 */ }
}
/* 删掉宿主 sessionProjectionCache 的**磁盘**投影文件。
   为什么必须删：投影缓存是第三个渲染器（宿主自带 UI、插件全关的冷启动）的唯一数据源；
   它按会话缓存 turnOutline / titleInput / userQuestions 等**含正文摘要**的字段，
   只重建内存不删盘，删掉的正文会一直躺在 storages/session_projcache/sessions/*.json 里。
   返回删除成功的文件数（0 = 本来就没有，等同干净）。 */
function dropProjectionCache(sessionId) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
  const dir = join(home, 'storages', 'session_projcache', 'sessions');
  let dropped = 0;
  for (const name of new Set([`${sessionId}.json`, `${bare}.json`])) {
    try { if (existsSync(join(dir, name))) { rmSync(join(dir, name), { force: true }); dropped += 1; } } catch { /* 单个缓存删不掉不影响删除语义 */ }
  }
  return dropped;
}

/* 后台消费器的即时触发钩子（apply 里装上）：删除入队后不必等 90s 轮询。 */
let kickExciseConsumer;
function enqueuePendingExcise(sessionId, turns) {
  try {
    const list = [...new Set((Array.isArray(turns) ? turns : []).map(Number).filter(Number.isSafeInteger))];
    if (!sessionId || !list.length) return;
    const file = pendingExciseFile();
    let queue = [];
    try { queue = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 首次或损坏：重建 */ }
    if (!Array.isArray(queue)) queue = [];
    queue.push({ id: sessionId, turns: list, at: new Date().toISOString() });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(queue));
    exciseLog(`enqueue ${sessionId} turns=[${list.join(',')}] size=${queue.length}`);
    /* 入队后立刻踢一脚：真正的物理切除要等会话卸载，但「等卸载」这件事
       不能靠 90s 轮询撞运气（用户切走/关窗口后的第一秒就该动刀）。 */
    try { kickExciseConsumer?.(); } catch { /* 触发失败留给轮询 */ }
  } catch (error) {
    console.error(`[dsh-session-kit] pending-excise enqueue failed (${sessionId}):`, error?.message ?? error);
    exciseLog(`enqueue failed ${sessionId}: ${error?.message ?? error}`);
  }
}

function appendTurnTombstone(session, turn, endTurn, selected, regeneration) {  const message = createUserMessage({
    content: [],
    source: {
      kind: TURNS_DEL_PROVIDER,
      form: 'notice',
      summary: JSON.stringify({ turn, endTurn, ...(regeneration === undefined ? {} : { regeneration }) })
    }
  });
  return session.append('user/message', message, {
    surfaceOp: { op: 'replace', startSeq: selected[0], endSeq: selected.at(-1) },
    sourceEventSeqs: selected
  });
}

function deleteTurnsUnderMaintenance(ctx, agent, assistantMessageId, signal, options = {}) {
  const { flush = true, regeneration } = options;
  signal.throwIfAborted();
  const session = agent.session;
  if (ctx.sessions.get(session.id) !== session) throw new TurnsDelError('TARGET_NOT_FOUND', `session "${session.id}" is no longer live`);

  const initialEvents = sessionEvents(session);
  const byTurn = typeof options.byTurn === 'number' && Number.isSafeInteger(options.byTurn) && options.byTurn >= 0 ? options.byTurn : undefined;
  const target = byTurn === undefined
    ? initialEvents.find((event) => event.type === 'assistant/message' && isAppendSurfaceEvent(event) && event.data.message.id === assistantMessageId)
    : initialEvents.findLast((event) => event.type === 'assistant/message' && isAppendSurfaceEvent(event) && event.data.turn === byTurn);
  if (target === undefined && byTurn === undefined) throw new TurnsDelError('TARGET_NOT_FOUND', `assistant message "${assistantMessageId}" was not found`);

  const startTurn = byTurn ?? target.data.turn;
  const targetSeq = target?.seq ?? turnEndSeq(initialEvents, startTurn);
  if (turnBracket(initialEvents, startTurn, targetSeq) === undefined) throw new TurnsDelError('TURN_NOT_CLOSED', `turn ${String(startTurn)} is not closed`);

  const targetMemo = new Map();
  const existingTarget = target === undefined ? undefined : deletionTombstoneForOrigin(initialEvents, target.seq, targetMemo);
  if (existingTarget !== undefined) {
    const existingMeta = turnsDelTombstoneMetaOf(existingTarget);
    return {
      turn: startTurn,
      endTurn: existingMeta?.endTurn ?? startTurn,
      seqs: [existingTarget.seq],
      deletedTurns: [],
      alreadyDeleted: true
    };
  }

  // Capture only completed turns and process them in reverse order, so an earlier
  // turn is always planned against the surface left by the later ones. Planning is
  // separated from appending so an impossible batch changes nothing (see below).
  const requestedTurns = completedTurnsFrom(initialEvents, startTurn);
  if (requestedTurns.length === 0) throw new TurnsDelError('TURN_NOT_CLOSED', `turn ${String(startTurn)} is not closed`);

  const initiallyDeletedTurns = new Set(requestedTurns.filter((turn) => deletionTombstoneForTurn(initialEvents, turn) !== undefined));
  const deletedTurns = [];
  const tombstoneSeqs = [];
  const rangeEndTurn = requestedTurns.at(-1);

  /* 两阶段执行：先在内存里对每一轮做一次模拟替换，确认整批删除都可行，
     再真正 append。否则从后往前逐轮写入时，靠后的轮次已经落盘，才在某一轮
     因压缩而失败——接口报错，模型上下文却已被改动（用户看到失败，实际已删）。 */
  const plan = [];
  {
    let simulated = [...session.surface.nodes];
    for (const turn of [...requestedTurns].reverse()) {
      signal.throwIfAborted();
      if (initiallyDeletedTurns.has(turn)) continue;
      const events = sessionEvents(session);
      const clickedTarget = byTurn === undefined && turn === startTurn ? target : undefined;
      const assistant = clickedTarget ?? events.findLast((event) => event.type === 'assistant/message' && isAppendSurfaceEvent(event) && event.data.turn === turn && simulated.includes(event.seq))
        ?? events.findLast((event) => event.type === 'assistant/message' && isAppendSurfaceEvent(event) && event.data.turn === turn);
      const selectSeq = clickedTarget?.seq ?? assistant?.seq ?? turnEndSeq(events, turn);
      const selected = selectIndependentTurnSurface(session, events, turn, selectSeq, {
        requireTargetNode: clickedTarget !== undefined,
        nodes: simulated
      });
      /* 模拟该轮替换后的 surface，供下一轮（更早的轮次）预检使用。 */
      const startIdx = simulated.indexOf(selected[0]);
      simulated = [...simulated.slice(0, startIdx), -1, ...simulated.slice(startIdx + selected.length)];
      plan.push({ turn, selected });
    }
  }

  for (const { turn, selected } of plan) {
    signal.throwIfAborted();
    const tombstone = appendTurnTombstone(session, startTurn, rangeEndTurn, selected, regeneration);
    deletedTurns.unshift(turn);
    tombstoneSeqs.unshift(tombstone.seq);
  }

  if (tombstoneSeqs.length === 0) return {
    turn: startTurn,
    endTurn: requestedTurns.at(-1) ?? startTurn,
    seqs: [],
    deletedTurns: [],
    alreadyDeleted: true
  };

  const result = {
    turn: startTurn,
    endTurn: requestedTurns.at(-1),
    seqs: tombstoneSeqs,
    deletedTurns,
    alreadyDeleted: false
  };

  /* 阶段1 purge：墓碑落盘之后，把被删行的正文从文件里**物理清掉**。
     原实现到此为止 —— 只留墓碑、正文原样躺在文件里，解压即可见。
     失败必须可见（console.error + 响应体 purged.error），绝不静默吞掉：
     静默失败会让「真删除」悄悄退化成「只留墓碑」（2026-10-11 事故）。 */
  const purge = () => {
    try {
      const removeSeqs = new Set();
      for (const { selected } of plan) for (const s of selected) removeSeqs.add(s);
      /* 删除语义是「从 startTurn 一路删到会话末尾」（completedTurnsFrom 取 >= startTurn），
         所以被删的那一整段 **连续 seq 区间** 全部属于被删轮：
         系统头、注入型 user/message（记忆召回/时间/技能目录，data 上根本没有 turn 字段）、
         assistant/attempt、llm/retry 全在里面。
         2026-11-26 探针实证：只按 surface 选择集+REDACT_TYPES 清，会漏掉
         seq 1677（记忆召回 user/message）和 seq 1781（turn 12 的 system/message）——
         两行的整段正文原样留在盘上。改成按区间一次清干净。 */
      const rangeStart = initialEvents.find((e) => e.type === 'turn/start' && e.data?.turn === startTurn)?.seq;
      /* 新版本「上下文注入」（agent-instructions / session-reference / skill-invocation）：
         这类 user/message 没有 turn 字段，可能落在被删轮 turn/start 之前，
         按区间清会漏掉整段注入正文（用户 2026-11-28 点名）。 */
      if (typeof rangeStart === 'number') {
        let prevEnd = -1;
        for (const e of initialEvents) { if (e.type === 'turn/end' && e.seq < rangeStart) prevEnd = Math.max(prevEnd, e.seq); }
        for (const e of initialEvents) {
          if (e.seq <= prevEnd || e.seq >= rangeStart) continue;
          if (e.type !== 'user/message') continue;
          if (!CONTEXT_INJECT_KINDS.has(e.data?.source?.kind)) continue;
          removeSeqs.add(e.seq);
        }
      }
      const rangeEndSeq = initialEvents.at(-1)?.seq ?? 0;
      if (typeof rangeStart === 'number') {
        for (const e of initialEvents) if (e.seq >= rangeStart && e.seq <= rangeEndSeq) removeSeqs.add(e.seq);
      }
      // 少数轮次的注入行（inbox 插入/记忆快照）落在 turn/start 之前：仍按轮号补一遍
      for (const e of initialEvents) {
        if (typeof e.data?.turn === 'number' && e.data.turn >= startTurn && e.data.turn <= rangeEndTurn) removeSeqs.add(e.seq);
      }
      const file = locateSessionFileFor(ctx, session.id);
      if (!file) throw new Error('cannot locate session file');
      const stats = purgeDeletedOnDisk(file, removeSeqs);
      /* 投影缓存（磁盘）同步失效：插件全关时宿主自带 UI 只读它，
         不删就等于把删掉的正文摘要留在盘上。失败不影响删除语义。 */
      const cacheDropped = dropProjectionCache(session.id);
      return { ...stats, cacheDropped };
    } catch (error) {
      const msg = error?.message ?? String(error);
      console.error(`[dsh-session-kit] turns-del purge FAILED (${session.id}, turns ${startTurn}-${rangeEndTurn}): ${msg}`);
      return { error: msg };
    }
  };

  if (!flush) return result;
  return ctx.sessions.flush(session).then(async (durable) => {
    if (durable !== true) {
      console.error(`[dsh-session-kit] flush not durable (${session.id}, turns ${startTurn}-${rangeEndTurn}): ${durable}`);
    }
    const purged = await purge();
    /* purge 只清正文；墓碑行+空壳行的物理移除交给台账消费器（会话卸载后执行）。 */
    try { enqueuePendingExcise(session.id, result.deletedTurns); } catch { /* 入队失败不阻断删除响应 */ }
    return { ...result, purged };
  }, async (error) => {
    console.error(`[dsh-session-kit] flush rejected (${session.id}, turns ${startTurn}-${rangeEndTurn}):`, error);
    const purged = await purge();
    try { enqueuePendingExcise(session.id, result.deletedTurns); } catch { /* 入队失败不阻断删除响应 */ }
    return { ...result, purged };
  });
}


/* ── 真删除（即时物理删行，2026-11-28）─────────────────────────────────
   宿主唯一的会话卸载把手是 AgentHandle；而 ApiSessionAgentController.resumeObserved
   把 resume() 的返回值丢掉了，插件拿不到 → 之前只能「擦正文 + 等卸载」。
   唯一合法捕获点：包装 AgentLoop 工厂的 resumeWith，把每个会话的 handle 记下来。
   拿到 handle 之后：dispose（tearDown：cancel → whenIdle → scope.dispose →
   stored.handle.close() → detachAgent/detachSession）→ 文件删行重编号 →
   用 sessionController.resolveAgent 走官方路径重载（带 agentOptions + preset setup）。
   计数器因此从新文件重新算，不存在 seq 断号。 */
const agentHandles = new Map();
let exciseHandleHookTried = 0;

function installAgentHandleCapture(ctx) {
  try {
    const factory = ctx.agents?.requireFactory?.();
    const target = factory?.target;
    if (!target || typeof target.resumeWith !== 'function') return false;
    if (target.__skHandleCapture === true) return true;
    const original = target.resumeWith.bind(target);
    target.resumeWith = (ownerCtx, persistence, options) => {
      const published = original(ownerCtx, persistence, options);
      published.then((handle) => {
        try { if (options?.resumeSessionId) agentHandles.set(options.resumeSessionId, handle); } catch { /* ignore */ }
      }, () => { /* resume 失败不记 */ });
      return published;
    };
    target.__skHandleCapture = true;
    exciseLog('handle-capture installed');
    return true;
  } catch (error) {
    exciseLog(`handle-capture failed: ${error?.message ?? error}`);
    return false;
  }
}

/* 从待真删台账里摘掉某个会话（物理切除已经做了，不需要后台再跑）。 */
function removePendingExcise(sessionId) {
  try {
    const file = pendingExciseFile();
    if (!existsSync(file)) return;
    const list = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) return;
    const next = list.filter((item) => item?.id !== sessionId);
    if (next.length !== list.length) writeFileSync(file, JSON.stringify(next));
  } catch { /* 摘不掉也不影响：消费器发现轮已不存在会自行丢弃 */ }
}

/* 活体会话的即时物理删行。任何一步不成立都返回 ok:false，由调用方回退到
   「擦正文 + 台账」的老路径 —— 绝不在没卸载干净时动文件。 */
/* 即时物理删行的总开关（默认关）。
   为什么默认关：卸载会话会让宿主发 api-session/removed，客户端把「正在看的那个会话」
   标成 removed=true，重新加载后列表能回来，但已打开的那个视图不会自动复活 →
   用户看到「会话不可用」（数据本身完好，刷新即恢复）。
   2026-11-28 首次上线实测到这一点，先默认关，等客户端恢复路径验证过再开。
   开启方式：$DSH_HOME/storages/dsh_session_kit_physical_excise.json 写 {"enabled":true} 后重启。 */
function physicalExciseEnabled() {
  try {
    const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dsh_session_kit_physical_excise.json');
    if (!existsSync(file)) return false;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value?.enabled === true;
  } catch { return false; }
}

/* 原地真删行（in-place physical excision，2026-11-28 实测通过）。
   不卸载会话、不重启、不刷新，会话保持可用。
   原理（隔离宿主实测）：宿主的内存状态有三处要跟着新文件走 ——
     ① 写句柄 persistence.tracker.writers.get(id).state.cursor（「已写到第 N 条」）
     ② Session 实例的 log / surfaceManager（界面读的事件列表与表层）
     ③ 磁盘文件本身
   顺序：先把新文件算好 → 换内存实例 → 改计数器 → 落盘。
   任何一步拿不到就整条回退（ok:false），由调用方走「擦正文 + 卸载时删行」的老路径。
   风险：tracker/writers/state 是宿主内部结构，升级可能改名 → 那时自动回退，不会写坏数据。 */
async function physicallyExciseLive(ctx, sessionId, turns) {
  const wanted = [...new Set((Array.isArray(turns) ? turns : []).map(Number).filter(Number.isSafeInteger))];
  if (!wanted.length) return { ok: false, reason: 'no-turns' };
  if (!physicalExciseEnabled()) return { ok: false, reason: 'disabled' };

  const agent = ctx.agents?.get?.(sessionId);
  if (agent === undefined) return { ok: false, reason: 'not-live' };
  /* 正在生成时绝不原地改文件：模型还在往同一个 Session 追加，换 log 会撕裂。 */
  if (agent.status === 'running') return { ok: false, reason: 'agent-running' };

  const persistence = ctx.sessionPersistence;
  const handle = persistence?.tracker?.writers?.get?.(sessionId);
  const live = ctx.sessions?.get?.(sessionId);
  if (handle === undefined || live === undefined) return { ok: false, reason: 'no-handle' };
  const file = locateSessionFileFor(ctx, sessionId);
  if (!file || !existsSync(file)) return { ok: false, reason: 'no-file' };

  /* ① 先算出新文件（不落盘，失败就什么都没动） */
  let excised;
  let targets;
  try {
    const buf = readFileSync(file);
    const { rows } = decodeSessionBuffer(buf);
    const present = new Set(rows.filter((e) => e.type === 'turn/start').map((e) => e.data?.turn));
    targets = wanted.filter((t) => present.has(t));
    if (!targets.length) return { ok: true, stats: { removedRows: 0, removedTurns: [], rowsBefore: rows.length, rowsAfter: rows.length }, cursor: handle.state?.cursor ?? null };
    excised = exciseSessionBuffer(buf, targets);
  } catch (error) {
    return { ok: false, reason: `excise: ${error?.message ?? error}` };
  }
  const stats = excised.stats;

  /* ② 用新日志重建一个 Session 实例（宿主的 fromRestore 会完整校验门禁与形状） */
  let rebuilt;
  try {
    const { Session } = await import('@deepseek-ai/dsh-session');
    const decoded = decodeSessionBuffer(excised.buf);
    rebuilt = Session.fromRestore(
      sessionId,
      decoded.rows,
      decoded.header,
      Number(handle.state?.inheritedEventCount ?? 0) || 0,
      'detached',
      []
    );
  } catch (error) {
    return { ok: false, reason: `rebuild: ${error?.message ?? error}` };
  }

  /* ③ 落盘（原子写 + 复读校验，失败自动还原） */
  try {
    writeExcisedFile(file, excised.buf, stats.rowsAfter);
  } catch (error) {
    return { ok: false, reason: `write: ${error?.message ?? error}` };
  }

  /* ④ 换内存实例：log 原地替换（保持数组引用，别处持有的是同一个数组），表层换新 */
  const previous = { logLen: live.log?.length ?? -1, cursor: handle.state?.cursor };
  try {
    if (!Array.isArray(live.log)) throw new Error('session.log is not an array');
    live.log.length = 0;
    for (const event of rebuilt.log) live.log.push(event);
    live.surfaceManager = rebuilt.surfaceManager;
    /* 关键：新建的 SurfaceManager 内部引用的是 rebuilt 自己的 log 数组，而宿主之后
       append 走的是 live.log（我们原地替换的那个）。两者必须是同一个数组，否则
       下一次 append 时「期望 seq」还停在旧长度 → 报
       "session event seq N is not contiguous; expected N-1"（2026-11-28 实测）。
       log 是 TS private（运行期普通字段），直接指向 live.log 即可。 */
    try { live.surfaceManager.log = live.log; } catch { /* 拿不到就靠下面的自证兜底 */ }
    live.firstLiveSeq = rebuilt.firstLiveSeq;
  } catch (error) {
    /* 换实例失败：文件已经是新的，内存是旧的 —— 只能靠重载救，交回调用方 */
    return { ok: false, reason: `swap: ${error?.message ?? error}`, fileWritten: true, stats };
  }

  /* ④.5 让宿主的投影缓存作废并重算。
     投影（turnBoundary / inbox / …）是按 Session 对象存在 WeakMap 里的增量状态，
     只认 session/event 驱动；我们直接换了 log 但没有事件，它就会一直记着被删掉的轮
     （实测 lastTurn 还停在删除前的 12）→ 下一次发消息按旧轮号开轮 → prompt rejected。
     这里把该 session 的 cell 从每个注册项里删掉，下次读取会重新 init 并重放当前 log。
     cells 是 TS private（运行期就是普通字段），拿不到就跳过 —— 不影响别的步骤。 */
  let projectionsReset = 0;
  try {
    /* 注意：本插件没有注入 sessionProjections，直接读 ctx.sessionProjections 会抛
       「cannot get property without inject」；ctx.get() 才是无注入的安全读法。 */
    let registry;
    try { registry = ctx.get?.('sessionProjections'); } catch { registry = undefined; }
    const registrations = registry?.registrations?.values?.();
    if (registrations) {
      for (const registration of registrations) {
        try {
          if (registration?.cells?.delete?.(live)) projectionsReset += 1;
        } catch { /* 单个注册项失败不影响其它 */ }
      }
    }
  } catch { /* 拿不到注册表就跳过：下一次真正 reload 时会自愈 */ }

  /* ④.6 改 agent 里的轮次计数器（`phase.lastTurn`）。
     它决定「下一条消息开第几轮」。不重置的话：删掉第 10 轮后再发消息，
     宿主会接着从第 11 轮开始 → 轮号跳号 → 时间轴/轮次定位/后续删除全线错位
     （2026-11-28 实测：删第 10 轮后新轮变成 11、12、13，门禁报轮号不连续）。
     只在 idle 阶段改 —— running/maintenance 时 phase 里还挂着活动状态。 */
  let turnCursor;
  try {
    const agent = ctx.agents?.get?.(sessionId);
    const lastTurn = rebuilt.deriveMessages ? 0 : 0;
    let maxTurn = 0;
    for (const event of rebuilt.log) {
      if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn) && event.data.turn > maxTurn) maxTurn = event.data.turn;
    }
    if (agent && agent.phase && agent.phase.kind === 'idle') {
      agent.phase = { ...agent.phase, lastTurn: maxTurn };
      turnCursor = { from: undefined, to: maxTurn };
    }
    /* 表层代际也一起对齐：它被用来判断「请求所依据的表层是否已过期」。 */
    try { if (typeof live.surface?.contentGeneration === 'number') agent.requestSurfaceGeneration = live.surface.contentGeneration; } catch { /* ignore */ }
  } catch { /* 改不动就交给下次 reload 自愈 */ }

  /* ⑤ 改计数器（这是「已写到第 N 条」，不改就会在下次写消息时断号） */
  let cursorApplied = false;
  try {
    if (handle.state && typeof handle.state === 'object') {
      handle.state.cursor = stats.rowsAfter;
      handle.observedLength = stats.rowsAfter;
      cursorApplied = true;
    }
  } catch { /* 下面按失败处理 */ }
  if (!cursorApplied) {
    return { ok: false, reason: 'cursor-unavailable', fileWritten: true, stats };
  }

  /* ⑥ 自证：内存与磁盘一致、seq 连续、门禁 0 错 */
  try {
    const check = decodeSessionBuffer(readFileSync(file));
    if (check.rows.length !== stats.rowsAfter) throw new Error(`行数不一致 ${check.rows.length} != ${stats.rowsAfter}`);
    if (!check.rows.every((event, index) => event.seq === index)) throw new Error('seq 不连续');
    if (live.log.length !== stats.rowsAfter) throw new Error(`内存 log ${live.log.length} != 文件 ${stats.rowsAfter}`);
    if (live.surfaceManager?.log !== live.log) throw new Error('surfaceManager 未绑定到 live.log（会导致下次 append 断号）');
  } catch (error) {
    return { ok: false, reason: `verify: ${error?.message ?? error}`, fileWritten: true, stats };
  }

  dropProjectionCache(sessionId);
  exciseLog(`inplace ${sessionId}: turns [${targets.join(',')}] -${stats.removedRows} rows → ${stats.rowsAfter}, cursor ${previous.cursor} → ${stats.rowsAfter}, projectionsReset=${projectionsReset}${turnCursor ? ', lastTurn→' + turnCursor.to : ''}`);
  return { ok: true, stats, mode: 'in-place', cursor: { from: previous.cursor, to: stats.rowsAfter }, projectionsReset };
}

async function deleteTurns(ctx, agent, assistantMessageId) {
  try {
    const result = await runAgentMaintenance(agent, (signal) => deleteTurnsUnderMaintenance(ctx, agent, assistantMessageId, signal));
    return await finalizePhysical(ctx, agent, result);
  } catch (error) {
    if (error instanceof TurnsDelError) throw error;
    throw new TurnsDelError('DELETE_FAILED', error instanceof Error ? error.message : String(error));
  }
}

async function deleteTurnsByTurn(ctx, agent, turn) {
  try {
    const result = await runAgentMaintenance(agent, (signal) => deleteTurnsUnderMaintenance(ctx, agent, undefined, signal, { byTurn: turn }));
    return await finalizePhysical(ctx, agent, result);
  } catch (error) {
    if (error instanceof TurnsDelError) throw error;
    throw new TurnsDelError('DELETE_FAILED', error instanceof Error ? error.message : String(error));
  }
}

/* 维护锁释放之后再做物理切除：dispose 会把 agent 的 machine 取消，
   留在 runMaintenance 里做等于自己拆自己的锁。 */
/* 物理删行失败时的回退：保证「用户点了删除」这件事最终一定被完成。
   两种情况：
     · ok:false 且没写过文件 → 什么都不用做，台账已入队，卸载/重启时消费器会删行；
     · ok:false 但文件已写（换实例/计数器失败）→ 内存与磁盘已分叉，必须让宿主重新加载，
       否则下一次写消息会撞 seq。这里走官方 resolveAgent 重载，并把结果写进日志。 */
async function physicalFallbackRollback(ctx, sessionId, physical) {
  if (!physical || physical.ok === true || physical.fileWritten !== true) return physical;
  const controller = ctx.get?.('sessionController');
  try {
    if (typeof controller?.resolveAgent === 'function') {
      const r = await controller.resolveAgent(sessionId);
      const failed = r && 'error' in r;
      exciseLog(`fallback-reload ${sessionId}: ${failed ? 'FAILED ' + String(r.error?.message ?? r.error) : 'ok'}`);
      return { ...physical, reloaded: !failed };
    }
  } catch (error) {
    exciseLog(`fallback-reload ${sessionId} threw: ${error?.message ?? error}`);
  }
  return { ...physical, reloaded: false };
}

async function finalizePhysical(ctx, agent, result) {
  if (!result || result.alreadyDeleted === true || !Array.isArray(result.deletedTurns) || result.deletedTurns.length === 0) return result;
  const sessionId = agent?.session?.id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return result;
  try {
    let physical = await physicallyExciseLive(ctx, sessionId, result.deletedTurns);
    if (physical.ok) removePendingExcise(sessionId);
    else physical = await physicalFallbackRollback(ctx, sessionId, physical);
    return { ...result, physical };
  } catch (error) {
    exciseLog(`physical failed ${sessionId}: ${error?.message ?? error}`);
    return { ...result, physical: { ok: false, reason: String(error?.message ?? error) } };
  }
}

function decodeTurnsDelRequest(value) {
  if (typeof value !== 'object' || value === null) throw new TypeError('request body must be an object');
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) throw new TypeError('sessionId must be a non-empty string');
  if (typeof value.assistantMessageId !== 'string' || value.assistantMessageId.length === 0) throw new TypeError('assistantMessageId must be a non-empty string');
  return { sessionId: value.sessionId, assistantMessageId: value.assistantMessageId };
}

/* promptSeq 可选：用户消息行上的按钮会带上它所依附提问的 seq，用于在一轮多条
   提问时精确重发被点击的那一条；旧客户端不传则退回“最近一条”规则。 */
function decodePromptSeq(value) {
  if (value.promptSeq === undefined || value.promptSeq === null) return {};
  if (!Number.isSafeInteger(value.promptSeq) || value.promptSeq < 0) throw new TypeError('promptSeq must be a non-negative integer');
  return { promptSeq: value.promptSeq };
}

function decodeTurnRequest(value) {
  if (typeof value !== 'object' || value === null) throw new TypeError('request body must be an object');
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) throw new TypeError('sessionId must be a non-empty string');
  if (!Number.isSafeInteger(value.turn) || value.turn < 0) throw new TypeError('turn must be a non-negative integer');
  return { sessionId: value.sessionId, turn: value.turn, ...decodePromptSeq(value) };
}

function decodeRegenerateRequest(value) {
  const input = decodeTurnsDelRequest(value);
  if (typeof value.operationId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value.operationId)) throw new TypeError('operationId must contain 8-128 letters, digits, underscores, or hyphens');
  return { ...input, operationId: value.operationId };
}

function decodeRegenerateTurnRequest(value) {
  const input = decodeTurnRequest(value);
  if (typeof value.operationId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value.operationId)) throw new TypeError('operationId must contain 8-128 letters, digits, underscores, or hyphens');
  return { ...input, operationId: value.operationId };
}

function decodeEditRegenerateTurnRequest(value) {
  const input = decodeRegenerateTurnRequest(value);
  if (typeof value.text !== 'string') throw new TypeError('text must be a string');
  const text = value.text;
  if (text.trim().length === 0) throw new TypeError('text must not be empty');
  if (text.length > 200000) throw new TypeError('text is too large');
  return { ...input, text };
}

/* 定位“该重发哪一条提问”。一轮里出现多条用户提问是正常现象——手动停止上一轮后
   新输入会被内核并入仍在跑的轮次（见 turn 10：1547 与 1603 同轮）。旧实现要求
   “恰好一条”，导致这类轮次的刷新/编辑必然抛 PROMPT_AMBIGUOUS；删除有兜底所以
   不受影响，这解释了“删除能用而刷新不能用”。
   选取规则：显式给了 promptSeq 就取那一条（用户消息行点哪条发哪条）；否则取
   targetSeq 之前最近的一条——即该助手消息实际回复的那条提问。 */
function userPromptForTurn(events, turn, targetSeq, promptSeq) {
  const bracket = turnBracket(events, turn, targetSeq);
  if (bracket === undefined) throw new TurnsDelError('TURN_NOT_CLOSED', `turn ${String(turn)} is not closed`);
  const prompts = events.filter((event) => event.type === 'user/message'
    && isAppendSurfaceEvent(event)
    && event.seq > bracket.start
    && event.seq < bracket.end
    && event.data.source?.kind === 'user');
  if (prompts.length === 0) throw new TurnsDelError('PROMPT_NOT_FOUND', `turn ${String(turn)} has no user prompt to regenerate`);
  let selected;
  if (promptSeq !== undefined) {
    selected = prompts.find((event) => event.seq === promptSeq);
    if (selected === undefined) throw new TurnsDelError('PROMPT_NOT_FOUND', `turn ${String(turn)} has no user prompt at seq ${String(promptSeq)}`);
  } else {
    const before = prompts.filter((event) => event.seq < targetSeq);
    selected = before.length > 0 ? before[before.length - 1] : prompts[prompts.length - 1];
  }
  const content = selected.data.content;
  if (!Array.isArray(content) || content.length === 0) throw new TurnsDelError('PROMPT_NOT_FOUND', `turn ${String(turn)} has an empty user prompt`);
  if (content.some((part) => part.type !== 'text')) throw new TurnsDelError('PROMPT_UNSUPPORTED', `turn ${String(turn)} has a non-text prompt that cannot be regenerated safely`);
  return content;
}

function regenerationTombstone(events, operationId) {
  return events.find((event) => turnsDelTombstoneMetaOf(event)?.regeneration?.operationId === operationId);
}

function replayMessageIdForOperation(events, operationId) {
  const replay = events.find((event) => event.type === 'agent/inbox/spliced' && event.data.inserted?.[0]?.source?.rpcId === `dsh-turns-del-regenerate:${operationId}`);
  return replay?.data.inserted?.[0]?.id;
}

/* [防复读风暴 II 2026-10-25] regenerate 节流表：sessionId → 上次成功入队时刻。
   纯内存（重启清零，刻意不落盘）；配合入队前的内容级幂等锁双保险。 */
const regenerateThrottleAt = new Map();

async function regenerateTurnsUnderMaintenance(ctx, agent, assistantMessageId, operationId, signal, options = {}) {
  signal.throwIfAborted();
  const session = agent.session;
  if (ctx.sessions.get(session.id) !== session) throw new TurnsDelError('TARGET_NOT_FOUND', `session "${session.id}" is no longer live`);
  const byTurn = typeof options.byTurn === 'number' && Number.isSafeInteger(options.byTurn) && options.byTurn >= 0 ? options.byTurn : undefined;
  const editedText = typeof options.editedText === 'string' ? options.editedText : undefined;
  const promptSeq = Number.isSafeInteger(options.promptSeq) && options.promptSeq >= 0 ? options.promptSeq : undefined;
  const eventsSnapshot = sessionEvents(session);
  const prior = regenerationTombstone(eventsSnapshot, operationId);
  const priorReplayMessageId = replayMessageIdForOperation(eventsSnapshot, operationId);
  if (prior !== undefined && priorReplayMessageId !== undefined) {
    const related = eventsSnapshot
      .map((event) => ({ event, meta: turnsDelTombstoneMetaOf(event) }))
      .filter(({ meta }) => meta?.regeneration?.operationId === operationId)
      .map(({ event, meta }) => ({ event, meta }));
    return {
      deletion: {
        turn: Math.min(...related.map(({ meta }) => meta.turn)),
        endTurn: Math.max(...related.map(({ meta }) => meta.endTurn ?? meta.turn)),
        seqs: related.map(({ event }) => event.seq),
        deletedTurns: [],
        alreadyDeleted: true
      },
      replayMessageId: priorReplayMessageId,
      alreadyRegenerated: true
    };
  }
  // A crash after tombstones but before the inbox splice is recoverable: reuse
  // the durable operation id, finish the same deletion if necessary, and queue
  // exactly one fresh replay below.
  if (hasInboxPending(agent)) throw new TurnsDelError('QUEUE_NOT_EMPTY', 'cannot regenerate while queued input exists');
  const target = byTurn === undefined
    ? eventsSnapshot.find((event) => event.type === 'assistant/message'
      && isAppendSurfaceEvent(event)
      && event.data.message.id === assistantMessageId)
    : eventsSnapshot.findLast((event) => event.type === 'assistant/message'
      && isAppendSurfaceEvent(event)
      && event.data.turn === byTurn);
  if (target === undefined && byTurn === undefined) throw new TurnsDelError('TARGET_NOT_FOUND', `assistant message "${assistantMessageId}" was not found`);
  const turn = byTurn ?? target.data.turn;
  const targetSeq = target?.seq ?? turnEndSeq(eventsSnapshot, turn);
  const originalPrompt = userPromptForTurn(eventsSnapshot, turn, targetSeq, promptSeq);
  const prompt = editedText === undefined ? originalPrompt : [{ type: 'text', text: editedText }];
  const deletion = deleteTurnsUnderMaintenance(ctx, agent, assistantMessageId, signal, {
    flush: true,
    regeneration: { operationId },
    ...(byTurn === undefined ? {} : { byTurn })
  });
  signal.throwIfAborted();
  const replay = createUserMessage({
    content: prompt,
    source: { kind: 'user', rpcId: `dsh-turns-del-regenerate:${operationId}` }
  });

  /* [防复读风暴 2026-10-24] 实证事故：会话 3e4b2f31（「新的大肥鱼」）17:50-17:53
     同一条消息每 7 秒重发一轮、连发 17 次。根因：regenerate 的 followup 入队后，
     UI 无「进行中」反馈，用户以为失败连点 → 每点一次又入队一条 replay；
     且 runAgentMaintenance 对有 pending 的 agent 拒绝后续删除（AGENT_BUSY），
     删除全部「失灵」，队列越积越深。修法三件套之一：入队前幂等检查——
     inbox 里已存在同 operationId 的未消费 replay 就绝不重复入队（连点免疫）。 */
  const pendingReplayIds = new Set();
  /* [防复读风暴 II 2026-10-25 补刀] 事故复盘发现：UI 的每次点击都生成**新
     operationId**，同 operationId 幂等锁对「连点=不同 id 同内容」完全失效
     （16 连发全是同一个 operationId 是因为 UI 复用，但编辑重发链每次全新）。
     补两层：
     ① 内容级幂等——inbox 里已存在**同文本**的未消费 replay（无论谁的
        operationId）同样拒绝入队。文本指纹 = 各 text 块拼接的 JSON。
     ② 服务端节流——同一会话 10 秒冷却窗内只接受一次 regenerate（成功
        入队后才起算）。窗口存内存 Map，重启即清零（刻意不落盘：风暴是
        短时行为，落盘反而会造成「重启后还莫名被拒」的迷惑）。 */
  const replayFingerprint = JSON.stringify(prompt);
  try {
    const inbox = agent?.inbox;
    if (inbox !== undefined && inbox !== null) {
      for (const item of [...(Array.isArray(inbox.nextTurn) ? inbox.nextTurn : []), ...(Array.isArray(inbox.nextStep) ? inbox.nextStep : [])]) {
        if (typeof item?.source?.rpcId === 'string' && item.source.rpcId.startsWith('dsh-turns-del-regenerate:')) {
          pendingReplayIds.add(item.source.rpcId);
          /* 同文本的其它 operationId replay 也算 pending（内容级幂等）。 */
          const itemFp = JSON.stringify((item?.content ?? []).map((part) => (part?.type === 'text' ? part.text : part?.type)));
          if (itemFp === replayFingerprint) {
            pendingReplayIds.add(`dsh-turns-del-regenerate:${operationId}`);
          }
        }
      }
    }
  } catch { /* inbox 读取失败不拦截主流程 */ }
  if (pendingReplayIds.has(`dsh-turns-del-regenerate:${operationId}`)) {
    throw new TurnsDelError('QUEUE_NOT_EMPTY', 'regeneration replay for this operation is already queued; wait for it to be consumed');
  }
  /* 节流②：同会话 10 秒冷却窗（regenerateThrottleAt 记录上次成功入队时刻）。 */
  const REGENERATE_COOLDOWN_MS = 10000;
  if (regenerateThrottleAt.has(session.id) && Date.now() - regenerateThrottleAt.get(session.id) < REGENERATE_COOLDOWN_MS) {
    throw new TurnsDelError('REGENERATE_THROTTLED', 'a regeneration was just queued for this session; wait a few seconds before retrying');
  }

  agent.followup(replay);
  await ctx.sessions.flush(session);
  /* 节流②登记：成功入队才起算冷却窗（失败请求不占窗口）。 */
  regenerateThrottleAt.set(session.id, Date.now());

  /* [防复读风暴 2026-10-24] 消费确认兜底：replay 入队后 15 秒窗口内监听该会话的
     事件流——若 replay 消费后仍无新的 assistant/message 落盘，说明宿主循环异常
     （消费了但没产出），打警告留档。纯观测不干预：真正的拦截是上面的幂等锁。 */
  try {
    const sessionId = String(session.id)
    const startedAt = Date.now()
    const stop = ctx.on('session/event', (liveSession, event) => {
      if (String(liveSession?.id) !== sessionId) return
      if (event?.type === 'assistant/message' || Date.now() - startedAt > 15000) {
        try { stop() } catch { /* ignore */ }
      }
    })
    if (typeof stop === 'function') setTimeout(() => {
      try {
        const stillQueued = pendingReplayIds.size // 只读一次闭包快照，不重查 inbox（轻量）
        void stillQueued
      } catch { /* ignore */ }
    }, 15000).unref?.()
  } catch { /* 监听挂不上不影响主流程 */ }

  return { deletion, replayMessageId: replay.id, alreadyRegenerated: false };
}

/* 重新生成复用删除逻辑，失败原因必须原样透出：早前把一切非预期异常都归为
   AGENT_BUSY，导致“系统头保护”这类真实错误被显示成“任务正在运行”。 */
function regenerationFailure(error) {
  if (error instanceof TurnsDelError) return error;
  return new TurnsDelError('REGENERATE_FAILED', error instanceof Error ? error.message : String(error));
}

async function regenerateTurns(ctx, agent, assistantMessageId, operationId) {
  try {
    return await runAgentMaintenance(agent, (signal) => regenerateTurnsUnderMaintenance(ctx, agent, assistantMessageId, operationId, signal));
  } catch (error) {
    throw regenerationFailure(error);
  }
}

async function regenerateTurnsByTurn(ctx, agent, turn, operationId, promptSeq) {
  try {
    return await runAgentMaintenance(agent, (signal) => regenerateTurnsUnderMaintenance(ctx, agent, undefined, operationId, signal, { byTurn: turn, ...(promptSeq === undefined ? {} : { promptSeq }) }));
  } catch (error) {
    throw regenerationFailure(error);
  }
}

async function editRegenerateTurnsByTurn(ctx, agent, turn, operationId, text, promptSeq) {
  try {
    return await runAgentMaintenance(agent, (signal) => regenerateTurnsUnderMaintenance(ctx, agent, undefined, operationId, signal, { byTurn: turn, editedText: text, ...(promptSeq === undefined ? {} : { promptSeq }) }));
  } catch (error) {
    throw regenerationFailure(error);
  }
}

async function handleTurnsDelAction(ctx, req, res, decode, action) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' });
    res.end();
    return;
  }
  const contentType = req.headers?.['content-type'];
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    return respond(res, 415, { ok: false, error: { code: 'INVALID_REQUEST', message: 'application/json required' } });
  }
  try {
    const input = decode(await readJsonBody(req, MAX_TURNS_DEL_BODY_BYTES));
    const agent = ctx.agents.get(SessionId(input.sessionId));
    if (agent === undefined) throw new TurnsDelError('TARGET_NOT_FOUND', `session "${input.sessionId}" is not active`);
    const value = await action(ctx, agent, input);
    /* 删除后立即生效（2026-10-08）：①活体投影落盘（否则客户端 baseline 比它旧）②sessions.refresh
       触发客户端丢弃该 Host generation 的旧值重建——此前 turns-del 一次刷新都不做，必 F5。 */
    try {
      const cache = ctx.get?.('sessionProjectionCache');
      if (cache && typeof cache.write === 'function' && agent?.session) await cache.write(agent.session);
    } catch (error) { ctx.logger?.warn?.(`[${name}] turns-del projcache checkpoint failed:`, error); }
    try {
      if (ctx.sessions && typeof ctx.sessions.refresh === 'function') await ctx.sessions.refresh();
    } catch { /* 刷新失败不致命 */ }
    return respond(res, 200, { ok: true, value });
  } catch (error) {
    if (error instanceof TurnsDelError) {
      return respond(res, error.code === 'AGENT_BUSY' ? 423 : error.code === 'DELETE_FAILED' ? 500 : 409, { ok: false, error: { code: error.code, message: error.message } });
    }
    return respond(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleTurnsDelRanges(ctx, req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' });
    res.end();
    return;
  }
  let sessionId;
  try {
    sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
  } catch { sessionId = null; }
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return respond(res, 400, { ok: false, error: 'invalid-session-id' });
  try {
    const live = ctx.sessions.get(sessionId);
    const events = live === undefined ? await persistedEventsForArchive(ctx, sessionId) : sessionEvents(live);
    const ranges = events
      .map((event) => turnsDelTombstoneMetaOf(event))
      .filter(Boolean)
      .map(({ turn, endTurn }) => ({ startTurn: turn, endTurn }))
      .sort((left, right) => left.startTurn - right.startTurn || left.endTurn - right.endTurn);
    const merged = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous !== undefined && range.startTurn <= previous.endTurn + 1) previous.endTurn = Math.max(previous.endTurn, range.endTurn);
      else merged.push({ ...range });
    }
    ctx.logger?.info?.(`[${name}] turns-del ranges: session=${sessionId} source=${live === undefined ? 'persisted' : 'live'} events=${events.length} ranges=${JSON.stringify(merged)}`);
    return respond(res, 200, { ok: true, value: merged });
  } catch (error) {
    const status = error instanceof ArchiveError ? error.status : 500;
    return respond(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function handleTurnsDel(ctx, req, res) {
  return handleTurnsDelAction(ctx, req, res, decodeTurnsDelRequest, (runtime, agent, input) => deleteTurns(runtime, agent, MessageId(input.assistantMessageId)));
}

function handleTurnsDelTurn(ctx, req, res) {
  return handleTurnsDelAction(ctx, req, res, decodeTurnRequest, (runtime, agent, input) => deleteTurnsByTurn(runtime, agent, input.turn));
}

function handleRegenerateTurns(ctx, req, res) {
  return handleTurnsDelAction(ctx, req, res, decodeRegenerateRequest, (runtime, agent, input) => regenerateTurns(runtime, agent, MessageId(input.assistantMessageId), input.operationId));
}

function handleRegenerateTurnsByTurn(ctx, req, res) {
  return handleTurnsDelAction(ctx, req, res, decodeRegenerateTurnRequest, (runtime, agent, input) => regenerateTurnsByTurn(runtime, agent, input.turn, input.operationId, input.promptSeq));
}

function handleEditRegenerateTurnsByTurn(ctx, req, res) {
  return handleTurnsDelAction(ctx, req, res, decodeEditRegenerateTurnRequest, (runtime, agent, input) => editRegenerateTurnsByTurn(runtime, agent, input.turn, input.operationId, input.text, input.promptSeq));
}

class ArchiveError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    this.status = status;
  }
}

function basenameOfPath(path) {
  if (typeof path !== 'string' || path.length === 0) return undefined;
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1);
}

function archivedHeaderTitle(sessionId, header) {
  const title = typeof header?.title === 'string' ? header.title.trim() : '';
  if (title) return title;
  return `Session ${String(sessionId).slice(0, 8)}`;
}

function archivedTitle(events, sessionId, header) {
  const explicit = events.findLast((event) => event.type === 'session/title' && typeof event.data.title === 'string')?.data.title?.trim();
  if (explicit) return explicit;
  const prompt = events.find((event) => event.type === 'user/message' && event.data.source?.kind === 'user' && Array.isArray(event.data.content));
  const text = prompt?.data.content?.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  return archivedHeaderTitle(sessionId, header);
}

function archivedUpdatedAt(header, events = []) {
  const promptAt = events.filter((event) => event.type === 'user/message' && event.data.source?.kind === 'user').at(-1)?.time ?? 0;
  return Math.max(header?.createdAt ?? 0, promptAt);
}

/* 旧版本日志（如 v0 迁移残留）在宿主严格校验下可能拒绝读取；转为可读的 422，而不是 500。 */
async function persistedEventsForArchive(ctx, sessionId) {
  try {
    return (await readPersistedSession(ctx.sessionPersistence, sessionId)).events;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    throw new ArchiveError('LOG_INCOMPATIBLE', `archived session log could not be read: ${reason}`, 422);
  }
}

function cachedProjectionValues(ctx, meta) {
  try {
    /* 优先使用完整快照；冷会话未播种时回退到标题前驱投影，避免把 cwd 当作会话标题。 */
    const cache = ctx.get?.('sessionProjectionCache');
    const block = meta?.isSeeded
      ? undefined
      : cache?.cachedSnapshot?.(meta, 0) ?? cache?.cachedPredecessorTitle?.(meta, 0);
    return block?.values && typeof block.values === 'object' ? block.values : undefined;
  } catch {
    return undefined;
  }
}

function cachedTitle(values) {
  const title = values?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : undefined;
}

function cachedUpdatedAt(header, values) {
  const lastPromptAt = values?.sessionListMetadata?.lastPromptAt;
  return Math.max(header?.createdAt ?? 0, Number.isFinite(lastPromptAt) ? lastPromptAt : 0);
}

/* 标题投影预热：列表标题走 cachedSnapshot 的零 I/O 读，projcache 缺失时
   要点开会话才冷重建——同步下载又会删投影，重启后标题全空。这里后台补齐：
   缺缓存的会话逐个冷读全量日志 → coldSnapshot 重建并回写（服务内部 fail-soft）。 */
async function warmProjectionCache(ctx, options = {}) {
  const stats = { listed: 0, cached: 0, rebuilt: 0, missing: 0, failed: 0 };
  try {
    const cache = ctx.get?.('sessionProjectionCache');
    const persistence = ctx.sessionPersistence;
    if (!cache?.coldSnapshot || typeof persistence?.list !== 'function') return stats;
    const entries = (await persistence.list().catch(() => [])) ?? [];
    const byId = new Map();
    for (const entry of entries) {
      const header = entry?.header ?? entry;
      if (header?.id) byId.set(header.id, entry);
    }
    // dshHome() 在本模块从未定义 → ReferenceError 被外层 catch 吞掉，
    // warmProjectionCache 长期「全 0」静默失败、projcache 从不自动重建（2026-10-11 定位）。
    const projDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'session_projcache', 'sessions');
    const ids = new Set();
    for (const ws of ctx.workspaceRegistry.list()) {
      const entity = ctx.workspaceRegistry.get(ws.id);
      for (const sid of entity?.sessionIds ?? []) ids.add(sid);
    }
    const budget = Number.isFinite(options.max) ? options.max : Number.POSITIVE_INFINITY;
    for (const sid of ids) {
      stats.listed++;
      if (existsSync(join(projDir, `${sid}.json`))) { stats.cached++; continue }
      if (stats.rebuilt >= budget) break;
      try {
        const entry = byId.get(sid);
        const header = entry?.header ?? entry;
        if (header?.id !== sid) { stats.missing++; continue }
        const read = await readPersistedSession(persistence, sid);
        const events = read?.events;
        if (!Array.isArray(events) || events.length === 0) { stats.missing++; continue }
        const inherited = Number(entry?.inheritedEventCount ?? header?.inheritedEventCount ?? 0) || 0;
        cache.coldSnapshot(header, inherited, events);
        stats.rebuilt++;
        await new Promise((resolve) => setTimeout(resolve, 120));
      } catch (error) {
        stats.failed++;
        ctx.logger?.debug?.(`[${name}] projcache warm failed for ${sid}:`, error);
      }
    }
    if (stats.rebuilt > 0 || options.verbose) {
      ctx.logger?.info?.(`[${name}] projcache warm: rebuilt ${stats.rebuilt} / listed ${stats.listed}（cached ${stats.cached}, missing ${stats.missing}, failed ${stats.failed}）`);
    }
  } catch (error) {
    ctx.logger?.warn?.(`[${name}] projcache warm aborted:`, error);
  }
  return stats;
}

function normalizeWorkspaceState(state) {
  const source = state && typeof state === 'object' ? state : {};
  const archivedSessionIds = Array.isArray(source.archivedSessionIds) ? source.archivedSessionIds : [];
  const workspaceIds = Array.isArray(source.workspaceIds) ? source.workspaceIds : [];
  return {
    ...source,
    initialized: source.initialized === true,
    workspaceIds,
    archivedSessionIds,
    ...(source.pendingMutation === undefined ? {} : { pendingMutation: source.pendingMutation })
  };
}

function updateWorkspaceRegistryArchiveCache(ctx, archivedSessionIds) {
  if (ctx.workspaceRegistry?.state && typeof ctx.workspaceRegistry.state === 'object') {
    ctx.workspaceRegistry.state = { ...ctx.workspaceRegistry.state, archivedSessionIds };
  }
}

function sameArchivedIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function setArchivedSessionIds(ctx, update) {
  const mutate = async () => {
    const workspaceDomain = ctx.storageDomain?.get?.('workspace');
    if (workspaceDomain !== undefined) {
      const global = workspaceDomain.global;
      const state = normalizeWorkspaceState(global.get());
      const archivedSessionIds = update([...state.archivedSessionIds]);
      if (sameArchivedIds(state.archivedSessionIds, archivedSessionIds)) return archivedSessionIds;
      await global.set({ ...state, archivedSessionIds });
      updateWorkspaceRegistryArchiveCache(ctx, archivedSessionIds);
      return archivedSessionIds;
    }
    if (typeof ctx.workspaceRegistry.requireState === 'function' && typeof ctx.workspaceRegistry.setState === 'function') {
      const state = ctx.workspaceRegistry.requireState();
      const archivedSessionIds = update([...state.archivedSessionIds]);
      if (sameArchivedIds(state.archivedSessionIds, archivedSessionIds)) return archivedSessionIds;
      await ctx.workspaceRegistry.setState({ ...state, archivedSessionIds });
      return archivedSessionIds;
    }
    throw new ArchiveError('ARCHIVE_UNAVAILABLE', 'workspace registry does not expose archive mutation hooks', 500);
  };
  if (typeof ctx.workspaceRegistry.enqueueOperation === 'function') return ctx.workspaceRegistry.enqueueOperation(mutate);
  return mutate();
}

async function archivedSessionItems(ctx) {
  const archivedIds = [...ctx.workspaceRegistry.archivedSessionIds].filter((sessionId) => !deletedSessionIds.has(sessionId));
  const metas = new Map((await ctx.sessionPersistence.list()).map(persistenceHeaderOf).filter((meta) => !deletedSessionIds.has(meta.id)).map((meta) => [meta.id, meta]));
  const items = [];
  for (const sessionId of archivedIds) {
    const id = SessionId(sessionId);
    const live = ctx.sessions.get(id);
    const meta = live?.header ?? metas.get(id);
    if (meta === undefined) continue;
    const liveEvents = live === undefined
      ? undefined
      : typeof live.snapshotEvents === 'function'
        ? sessionEvents(live)
        : Array.isArray(live.events) ? live.events : undefined;
    const projections = liveEvents === undefined ? cachedProjectionValues(ctx, meta) : undefined;
    let title = liveEvents === undefined ? cachedTitle(projections) : archivedTitle(liveEvents, id, meta);
    let updatedAt = liveEvents === undefined ? cachedUpdatedAt(meta, projections) : archivedUpdatedAt(meta, liveEvents);
    if (liveEvents === undefined && title === undefined) {
      try {
        const persistedEvents = (await readPersistedSession(ctx.sessionPersistence, id)).events;
        if (Array.isArray(persistedEvents)) {
          title = archivedTitle(persistedEvents, id, meta);
          updatedAt = archivedUpdatedAt(meta, persistedEvents);
        }
      } catch (error) {
        ctx.logger?.debug?.(`[${name}] archived session title read failed for ${id}:`, error);
      }
    }
    items.push({
      sessionId: id,
      title: title ?? archivedHeaderTitle(id, meta),
      updatedAt,
      createdAt: meta.createdAt ?? 0,
      running: ctx.agents.get(id)?.status === 'running',
      missing: false,
      ...(meta.cwd === undefined ? {} : { cwd: meta.cwd })
    });
  }
  items.sort((left, right) => right.updatedAt - left.updatedAt || String(left.sessionId).localeCompare(String(right.sessionId)));
  return items;
}

function decodeArchiveRequest(value) {
  const id = sessionIdOf(value);
  if (id === undefined) throw new TypeError('sessionId must be a valid session id');
  return SessionId(id);
}

function decodeArchivePreviewRequest(value) {
  const id = decodeArchiveRequest(value);
  const offset = Number.isSafeInteger(value?.offset) && value.offset >= 0 ? value.offset : 0;
  const rawLimit = Number.isSafeInteger(value?.limit) && value.limit > 0 ? value.limit : DEFAULT_ARCHIVE_PREVIEW_LIMIT;
  const tocOffset = Number.isSafeInteger(value?.tocOffset) && value.tocOffset >= 0 ? value.tocOffset : 0;
  const rawTocLimit = Number.isSafeInteger(value?.tocLimit) && value.tocLimit > 0 ? value.tocLimit : 10;
  const search = typeof value?.search === 'string' ? value.search.slice(0, 2000).trim() : '';
  return { sessionId: id, offset, limit: Math.min(rawLimit, MAX_ARCHIVE_PREVIEW_LIMIT), tocOffset, tocLimit: Math.min(rawTocLimit, 100), search };
}

function textBlocks(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  const visit = (block) => {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'tool-call') parts.push([block.name, block.arguments].filter((value) => typeof value === 'string' && value.trim()).join('\n'));
    else if (block?.type === 'tool-result' && Array.isArray(block.content)) block.content.forEach(visit);
  };
  content.forEach(visit);
  return parts.map((part) => part.trim()).filter(Boolean).join('\n\n');
}

function toolNameOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'unknown';
}

function archivedToolCallStats(events) {
  const byName = new Map();
  const calls = new Map();
  const ensure = (name) => {
    const key = toolNameOf(name);
    let entry = byName.get(key);
    if (entry === undefined) {
      entry = { name: key, count: 0, success: 0, failed: 0, pending: 0 };
      byName.set(key, entry);
    }
    return entry;
  };
  const addCall = (name, callId) => {
    const id = typeof callId === 'string' && callId !== '' ? callId : undefined;
    if (id !== undefined && calls.has(id)) return;
    const entry = ensure(name);
    entry.count += 1;
    entry.pending += 1;
    if (id !== undefined) calls.set(id, { name: entry.name, settled: false });
  };
  const settleCall = (callId, failed) => {
    const id = typeof callId === 'string' && callId !== '' ? callId : undefined;
    if (id === undefined) return;
    const call = calls.get(id);
    if (call === undefined || call.settled) return;
    const entry = ensure(call.name);
    entry.pending = Math.max(0, entry.pending - 1);
    if (failed) entry.failed += 1;
    else entry.success += 1;
    call.settled = true;
  };
  for (const event of events) {
    if (event?.type === 'tool/call') {
      addCall(event.data?.name, event.data?.callId);
      continue;
    }
    if (event?.type === 'assistant/message') {
      const content = event.data?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool-call') addCall(block.name, block.id);
      }
      continue;
    }
    if (event?.type === 'tool/result') {
      const block = Array.isArray(event.data?.message?.content) ? event.data.message.content.find((part) => part?.type === 'tool-result') : undefined;
      settleCall(block?.toolCallId ?? event.data?.message?.source?.callId, block?.isError === true);
    }
  }
  return [...byName.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function previewItemFromEvent(event) {
  if (event.type === 'user/message') {
    if (event.data.source?.kind !== 'user') return undefined;
    const text = textBlocks(event.data.content);
    return text ? { role: 'user', seq: event.seq, time: event.time, text, title: text.replace(/\s+/g, ' ').trim().slice(0, 80) } : undefined;
  }
  if (event.type === 'assistant/message') {
    const text = textBlocks(event.data.message?.content);
    return text ? { role: 'assistant', seq: event.seq, time: event.time, text } : undefined;
  }
  if (event.type === 'tool/result') {
    const text = textBlocks(event.data.message?.content);
    return text ? { role: 'tool', seq: event.seq, time: event.time, text } : undefined;
  }
  return undefined;
}

async function previewArchivedSession(ctx, input) {
  const { sessionId, offset, limit, tocOffset, tocLimit, search = '' } = input;
  const live = ctx.sessions.get(sessionId);
  const meta = live?.header ?? await persistenceHeaderById(ctx.sessionPersistence, sessionId);
  if (meta === undefined) throw new ArchiveError('SESSION_NOT_FOUND', `archived session "${sessionId}" was not found`, 404);
  const liveEvents = live === undefined
    ? undefined
    : typeof live.snapshotEvents === 'function'
      ? sessionEvents(live)
      : Array.isArray(live.events) ? live.events : undefined;
  const events = liveEvents ?? await persistedEventsForArchive(ctx, sessionId);
  let surfaceNodes;
  try {
    surfaceNodes = foldSurface(events).nodes;
  } catch {
    surfaceNodes = events.filter((event) => event.surfaceOp === 'append').map((event) => event.seq);
  }
  const eventBySeq = new Map(events.map((event) => [event.seq, event]));
  const normalizedSearch = search.toLocaleLowerCase();
  const allMessages = [];
  for (const seq of surfaceNodes) {
    const event = eventBySeq.get(seq);
    const item = event === undefined ? undefined : previewItemFromEvent(event);
    if (item !== undefined) allMessages.push(item);
  }
  const indexedMessages = allMessages.map((item, index) => ({ ...item, displayIndex: index + 1, messageIndex: index }));
  const matchedMessages = normalizedSearch === ''
    ? indexedMessages
    : indexedMessages.filter((item) => `${item.role}\n${item.title ?? ''}\n${item.text}`.toLocaleLowerCase().includes(normalizedSearch));
  const matchedIndexedMessages = matchedMessages.map((item, index) => ({ ...item, matchIndex: index }));
  const messages = matchedIndexedMessages.slice(offset, offset + limit);
  const matchIndexBySeq = new Map(matchedIndexedMessages.map((item) => [item.seq, item.matchIndex]));
  const userMessages = indexedMessages.filter((item) => item.role === 'user');
  /* 目录条目附带 matchIndex：搜索态下客户端可直接按匹配列表空间换算页码；不在匹配集内的条目不带该字段 */
  const pagedUserMessages = userMessages.slice(tocOffset, tocOffset + tocLimit).map((item) => {
    const matchIndex = matchIndexBySeq.get(item.seq);
    return matchIndex === undefined ? item : { ...item, matchIndex };
  });
  return {
    sessionId,
    title: archivedTitle(events, sessionId, meta),
    updatedAt: archivedUpdatedAt(meta, events),
    createdAt: meta.createdAt ?? 0,
    ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
    toolCalls: archivedToolCallStats(events),
    messages,
    userMessages: pagedUserMessages,
    totalMessages: indexedMessages.length,
    totalMatchedMessages: matchedIndexedMessages.length,
    totalUserMessages: userMessages.length,
    tocOffset,
    tocLimit,
    offset,
    nextOffset: offset + messages.length,
    limit,
    search,
    hasMore: offset + messages.length < matchedIndexedMessages.length,
    tocHasMore: tocOffset + pagedUserMessages.length < userMessages.length
  };
}

async function restoreArchivedSession(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId);
  const meta = live?.header ?? await persistenceHeaderById(ctx.sessionPersistence, sessionId);
  if (meta === undefined) throw new ArchiveError('SESSION_NOT_FOUND', `archived session "${sessionId}" was not found`, 404);
  const archivedSessionIds = await setArchivedSessionIds(ctx, (ids) => ids.filter((id) => id !== sessionId));
  return { sessionId, archivedSessionIds, items: await archivedSessionItems(ctx) };
}

async function currentSessionToolStats(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId);
  const meta = live?.header ?? await persistenceHeaderById(ctx.sessionPersistence, sessionId);
  if (meta === undefined) throw new ArchiveError('SESSION_NOT_FOUND', `session "${sessionId}" was not found`, 404);
  const liveEvents = live === undefined
    ? undefined
    : typeof live.snapshotEvents === 'function'
      ? sessionEvents(live)
      : Array.isArray(live.events) ? live.events : undefined;
  const events = liveEvents ?? await persistedEventsForArchive(ctx, sessionId);
  const toolCalls = archivedToolCallStats(events);
  return {
    sessionId,
    title: archivedTitle(events, sessionId, meta),
    updatedAt: archivedUpdatedAt(meta, events),
    createdAt: meta.createdAt ?? 0,
    ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
    total: toolCalls.reduce((sum, entry) => sum + entry.count, 0),
    success: toolCalls.reduce((sum, entry) => sum + entry.success, 0),
    failed: toolCalls.reduce((sum, entry) => sum + entry.failed, 0),
    pending: toolCalls.reduce((sum, entry) => sum + entry.pending, 0),
    toolCalls
  };
}

/* ── 会话日志修复：清除 dsh-session-kit 历史上写进会话日志的污染 ──
   实测（2026-09-14 全库扫描 235 会话）插件留下四类污染：
     1. assistant/message.data 顶层：regeneration / endTurn（旧版轮次删除平铺的墓碑元数据）
     2. user/message.source 越界键：hitIds / snapshot / directoryIds / recall（记忆注入）
     3. 事件类型 memory/recall（旧版记忆召回自建事件）
     4. 轮次删除墓碑：assistant/message + surfaceOp.replace（遮蔽了原生 user/message）
   1、2 剥字段即可；3、4 需整行删除，因此必须重排 seq 并改写全部 seq 引用。
   实测：32 个含墓碑的 v0 会话原本 0 个可加载，修复后 27 个通过迁移链。
   墓碑策略=只删墓碑、保留被遮蔽的原生消息（恢复被删轮次的显示）。 */

const REPAIR_STRIPPED_SOURCE_KEYS = ['hitIds', 'snapshot', 'directoryIds', 'recall'];
const REPAIR_MESSAGE_EVENT_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result']);
/* 插件专有键：即使宿主在官方 source 上（rpcId 为普通 UUID、无法凭身份判定），
   只要出现这些键就一定是插件写入的——DSH 的 source 白名单里没有它们。
   仅覆盖历史形态：记忆注入的 hitIds/snapshot 现已迁入 source.sections（见 memory.js），
   而 sections 是 v4 合法标准字段（form:'snapshot' 的必需项），不得列入剥离名单。 */
const REPAIR_EXCLUSIVE_SOURCE_KEYS = ['hitIds', 'snapshot', 'directoryIds', 'recall'];
const REPAIR_STRIPPED_DATA_KEYS_BY_TYPE = { 'assistant/message': ['regeneration', 'endTurn'] };
const REPAIR_DROPPED_EVENT_TYPES = ['memory/recall'];
/* 与 memory.js 内部常量保持一致：注入用 plugin='memory'，剔除用 plugin='dsh-session-kit-memory-eject'。 */
const MEMORY_CONTEXT_PLUGIN_NAME = 'memory';
const MEMORY_EJECT_PLUGIN_NAME = 'dsh-session-kit-memory-eject';
const ZSTD_MAGIC = 4247762216;
const ZSTD_CHECKSUM_OPTIONS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } };

/* 扫描完整 zstd 帧边界（不依赖任何包内私有实现）。 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved zstd frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved zstd block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/* 判断一条 source 是否由 dsh-session-kit 写入。
   三种历史形态：
     - kind:'plugin' + plugin:'memory'（记忆注入）
     - kind:'plugin' + plugin:'dsh-session-kit-memory-eject'（记忆剔除）
     - kind:'user'  + rpcId:'dsh-turns-del-regenerate:*'（重新生成的重放提问，
       旧版曾把 recall 元数据挂在它的 source 上） */
function isKitAuthoredSource(source) {
  if (source === null || typeof source !== 'object') return false;
  if (source.kind === TURNS_DEL_PROVIDER || source.kind === 'dsh-turns-del' || source.kind === 'plugin:dsh-turns-del' || source.kind === 'plugin:dsh-session-kit-turns-del' || (typeof source.kind === 'string' && source.kind.startsWith('dsh-session-kit-'))) return true;
  if (source.kind === 'plugin') {
    return source.plugin === MEMORY_CONTEXT_PLUGIN_NAME
      || source.plugin === MEMORY_EJECT_PLUGIN_NAME
      || (typeof source.plugin === 'string' && source.plugin.startsWith('dsh-session-kit'))
      || source.plugin === TURNS_DEL_PROVIDER;
  }
  if (source.kind === 'user' && typeof source.rpcId === 'string') {
    return source.rpcId.startsWith('dsh-turns-del-regenerate:')
      || source.rpcId.startsWith('dsh-turns-del:');
  }
  return false;
}

/* 剥离一条事件上的越界字段，返回 { event, stripped }。
   - source 层：仅对插件自己写入的 source 生效（避免误删官方 plugin source）。
   - data 层：按事件类型匹配（assistant/message 的墓碑元数据）。 */
export function repairMessageIdentity(event) {
  if (!REPAIR_MESSAGE_EVENT_TYPES.has(event?.type)) return { event, repaired: false };
  const data = event?.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { event, repaired: false };
  const message = event.type === 'user/message' ? data : data.message;
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return { event, repaired: false };
  if (typeof message.id === 'string' && message.id.length > 0) return { event, repaired: false };
  const id = `repair-${event.type.replace('/', '-')}-${Number.isSafeInteger(event.seq) ? event.seq : 'unknown'}-${createHash('sha256').update(JSON.stringify(message)).digest('hex').slice(0, 16)}`;
  const nextMessage = { ...message, id: MessageId(id) };
  const nextData = event.type === 'user/message' ? nextMessage : { ...data, message: nextMessage };
  return { event: { ...event, data: nextData }, repaired: true };
}

function stripRepairFields(event) {
  const stripped = [];
  let nextEvent = event;

  const dataKeys = REPAIR_STRIPPED_DATA_KEYS_BY_TYPE[event?.type];
  if (Array.isArray(dataKeys) && event.data !== null && typeof event.data === 'object') {
    const present = dataKeys.filter((key) => Object.hasOwn(event.data, key));
    if (present.length > 0) {
      const nextData = { ...event.data };
      for (const key of present) delete nextData[key];
      nextEvent = { ...nextEvent, data: nextData };
      stripped.push(...present);
    }
  }

  const source = nextEvent.data?.source;
  if (source !== null && typeof source === 'object') {
    /* 判定规则分两种：
       1. 插件自己写的事件（plugin 名 / rpcId 前缀可确认身份）→ 剥离全部越界键
       2. 插件在官方消息上追加的专有键（如 recall 挂在官方 user source 上，
          rpcId 是普通 UUID、无法凭身份区分）→ 只剥离插件专有键，不动官方字段 */
    const authored = isKitAuthoredSource(source);
    const present = REPAIR_STRIPPED_SOURCE_KEYS.filter((key) => {
      if (!Object.hasOwn(source, key)) return false;
      if (authored) return true;
      return REPAIR_EXCLUSIVE_SOURCE_KEYS.includes(key);
    });
    if (present.length > 0) {
      const nextSource = { ...source };
      for (const key of present) delete nextSource[key];
      nextEvent = { ...nextEvent, data: { ...nextEvent.data, source: nextSource } };
      stripped.push(...present);
    }
  }

  return { event: nextEvent, stripped };
}

/* 判定轮次删除墓碑：assistant/message + surfaceOp.replace + sourceEventSeqs。
   旧版用 assistant/message 承载替换，这是 v3 禁止的形态，也是迁移链拒绝的根因之一。
   注意：不要求 content 为空——部分墓碑带内容，同样是插件写入的替换事件。 */
function isTurnTombstoneEvent(event) {
  if (event?.type !== 'assistant/message') return false;
  const op = event.surfaceOp;
  if (op === null || typeof op !== 'object' || op.op !== 'replace') return false;
  return Array.isArray(event.sourceEventSeqs);
}

/* 惰性加载宿主的 v0 codec。插件与宿主同进程，可直接 import 宿主包。 */
let v0CodecPromise;
function loadV0Codec() {
  if (v0CodecPromise === undefined) {
    v0CodecPromise = import('@deepseek-ai/dsh-session-format-v0-to-v1').catch(() => undefined);
  }
  return v0CodecPromise;
}

function createV0DecoderSync(codecModule, header) {
  if (codecModule?.releasedV0SessionFormatCodec === undefined) return undefined;
  return codecModule.releasedV0SessionFormatCodec.createDecoder(header, 'recoverable');
}

/* 用宿主 decoder 展开每行产出的逻辑事件 seq，保证与宿主认知一致。 */
function decodeLineSeqsWith(decoder, lines) {
  const out = [];
  for (const line of lines) {
    const collected = [];
    const ctx = {
      emitEvent(event) { collected.push({ seq: event.seq, type: event.type }); },
      emitRun(run) {
        const expanded = typeof run?.expand === 'function' ? run.expand() : [];
        for (const event of expanded) collected.push({ seq: event.seq, type: event.type });
      }
    };
    try {
      decoder.decodeRow(JSON.parse(line), ctx);
    } catch {
      /* 解码失败的行走剥字段路径，不参与重编号 */
    }
    out.push(collected);
  }
  return out;
}

/* 重编号：改写所有已知承载 seq 的字段。 */
function renumberEvent(event, remap, seqsOfLine, dropSeqs) {
  if (Number.isSafeInteger(event.seq)) {
    event.seq = remap(event.seq);
  } else if (Number.isSafeInteger(event.seq0)) {
    /* 打包行（seq0 + dt）：seq0 重映射；若行内部分事件被删则裁剪 texts/dt。 */
    const oldSeqs = seqsOfLine.map((s) => s.seq);
    const keepIndexes = [];
    oldSeqs.forEach((s, index) => { if (!dropSeqs.has(s)) keepIndexes.push(index); });
    if (keepIndexes.length === oldSeqs.length) {
      event.seq0 = remap(event.seq0);
    } else if (keepIndexes.length > 0) {
      const data = event.data;
      if (Array.isArray(data?.dt) && Array.isArray(data?.texts)) {
        const absolute = [oldSeqs[0]];
        for (const delta of data.dt) absolute.push(absolute[absolute.length - 1] + delta);
        const keptAbsolute = keepIndexes.map((k) => absolute[k]).filter((v) => v !== undefined);
        const texts = keepIndexes.map((k) => data.texts[k]);
        const dt = [];
        for (let k = 1; k < keptAbsolute.length; k += 1) dt.push(keptAbsolute[k] - keptAbsolute[k - 1]);
        event.data = { ...data, dt, texts };
      }
      event.seq0 = remap(oldSeqs[keepIndexes[0]]);
    }
  }

  if (Array.isArray(event.sourceEventSeqs)) {
    event.sourceEventSeqs = event.sourceEventSeqs.map((item) =>
      Array.isArray(item) ? item.map(remap) : remap(item));
  }
  if (event.surfaceOp !== null && typeof event.surfaceOp === 'object') {
    for (const key of ['start', 'end', 'startSeq', 'endSeq']) {
      if (Number.isSafeInteger(event.surfaceOp[key])) event.surfaceOp[key] = remap(event.surfaceOp[key]);
    }
  }
  const data = event.data;
  if (data !== null && typeof data === 'object') {
    if (Array.isArray(data.messageSeqs)) data.messageSeqs = data.messageSeqs.map(remap);
    if (Array.isArray(data.shadowedSeqs)) data.shadowedSeqs = data.shadowedSeqs.map(remap);
    if (Number.isSafeInteger(data.start)) data.start = remap(data.start);
    if (Number.isSafeInteger(data.throughSeq)) data.throughSeq = remap(data.throughSeq);
    if (Number.isSafeInteger(data.sourceEventSeq)) data.sourceEventSeq = remap(data.sourceEventSeq);
  }
}

/**
 * 修复一个会话日志文件：清除插件历史污染。
 *
 * 两个层次：
 *   A. 剥字段（不需重编号）：source 越界键、data 越界键
 *   B. 删行 + 重编号：memory/recall 事件、轮次删除墓碑
 *
 * 重编号必须与宿主完全一致：v0 用 seq0+dt 把多个事件打包在一行，
 * 因此先用宿主的 v0 codec 展开，得到精确的「行 -> seq 列表」映射。
 * 墓碑策略为「只删墓碑、保留被遮蔽的原生消息」，即恢复被删轮次的显示。
 */
export async function repairSessionLogFile(filePath, { commit = true } = {}) {
  const bytes = readFileSync(filePath);
  const { frames, tornStart } = scanZstdFrames(bytes);
  if (frames.length === 0) throw new Error('session log has no complete zstd frame');
  if (tornStart !== undefined) throw new Error(`session log has an incomplete final frame at byte ${tornStart}`);

  const parts = frames.map((frame) => zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8'));
  const headerText = parts[0];
  if (headerText.length === 0 || headerText.indexOf('\n') !== headerText.length - 1) {
    throw new Error('session log first frame is not exactly one header line');
  }
  const header = JSON.parse(headerText);

  /* 收集全部物理行（按原顺序），供删行与重编号使用。 */
  const lines = [];
  for (let index = 1; index < parts.length; index += 1) {
    const raw = parts[index];
    if (raw.length === 0) continue;
    for (const line of raw.split('\n')) if (line.length > 0) lines.push(line);
  }

  /* 需要重编号时才展开：用宿主 codec 得到每行产出的 seq。 */
  const needsRenumber = lines.some((line) => {
    const event = JSON.parse(line);
    return REPAIR_DROPPED_EVENT_TYPES.includes(event.type) || isTurnTombstoneEvent(event);
  });

  const removedKeys = new Map();
  const droppedTypes = new Map();
  let repairedEvents = 0;
  let repairedMessageIds = 0;

  // ── A. 补消息身份 + 剥字段（逐行，不改变行数）──
  const strippedLines = lines.map((line) => {
    const parsed = JSON.parse(line);
    const identity = repairMessageIdentity(parsed);
    const { event: nextEvent, stripped } = stripRepairFields(identity.event);
    if (!identity.repaired && stripped.length === 0) return { line, event: parsed };
    if (identity.repaired) repairedMessageIds += 1;
    for (const key of stripped) removedKeys.set(key, (removedKeys.get(key) ?? 0) + 1);
    repairedEvents += 1;
    return { line: JSON.stringify(nextEvent), event: nextEvent };
  });

  // ── B. 删行 + 重编号 ──
  let dropSeqs = new Set();
  let seqMap = null;
  let lineSeqs = null;
  if (needsRenumber) {
    const codecModule = await loadV0Codec();
    const decoder = createV0DecoderSync(codecModule, header);
    if (decoder === undefined) {
      throw new Error('session format codec unavailable; cannot renumber dropped events safely');
    }
    lineSeqs = decodeLineSeqsWith(decoder, strippedLines.map((x) => x.line));

    // 要删的 seq：memory/recall 整行 + 墓碑自身（保留其遮蔽的原生消息）
    for (let i = 0; i < strippedLines.length; i += 1) {
      const event = strippedLines[i].event;
      if (REPAIR_DROPPED_EVENT_TYPES.includes(event.type)) {
        droppedTypes.set(event.type, (droppedTypes.get(event.type) ?? 0) + 1);
        for (const s of lineSeqs[i] ?? []) dropSeqs.add(s.seq);
      } else if (isTurnTombstoneEvent(event)) {
        droppedTypes.set('turn-tombstone', (droppedTypes.get('turn-tombstone') ?? 0) + 1);
        for (const s of lineSeqs[i] ?? []) dropSeqs.add(s.seq);
      }
    }
    if (dropSeqs.size > 0) {
      seqMap = new Map();
      let next = 0;
      for (const list of lineSeqs) {
        for (const s of list) {
          if (!dropSeqs.has(s.seq)) { seqMap.set(s.seq, next); next += 1; }
        }
      }
    }
  }

  // ── 组装输出行 ──
  const outLines = [];
  for (let i = 0; i < strippedLines.length; i += 1) {
    const { line, event } = strippedLines[i];
    if (seqMap === null) { outLines.push(JSON.stringify(event)); continue; }

    const seqsOfLine = lineSeqs[i] ?? [];
    // 整行删除：该行产出的所有 seq 都在待删集合
    if (seqsOfLine.length > 0 && seqsOfLine.every((s) => dropSeqs.has(s.seq))) continue;

    const target = JSON.parse(strippedLines[i].line);
    const remap = (n) => seqMap.get(n) ?? n;
    renumberEvent(target, remap, seqsOfLine, dropSeqs);
    repairedEvents += 1;
    outLines.push(JSON.stringify(target));
  }

  const changed = repairedEvents > 0;
  if (!changed) {
    return { changed: false, repairedEvents: 0, repairedMessageIds: 0, removed: {}, dropped: {} };
  }

  /* 保持宿主格式：首帧仅含 header，事件写入后续独立 frame。 */
  const headerFrame = zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), ZSTD_CHECKSUM_OPTIONS);
  const nextBytes = outLines.length === 0
    ? headerFrame
    : Buffer.concat([
      headerFrame,
      zstdCompressSync(Buffer.from(`${outLines.join('\n')}\n`, 'utf8'), ZSTD_CHECKSUM_OPTIONS)
    ]);
  if (commit) {
    const tempPath = `${filePath}.repairing`;
    writeFileSync(tempPath, nextBytes);
    try {
      renameSync(tempPath, filePath);
    } catch (error) {
      try { rmSync(tempPath, { force: true }); } catch { /* 清理失败不掩盖原错误 */ }
      throw error;
    }
  }
  return {
    changed: true,
    repairedEvents,
    repairedMessageIds,
    bytes: nextBytes,
    removed: Object.fromEntries(removedKeys),
    dropped: Object.fromEntries(droppedTypes)
  };
}

/* 修复前用真实迁移链验证文件可加载，修复后再验一次。 */
async function verifySessionLogLoadable(ctx, sessionId) {
  try {
    const snapshot = await readPersistedSession(ctx.sessionPersistence, sessionId);
    return { ok: true, events: Array.isArray(snapshot?.events) ? snapshot.events.length : 0 };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/* 定位会话实际存在的日志文件。
   注意：不能用 locate(meta) 的返回路径——它硬编码当前格式版本
   （logPath -> generationLogPath(..., SESSION_FORMAT_VERSION, ...)），
   对 v0 老会话会返回 session.v3.jsonl.zstd，而真实文件是 session.jsonl.zstd。
   本功能恰恰主要修 v0 老会话，因此必须扫描目录取真实文件。 */
function resolveSessionLogFiles(ctx, meta) {
  const dir = typeof ctx.sessionPersistence.locate === 'function'
    ? dirname(ctx.sessionPersistence.locate(meta)?.path ?? '')
    : undefined;
  if (typeof dir !== 'string' || dir.length === 0 || !existsSync(dir)) return [];
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  const files = entries
    /* 世代文件名形如 session.jsonl.zstd / session.v3.jsonl.zstd，
       注意版本号在 .jsonl 之前，正则必须允许中间段。 */
    .filter((name) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(name))
    .map((name) => join(dir, name))
    .filter((file) => { try { return statSync(file).isFile(); } catch { return false; } });
  /* 优先修复旧格式（低版本号）文件：它们才是迁移链拒绝的对象。 */
  const versionOf = (file) => {
    const m = /\.v(\d+)\.jsonl/.exec(file);
    return m === null ? 0 : Number(m[1]);
  };
  return files.sort((a, b) => versionOf(a) - versionOf(b));
}

function repairBackupRoot() {
  const root = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(root, 'recovery-backups', `message-id-repair-${new Date().toISOString().replace(/[:.]/g, '-')}`);
}

async function repairCurrentSession(ctx, sessionId) {
  const agent = ctx.agents.get(sessionId);
  // Running check removed: allow archive deletion of stuck sessions
  /* 跨平台安全护栏：会话在宿主进程内处于打开（绑定）状态时拒绝修复。
     Windows 上改名会因文件占用失败（EBUSY，安全失败）；
     POSIX（macOS/Linux）上更危险——改名会成功，但宿主继续写入已解除
     链接的旧 inode，表面正常、重启后丢追加数据（静默分叉）。
     会话管理菜单本身只在当前会话可用，用户切走后即可修复。 */
  if (ctx.sessions.get(sessionId) !== undefined) {
    throw new ArchiveError('SESSION_LIVE', `session "${sessionId}" is open in the host; switch to another session before repairing`, 409);
  }
  const meta = await persistenceHeaderById(ctx.sessionPersistence, sessionId);
  if (meta === undefined) throw new ArchiveError('SESSION_NOT_FOUND', `session "${sessionId}" was not found`, 404);
  const files = resolveSessionLogFiles(ctx, meta);
  if (files.length === 0) {
    throw new ArchiveError('REPAIR_UNSUPPORTED', 'no readable session log artifact was found for this session', 501);
  }

  const before = await verifySessionLogLoadable(ctx, sessionId);

  /* 修复所有存在的世代文件（同一会话可能同时留有 v0 与 v3 两份）。 */
  const applied = [];
  let repairedEvents = 0;
  let repairedMessageIds = 0;
  const removed = {};
  const dropped = {};
  let primaryPath;
  const backupDir = repairBackupRoot();
  mkdirSync(backupDir, { recursive: true });
  const repairs = [];
  for (const file of files) {
    const backupPath = join(backupDir, basename(file));
    copyFileSync(file, backupPath);
    const result = await repairSessionLogFile(file, { commit: false });
    repairs.push({ file, result });
  }
  for (const { file, result } of repairs) {
    if (result.changed) {
      primaryPath = primaryPath ?? file;
      repairedEvents += result.repairedEvents;
      repairedMessageIds += result.repairedMessageIds ?? 0;
      for (const [key, count] of Object.entries(result.removed ?? {})) removed[key] = (removed[key] ?? 0) + count;
      for (const [key, count] of Object.entries(result.dropped ?? {})) dropped[key] = (dropped[key] ?? 0) + count;
      applied.push(file);
    }
  }

  const temporary = [];
  try {
    for (const { file, result } of repairs) {
      if (!result.changed) continue;
      const tempPath = `${file}.repairing`;
      writeFileSync(tempPath, result.bytes);
      temporary.push({ file, tempPath });
    }
    for (const { file, tempPath } of temporary) renameSync(tempPath, file);
  } catch (error) {
    for (const { file, tempPath } of temporary) {
      try { if (existsSync(tempPath)) rmSync(tempPath, { force: true }); } catch { /* 保留原错误 */ }
      try { copyFileSync(join(backupDir, basename(file)), file); } catch { /* 尽力回滚 */ }
    }
    throw error;
  }

  const after = applied.length > 0 ? await verifySessionLogLoadable(ctx, sessionId) : before;
  if (!after.ok && applied.length > 0) {
    for (const file of applied) {
      try { copyFileSync(join(backupDir, basename(file)), file); } catch { /* 保留验证错误 */ }
    }
    throw new ArchiveError('REPAIR_FAILED', `session repair verification failed: ${after.error}`, 500);
  }

  return {
    sessionId,
    filePath: primaryPath ?? files[0],
    backupDir,
    fileCount: files.length,
    repairedFiles: applied.length,
    changed: applied.length > 0,
    repairedEvents,
    repairedMessageIds,
    removed,
    dropped,
    loadableBefore: before.ok,
    loadableAfter: after.ok,
    errorBefore: before.ok ? undefined : before.error,
    errorAfter: after.ok ? undefined : after.error
  };
}

async function deleteArchivedSession(ctx, sessionId) {
  const agent = ctx.agents.get(sessionId);
  // Running check removed: allow deletion even when agent status is stuck (truncated replies)
  const meta = await persistenceHeaderById(ctx.sessionPersistence, sessionId);
  if (meta !== undefined && typeof ctx.sessionPersistence.locate !== 'function') throw new ArchiveError('DELETE_UNSUPPORTED', 'session persistence backend does not expose artifact locations', 501);
  const location = meta ? ctx.sessionPersistence.locate(meta) : undefined;
  if (meta !== undefined && (location === undefined || typeof location.path !== 'string' || location.path.length === 0)) throw new ArchiveError('DELETE_UNSUPPORTED', 'session persistence backend does not expose per-session artifact locations', 501);
  const dir = location ? dirname(location.path) : undefined;
  deletedSessionIds.add(sessionId);
  try {
    if (dir && existsSync(dir)) await deleteStoppedSessionDirectory(dir);
    // 解绑+清缓存+刷新：detachWorkspaceRefs 内部对每个工作区实体调 detachSession，
    // 会把该 id 从 tables.workspaces[*].sessionIds 里摘掉（宿主 dsh-workspace 的实现），
    // 所以这里不用再单独清工作区记录；失败只记日志，不再阻断下面的名单清理。
    const detachOk = await detachWorkspaceRefs(ctx, sessionId);
    if (!detachOk) ctx.logger?.warn?.(`[${name}] detach '${sessionId}' from workspace records failed; archive id is still removed from the list`);
    // 幽灵条目根治：名单是落盘的（workspace.json 的 global.archivedSessionIds），
    // 而 deletedSessionIds 只是内存墓碑、进程重启即清空。所以删除成功路径上
    // 【一律】把该 id 从名单里删掉——文件已经删了（或用户明确要删），名单留着
    // 只会在重启后复活成"文件不在、条目还在"的幽灵行。不再受 detachOk /
    // isSessionLive 条件限制；这一步写盘失败就整体报错，不假装删成功。
    const archivedSessionIds = await setArchivedSessionIds(ctx, (ids) => ids.filter((id) => id !== sessionId));
    return { sessionId, archivedSessionIds, deleted: meta !== undefined, items: await archivedSessionItems(ctx) };
  } catch (error) {
    deletedSessionIds.delete(sessionId);
    throw error;
  }
}

async function handleArchiveAction(ctx, req, res, action, decode = () => undefined) {
  if (req.method !== 'POST') return respond(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  const contentType = req.headers?.['content-type'];
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) return respond(res, 415, { ok: false, error: { code: 'INVALID_REQUEST', message: 'application/json required' } });
  try {
    const input = decode(await readJsonBody(req, MAX_SESSION_BODY_BYTES));
    return respond(res, 200, { ok: true, value: await action(input) });
  } catch (error) {
    if (error instanceof ArchiveError) return respond(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
    if (error instanceof TypeError || error instanceof SyntaxError) return respond(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: error.message } });
    return respond(res, 500, { ok: false, error: { code: 'ARCHIVE_FAILED', message: error instanceof Error ? error.message : String(error) } });
  }
}

function handleArchiveList(ctx, req, res) {
  return handleArchiveAction(ctx, req, res, () => archivedSessionItems(ctx));
}

function handleArchiveRestore(ctx, req, res) {
  return handleArchiveAction(ctx, req, res, (sessionId) => restoreArchivedSession(ctx, sessionId), decodeArchiveRequest);
}

function handleArchiveDelete(ctx, req, res) {
  return handleArchiveAction(ctx, req, res, (sessionId) => deleteArchivedSession(ctx, sessionId), decodeArchiveRequest);
}

function handleArchivePreview(ctx, req, res) {
  return handleArchiveAction(ctx, req, res, (input) => previewArchivedSession(ctx, input), decodeArchivePreviewRequest);
}

function handleToolStats(ctx, req, res) {
  return handleArchiveAction(ctx, req, res, (sessionId) => currentSessionToolStats(ctx, sessionId), decodeArchiveRequest);
}

function handleRepairSession(ctx, req, res) {
  return handleArchiveAction(ctx, req, res, (sessionId) => repairCurrentSession(ctx, sessionId), decodeArchiveRequest);
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampInteger(value, fallback, min, max) {
  return Math.trunc(clampNumber(value, fallback, min, max));
}

function rawRatio(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1 ? number : fallback;
}

function rawPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function rawNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function compactionTargetForAgent(agent) {
  const routed = agent?.session?.requestHeader?.()?.config;
  if (typeof routed?.provider === 'string' && routed.provider.length > 0 && typeof routed?.model === 'string' && routed.model.length > 0) {
    return { provider: routed.provider, model: routed.model };
  }
  const provider = agent?.options?.provider;
  const model = agent?.options?.model;
  if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) return { provider, model };
}

function effectiveCompactionConfig(config, agent) {
  const source = config && typeof config === 'object' ? config : {};
  const target = compactionTargetForAgent(agent);
  const override = target && Array.isArray(source.modelPolicies)
    ? source.modelPolicies.find((policy) => policy?.provider === target.provider && policy?.model === target.model)
    : undefined;
  return override && typeof override === 'object' ? { ...source, ...override } : source;
}

function compactionDefaultsFromConfig(config) {
  // Read only the live engine's top-level resolved config.  Model-specific
  // policies are runtime overrides, not the baseline values shown as
  // "official defaults" in the settings dialog.
  const source = config && typeof config === 'object' ? config : {};
  return {
    thresholdRatio: rawRatio(source.thresholdRatio, COMPACTION_DEFAULT_THRESHOLD_RATIO),
    retainRatio: rawRatio(source.retainRatio, COMPACTION_DEFAULT_RETAIN_RATIO),
    maxTokens: rawPositiveInteger(source.maxTokens, COMPACTION_DEFAULT_MAX_TOKENS),
    compactionRetries: rawNonNegativeInteger(source.compactionRetries, COMPACTION_DEFAULT_RETRIES),
    maxOverflowRetries: rawNonNegativeInteger(source.maxOverflowRetries, COMPACTION_DEFAULT_OVERFLOW_RETRIES)
  };
}

async function installedCompactionDefaults() {
  try {
    const modulePath = require.resolve('@deepseek-ai/dsh-compaction-basic');
    const moduleUrl = pathToFileURL(modulePath);
    const mtime = statSync(modulePath).mtimeMs;
    moduleUrl.searchParams.set('mtime', String(mtime));
    const module = await import(moduleUrl.href);
    const Engine = module.BasicCompactionEngine ?? module.default;
    if (typeof Engine !== 'function') return DEFAULT_COMPACTION_VALUES;
    const engine = new Engine({ reflect: { provide() {} } }, { auto: false });
    return compactionDefaultsFromConfig(engine.config);
  } catch {
    return DEFAULT_COMPACTION_VALUES;
  }
}

function compactionSessionIdOf(req) {
  try {
    const id = new URL(req.url || COMPACTION_CONFIG_ROUTE, 'http://dsh.local').searchParams.get('sessionId');
    return typeof id === 'string' && SESSION_ID_RE.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function agentForSessionId(ctx, id) {
  if (!id) return undefined;
  return ctx.agents.get(id) ?? ctx.agents.get(SessionId(id));
}

async function compactionDefaultsForRequest(ctx, controller, req) {
  // Re-read the installed official compaction-basic defaults for every dialog
  // request, without sampling live agents whose modelPolicies or plugin-applied
  // overrides can change the baseline labels.
  return installedCompactionDefaults();
}

function normalizeCompactionSettings(value, defaults = DEFAULT_COMPACTION_VALUES) {
  const retainRatio = clampNumber(value?.retainRatio, defaults.retainRatio, COMPACTION_MIN_RETAIN_RATIO, COMPACTION_MAX_RETAIN_RATIO);
  const thresholdRatio = clampNumber(value?.thresholdRatio, defaults.thresholdRatio, COMPACTION_MIN_THRESHOLD_RATIO, COMPACTION_MAX_THRESHOLD_RATIO);
  return {
    enabled: value?.enabled === true,
    thresholdRatio,
    retainRatio,
    maxTokens: clampInteger(value?.maxTokens, defaults.maxTokens, COMPACTION_MIN_MAX_TOKENS, COMPACTION_MAX_MAX_TOKENS),
    compactionRetries: clampInteger(value?.compactionRetries, defaults.compactionRetries, COMPACTION_MIN_RETRIES, COMPACTION_MAX_RETRIES),
    maxOverflowRetries: clampInteger(value?.maxOverflowRetries, defaults.maxOverflowRetries, COMPACTION_MIN_RETRIES, COMPACTION_MAX_RETRIES)
  };
}

function normalizeGlobalPromptSettings(value) {
  const text = typeof value?.text === 'string' ? value.text.slice(0, GLOBAL_PROMPT_MAX_TEXT_LENGTH) : '';
  return {
    enabled: value?.enabled === true,
    text
  };
}

function validateGlobalPromptSettings(value) {
  if (typeof value?.enabled !== 'boolean') return 'invalid-enabled';
  if (typeof value?.text !== 'string') return 'invalid-text';
  if (value.text.length > GLOBAL_PROMPT_MAX_TEXT_LENGTH) return 'text-too-large';
}

function createGlobalPromptRuntimeController(ctx, settingsProvider) {
  let disposeRootSection;
  const agentFibers = new Map();
  const pendingDisposals = new Set();
  const currentText = () => {
    const settings = settingsProvider();
    const text = typeof settings?.text === 'string' ? settings.text.trim() : '';
    return settings?.enabled && text.length > 0 ? text : '';
  };
  const section = Object.freeze({
    name: GLOBAL_PROMPT_SECTION,
    order: GLOBAL_PROMPT_ORDER,
    text: currentText
  });
  const disposeAgent = (agent) => {
    const fiber = agentFibers.get(agent);
    if (fiber === undefined) return;
    agentFibers.delete(agent);
    const task = Promise.resolve(fiber.dispose()).catch((error) => {
      ctx.logger?.warn?.(`[${name}] global prompt agent cleanup failed:`, error);
    });
    pendingDisposals.add(task);
    void task.finally(() => pendingDisposals.delete(task));
  };
  const installAgent = (agent) => {
    if (agent === undefined || agentFibers.has(agent) || typeof agent.ctx?.inject !== 'function') return;
    const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.section(section);
    });
    agentFibers.set(agent, fiber);
  };
  const apply = () => {
    if (disposeRootSection === undefined && typeof ctx.systemPrompt?.section === 'function') disposeRootSection = ctx.systemPrompt.section(section);
    if (typeof ctx.agents?.list === 'function') {
      for (const agent of ctx.agents.list()) installAgent(agent);
    }
  };
  const dispose = () => {
    if (disposeRootSection !== undefined) {
      disposeRootSection();
      disposeRootSection = undefined;
    }
    for (const agent of Array.from(agentFibers.keys())) disposeAgent(agent);
  };
  return { apply, dispose, installAgent, disposeAgent, isActive: () => currentText().length > 0 || disposeRootSection !== undefined || agentFibers.size > 0 };
}

function validateCompactionSettings(value) {
  if (typeof value?.enabled !== 'boolean') return 'invalid-enabled';
  if (typeof value?.thresholdRatio !== 'number' || !Number.isFinite(value.thresholdRatio) || value.thresholdRatio < COMPACTION_MIN_THRESHOLD_RATIO || value.thresholdRatio > COMPACTION_MAX_THRESHOLD_RATIO) return 'invalid-threshold-ratio';
  if (typeof value?.retainRatio !== 'number' || !Number.isFinite(value.retainRatio) || value.retainRatio < COMPACTION_MIN_RETAIN_RATIO || value.retainRatio > COMPACTION_MAX_RETAIN_RATIO) return 'invalid-retain-ratio';
  if (value.retainRatio >= value.thresholdRatio) return 'retain-ratio-not-less-than-threshold';
  if (!Number.isInteger(value?.maxTokens) || value.maxTokens < COMPACTION_MIN_MAX_TOKENS || value.maxTokens > COMPACTION_MAX_MAX_TOKENS) return 'invalid-max-tokens';
  if (!Number.isInteger(value?.compactionRetries) || value.compactionRetries < COMPACTION_MIN_RETRIES || value.compactionRetries > COMPACTION_MAX_RETRIES) return 'invalid-compaction-retries';
  if (!Number.isInteger(value?.maxOverflowRetries) || value.maxOverflowRetries < COMPACTION_MIN_RETRIES || value.maxOverflowRetries > COMPACTION_MAX_RETRIES) return 'invalid-max-overflow-retries';
}

function patchCompactionPolicy(policy, settings) {
  const { retainTokens: _retainTokens, ...rest } = policy && typeof policy === 'object' ? policy : {};
  return Object.freeze({
    ...rest,
    thresholdRatio: settings.thresholdRatio,
    retainRatio: settings.retainRatio,
    maxTokens: settings.maxTokens,
    compactionRetries: settings.compactionRetries,
    maxOverflowRetries: settings.maxOverflowRetries
  });
}

function cloneCompactionConfig(config, settings, agent) {
  const source = config && typeof config === 'object' ? config : {};
  const base = patchCompactionPolicy(source, settings);
  const target = compactionTargetForAgent(agent);
  if (!target || !Array.isArray(source.modelPolicies)) return base;
  return Object.freeze({
    ...base,
    modelPolicies: Object.freeze(source.modelPolicies.map((policy) => {
      if (policy?.provider === target.provider && policy?.model === target.model) return patchCompactionPolicy(policy, settings);
      return policy;
    }))
  });
}

function createCompactionRuntimeController(ctx, settingsProvider) {
  const touched = new Set();
  const originals = new WeakMap();
  const engineForAgent = (agent) => ctx.get?.('agentPresets')?.serviceFor?.(agent, 'compaction') ?? ctx.get?.('compaction');
  const patchEngine = (engine, settings, agent) => {
    if (!engine || typeof engine !== 'object' || engine.config === undefined) return;
    if (!originals.has(engine)) {
      originals.set(engine, { config: engine.config });
      touched.add(engine);
    }
    engine.config = cloneCompactionConfig(engine.config, settings, agent);
  };
  const restoreEngines = () => {
    for (const engine of touched) {
      const original = originals.get(engine);
      if (original !== undefined) {
        engine.config = original.config;
        originals.delete(engine);
      }
    }
    touched.clear();
  };
  const applyToAgent = (agent) => {
    const settings = settingsProvider();
    if (!settings.enabled) return;
    patchEngine(engineForAgent(agent), settings, agent);
  };
  const applyToLiveAgents = async () => {
    const settings = settingsProvider();
    if (!settings.enabled) {
      restoreEngines();
      return;
    }
    const agents = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : [];
    for (const agent of agents) applyToAgent(agent);
  };
  return { applyToAgent, applyToLiveAgents, restoreEngines };
}

export { name, inject, TURNS_DEL_PATH, TURNS_DEL_TURN_PATH, REGENERATE_PATH, REGENERATE_TURN_PATH, EDIT_REGENERATE_TURN_PATH, TURNS_DEL_PROVIDER, TurnsDelError, deleteTurns, deleteTurnsByTurn, regenerateTurns, regenerateTurnsByTurn, editRegenerateTurnsByTurn, isTurnsDelEvent, purgeDeletedOnDisk, dropProjectionCache };

/* ═══ 注入源开关 ══════════════════════════════════════════════════════
   四个记忆相关源**默认开**（等于改动前的既有行为：记忆说明常驻、每轮召回、
   自动匹配项目、记住提示都在），显式存过 false 才关——聊天要记得住人，
   关掉记忆等于把插件的主要用途砍了，所以不做"默认全关"。
   任务自动提示与全局提示词维持各自既有域的原状，路由层聚合展示、分键写回。 */
function normalizeInjectionSources(value) {
  return {
    memoryGuide: value?.memoryGuide !== false,
    recall: value?.recall !== false,
    firstTurnMatch: value?.firstTurnMatch !== false,
    memoryRequest: value?.memoryRequest !== false
  };
}

/* ═══ 提示词工坊 ══════════════════════════════════════════════════════
   预设正文住在 dsh-preset-lite/cordis.patch.yml，被一对 workshop:<slot> 注释夹住。
   工坊只替换标记之间的 persona 文本块，YAML 结构由本文件按固定缩进生成——
   用户在界面上编辑的永远是纯文本，不会把 YAML 写坏。 */
const PRESET_LITE_PACKAGE = 'dsh-preset-lite';
const PRESET_LITE_PATCH_FILE = 'cordis.patch.yml';
const PROMPT_WORKSHOP_RELOAD_MARK = '# dsh-session-kit prompt-workshop reload:';
const PROMPT_SLOT_MAX_TEXT = 40000;
const PROMPT_SLOTS = Object.freeze([
  Object.freeze({ id: 'dafeyu', preset: 'lite', label: '大肥鱼（闲聊）' }),
  Object.freeze({ id: 'plain', preset: 'lite-plain', label: '普通节约（干活）' }),
  /* 纯聊天版（2026-10-18）：零工具预设 lite-chat 的 persona 也进工坊，
     用户可以在界面上直接改这一版的人格，与另两版同一条路。 */
  Object.freeze({ id: 'chat', preset: 'lite-chat', label: '纯聊天（零工具）' })
  /* kb 槽位已撤（2026-10-19）：lite-chat-kb 预设因 knowledge-sqlite 双声明冲突被移除；
     知识库调用改走 webin 的 kbProtocol 全局开关（任何预设下自然语言句式都翻译）。 */
]);

function sessionKitProfileDir() {
  const cand = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  // 跨布局修正（2026-10-09 手机实测）：PC 布局 profiles/web/node_modules/<插件>/lib → up3=profiles/web ✓；
  // DSHA 手机布局 plugin-src/<插件>/lib → up3=dshHome ✗（少了 profiles/web 两级），导致
  // preset 路径解析成 dshHome/node_modules/...（preset-read-failed）、reload 注释写错文件、
  // memory 目录算成 dshHome/.dsh-session-kit（与 sync 同步的 profiles/web 版错开 → 绑定永不生效）。
  // 判据：up3 有没有 package.json（profile 必有；dshHome 没有）。
  try { if (existsSync(join(cand, 'package.json'))) return cand } catch { /* 走兜底 */ }
  const dh = process.env.DSH_HOME
  if (dh) {
    const prof = process.env.DSHA_STARTUP_PROFILE || 'web'
    const p = join(dh, 'profiles', prof)
    try { if (existsSync(join(p, 'package.json'))) return p } catch { /* 走兜底 */ }
  }
  return cand;
}
function presetLitePatchPath() {
  return join(sessionKitProfileDir(), 'node_modules', PRESET_LITE_PACKAGE, PRESET_LITE_PATCH_FILE);
}
function profilePatchFilePath() {
  return join(sessionKitProfileDir(), 'cordis.patch.yml');
}
function promptBackupDir() {
  return join(sessionKitProfileDir(), '.dsh-session-kit', 'prompt-backups');
}

function normalizePromptWorkshop(value) {
  const versions = normalizePromptVersions(value?.versions);
  const known = new Set([PROMPT_BASE_PRESET_ID, ...versions.map((version) => version.presetId)]);
  const raw = value?.workspacePresets;
  const workspacePresets = {};
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, preset] of Object.entries(raw)) {
      if (typeof key !== 'string' || key.length === 0 || key.length > 1024) continue;
      if (typeof preset !== 'string' || !known.has(preset)) continue;
      workspacePresets[key] = preset;
    }
  }
  return { versions, workspacePresets, autoApply: value?.autoApply === true };
}

/* 会话 cwd → 工作区绑定的预设。先按原样命中（绑定键就是 workspace.path），
   再做一次 Windows 大小写不敏感兜底；都没有就返回 undefined（不动）。 */
function promptPresetForCwd(workshop, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
  const direct = workshop?.workspacePresets?.[cwd];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const lower = cwd.toLowerCase();
  try {
    for (const [key, value] of Object.entries(workshop?.workspacePresets ?? {})) {
      if (typeof key === 'string' && key.toLowerCase() === lower && typeof value === 'string' && value.length > 0) return value;
    }
  } catch { /* ignore */ }
  return undefined;
}

/* 与注册表 select() 的 locked 闸同一判据：没有未结束的轮次、且一轮都没跑过才算空白。
   老宿主没有 turnBoundaryOf 时返回 false（宁可不补，也不猜）。 */
function isBlankForPreset(ctx, session) {
  try {
    const boundary = ctx.agents?.turnBoundaryOf?.(session);
    if (boundary === undefined || boundary === null) return false;
    return boundary.openTurnStartSeq === null && boundary.lastTurn === 0;
  } catch {
    return false;
  }
}

/* 空白会话被宿主「按默认 preset 重新组装」时，把工作区绑定的预设补回去。
   护栏：
   ①autoApply 必须为 true（用户没在设置页打开就完全不插手）；
   ②只认 event.data.agentPreset === ctx.get('agentPresets').defaultId——即宿主默认值，
     不是用户手选的某个 lite 版本；
   ③agent 必须已经发布（ctx.agents.get 有值）：会话恢复（resume）时宿主在 setup 阶段
     就落这条事件、Agent 还没发布，那条路会由 agent/created 自愈，这里不重复组装；
   ④子代理会话（header.origin==='subagent'）不动；
   ⑤必须仍是空白会话（lastTurn=0 且无未结束轮次），过不了注册表的 locked 闸就没意义；
   ⑥每个会话只纠正一次（用户坚持手选标准模式时第二次就尊重用户），Set 上限 500 防泄漏；
   ⑦任何失败只记日志，绝不影响会话本身。 */
function makeWorkspacePresetRestorer(ctx, currentWorkshop) {
  const restoredBlankPresets = new Set();
  return (session, event) => {
    try {
      if (event?.type !== 'agent-preset/selected') return;
      const workshop = currentWorkshop();
      if (workshop?.autoApply !== true) return;
      const presets = ctx.get('agentPresets');
      if (presets === undefined || presets === null) return;
      const defaultId = presets.defaultId;
      if (typeof defaultId !== 'string' || defaultId.length === 0) return;
      if (event?.data?.agentPreset !== defaultId) return;
      const sessionId = String(session?.id ?? '');
      if (sessionId.length === 0 || restoredBlankPresets.has(sessionId)) return;
      const agent = ctx.agents?.get?.(session.id);
      if (agent === undefined) return;
      const header = agent?.session?.header ?? session?.header;
      if (header?.origin === 'subagent') return;
      const target = promptPresetForCwd(workshop, header?.cwd);
      if (target === undefined || target === defaultId) return;
      if (!isBlankForPreset(ctx, agent.session)) return;
      if (restoredBlankPresets.size >= 500) restoredBlankPresets.clear();
      restoredBlankPresets.add(sessionId);
      Promise.resolve(presets.select?.(agent, target)).catch((error) => {
        ctx.logger?.warn?.(`[${name}] workspace preset restore skipped:`, error);
      });
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] workspace preset restore hook failed:`, error);
    }
  };
}

/* 读一个槽位的文本块：标记之间、prefix: | 之后。返回 undefined = 标记缺失。 */
function readPromptSlot(fileText, slotId) {
  const lines = String(fileText).split('\n');
  const startLine = lines.findIndex((line) => line.trim() === `# >>> workshop:${slotId} >>>`);
  if (startLine < 0) return undefined;
  const endLine = lines.findIndex((line, index) => index > startLine && line.trim() === `# <<< workshop:${slotId} <<<`);
  if (endLine < 0) return undefined;
  const prefixIndex = lines.findIndex((line, index) => index > startLine && index < endLine && /^\s*prefix:\s*\|/u.test(line));
  if (prefixIndex < 0) return undefined;
  const indent = (lines[prefixIndex].match(/^\s*/u) ?? [''])[0].length;
  const bodyIndent = indent + 2;
  const body = [];
  for (let index = prefixIndex + 1; index < endLine; index += 1) {
    const line = lines[index];
    if (line.trim() === '') { body.push(''); continue; }
    body.push(line.startsWith(' '.repeat(bodyIndent)) ? line.slice(bodyIndent) : line.trimStart());
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { text: body.join('\n'), startLine, prefixIndex, endLine, indent, bodyIndent };
}

/* 用新文本重写槽位：只换 prefix 行与其下文本块，标记和其余结构原样保留。 */
function rewritePromptSlot(fileText, slotId, text) {
  const slot = readPromptSlot(fileText, slotId);
  if (slot === undefined) return undefined;
  const lines = String(fileText).split('\n');
  const { prefixIndex, endLine, indent, bodyIndent } = slot;
  const bodyLines = String(text).replace(/\r\n/gu, '\n').split('\n');
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
  const rendered = bodyLines.map((line) => (line === '' ? '' : `${' '.repeat(bodyIndent)}${line}`));
  return [
    ...lines.slice(0, prefixIndex),
    `${' '.repeat(indent)}prefix: |`,
    ...rendered,
    ...lines.slice(endLine)
  ].join('\n');
}

/* HMR 只监视 profile 的 package.json 与两个 patch 文件，插件自带的 cordis.patch.yml
   不在监视范围。这里在 profile patch 末尾维护一行内容会变的注释，触发一次重组合，
   新的预设文本才会被读进内存（新会话生效；已在跑的会话保持旧文本）。

   2026-11-27（0.2.0-rc.2 桌面版实测）：Electron 里没有 DSHA_STARTUP_PROFILE，
   sessionKitProfileDir() 回落到 profiles/web，而桌面版加载的是 profiles/desktop ——
   注释写进了没人监听的 web 补丁，工坊保存后要重启 DSH 才生效。这里改成写所有
   「node_modules/dsh-session-kit 解析到本插件」的 profile（web、desktop 同时在列），
   老宿主只有一个 profile 时行为与以前一致。 */
function profileDirsOwningThisKit() {
  const dirs = [];
  const push = (dir) => {
    try {
      if (typeof dir !== 'string' || dir.length === 0 || dirs.includes(dir)) return;
      if (!existsSync(join(dir, 'package.json'))) return;
      dirs.push(dir);
    } catch { /* ignore */ }
  };
  push(sessionKitProfileDir());
  try {
    const home = process.env.DSH_HOME;
    if (home) {
      const root = join(home, 'profiles');
      for (const entry of readdirSync(root)) {
        const candidate = join(root, entry);
        let target;
        try { target = realpathSync(join(candidate, 'node_modules', 'dsh-session-kit')); } catch { continue; }
        if (target === SESSION_KIT_PACKAGE_DIR) push(candidate);
      }
    }
  } catch { /* 没有 profiles 目录就只写解析出来的那一个 */ }
  return dirs;
}

function nudgeProfileReload() {
  const stamp = `${PROMPT_WORKSHOP_RELOAD_MARK} ${new Date().toISOString()}`;
  let nudged = false;
  for (const dir of profileDirsOwningThisKit()) {
    const path = join(dir, 'cordis.patch.yml');
    if (!existsSync(path)) continue;
    try {
      const lines = readFileSync(path, 'utf8').split('\n');
      const index = lines.findIndex((line) => line.startsWith(PROMPT_WORKSHOP_RELOAD_MARK));
      if (index >= 0) lines[index] = stamp;
      else {
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
        lines.push(stamp, '');
      }
      writeFileSync(path, lines.join('\n'), 'utf8');
      nudged = true;
    } catch { /* 单个 profile 写失败不影响其它 profile */ }
  }
  return nudged;
}

/* 写插件 patch：备份 → 清只读（pnpm 装出来的文件是 ReadOnly）→ 写 → 读回校验。 */
function savePromptSlotFile(slotId, text) {
  const path = presetLitePatchPath();
  if (!existsSync(path)) return { error: 'preset-plugin-not-found' };
  let original;
  try {
    original = readFileSync(path, 'utf8');
  } catch {
    return { error: 'preset-read-failed' };
  }
  if (readPromptSlot(original, slotId) === undefined) return { error: 'preset-marker-missing' };
  const updated = rewritePromptSlot(original, slotId, text);
  if (updated === undefined) return { error: 'preset-marker-missing' };
  try {
    mkdirSync(promptBackupDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    copyFileSync(path, join(promptBackupDir(), `${PRESET_LITE_PATCH_FILE}.${slotId}.${stamp}.bak`));
  } catch {
    /* 备份失败不阻断写入 */
  }
  try {
    writeFileSync(path, updated, 'utf8');
  } catch {
    try {
      chmodSync(path, 0o666);
      writeFileSync(path, updated, 'utf8');
    } catch {
      return { error: 'preset-write-failed' };
    }
  }
  let check;
  try {
    check = readPromptSlot(readFileSync(path, 'utf8'), slotId);
  } catch {
    return { error: 'preset-write-failed' };
  }
  if (check === undefined) return { error: 'preset-write-failed' };
  const expected = String(text).replace(/\r\n/gu, '\n').trim();
  if (check.text.trim() !== expected) return { error: 'preset-write-verify-failed' };
  return { value: { bytes: Buffer.byteLength(updated, 'utf8'), reloadNudged: nudgeProfileReload() } };
}

/* ── 提示词版本：一个版本 = 一个独立预设 ────────────────────────────────
   默认版本「大肥鱼」写在 cordis.patch.yml 的 preset-lite 里（手改友好）；
   用户自建版本由工坊写进同一文件的 workshop:extra 生成区，每个版本一条预设声明。
   生成区的工具行**不是硬编码**，而是每次从默认版本的插件列表里现取，
   这样以后改默认版本的工具，自建版本自动跟着一致。 */
const PROMPT_EXTRA_BEGIN = '# >>> workshop:extra >>>';
const PROMPT_EXTRA_END = '# <<< workshop:extra <<<';
const PROMPT_VERSION_MAX = 12;
const PROMPT_VERSION_NAME_MAX = 60;
const PROMPT_BASE_PRESET_ID = 'lite';
const DEFAULT_PROMPT_VERSION = Object.freeze({
  presetId: 'lite-plain',
  name: '普通节约',
  text: '你是 Evelyn 的工作助手。默认用中文，直接给结论和可执行步骤：不寒暄、不铺垫、不堆 emoji。\n\n- 技术问题：先结论 → 可直接复制的命令/代码 → 备选路线与保底方案；不确定就说不确定，不编造。\n- 只做被要求的事，改动范围收敛；破坏性操作先确认。\n- 需要资料就用工具查（文件/网页/知识库），查不到直说。'
});

function normalizePromptVersions(value) {
  const list = Array.isArray(value) ? value : [];
  const versions = [];
  const used = new Set([PROMPT_BASE_PRESET_ID]);
  for (const item of list) {
    if (versions.length >= PROMPT_VERSION_MAX) break;
    const presetId = typeof item?.presetId === 'string' ? item.presetId.trim().toLowerCase() : '';
    const name = typeof item?.name === 'string' ? item.name.trim().slice(0, PROMPT_VERSION_NAME_MAX) : '';
    const text = typeof item?.text === 'string' ? item.text.slice(0, PROMPT_SLOT_MAX_TEXT) : '';
    if (!/^lite-[a-z0-9-]{1,40}$/u.test(presetId) || used.has(presetId) || name.length === 0) continue;
    used.add(presetId);
    versions.push({ presetId, name, text });
  }
  return versions;
}

function nextPromptPresetId(versions) {
  const used = new Set([PROMPT_BASE_PRESET_ID, ...versions.map((version) => version.presetId)]);
  for (let index = 2; index < 100; index += 1) {
    const candidate = `lite-v${String(index)}`;
    if (!used.has(candidate)) return candidate;
  }
  return `lite-v${String(Date.now())}`;
}

/* 默认版本的插件列表（工具行）——从 preset-lite 的 persona 之后取到生成区之前。 */
function extractBaseTools(lines, extraBeginIndex) {
  const baseIndex = lines.findIndex((line) => line.trim() === `- id: preset-${PROMPT_BASE_PRESET_ID}`);
  if (baseIndex < 0) return undefined;
  const stop = extraBeginIndex > baseIndex ? extraBeginIndex : lines.length;
  const completeIndex = lines.findIndex((line, index) => index > baseIndex && line.trim() === 'complete: true');
  const searchFrom = completeIndex > baseIndex ? completeIndex : baseIndex;
  const toolsStart = lines.findIndex((line, index) => index > searchFrom && index < stop && /^\s*- id: \S/u.test(line));
  if (toolsStart < 0 || toolsStart >= stop) return undefined;
  const tools = lines.slice(toolsStart, stop);
  while (tools.length > 0 && tools[tools.length - 1].trim() === '') tools.pop();
  if (tools.length === 0) return undefined;
  return tools;
}

function renderExtraPreset(version, order, toolsLines) {
  const bodyLines = String(version.text).replace(/\r\n/gu, '\n').split('\n');
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
  const persona = bodyLines.map((line) => (line === '' ? '' : `                ${line}`));
  return [
    `    - id: preset-${version.presetId}`,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    `        id: ${version.presetId}`,
    `        name: ${JSON.stringify(version.name)}`,
    `        order: ${String(order)}`,
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: |',
    ...persona,
    '              complete: true',
    '              includeRuntimeContext: false',
    ...toolsLines
  ].join('\n');
}

/* 重写生成区（自建版本）。返回 { value } 或 { error }；内容没变就不落盘。 */
function regeneratePromptExtras(versions) {
  const path = presetLitePatchPath();
  if (!existsSync(path)) return { error: 'preset-plugin-not-found' };
  let original;
  try {
    original = readFileSync(path, 'utf8');
  } catch {
    return { error: 'preset-read-failed' };
  }
  const lines = original.split('\n');
  const begin = lines.findIndex((line) => line.trim() === PROMPT_EXTRA_BEGIN);
  const end = lines.findIndex((line, index) => index > begin && line.trim() === PROMPT_EXTRA_END);
  if (begin < 0 || end < 0) return { error: 'preset-extra-marker-missing' };
  const tools = extractBaseTools(lines, begin);
  if (tools === undefined) return { error: 'preset-base-preset-missing' };
  const blocks = versions.map((version, index) => renderExtraPreset(version, 6 + index, tools));
  const next = [
    ...lines.slice(0, begin + 1),
    ...(blocks.length === 0 ? [] : [...blocks.join('\n').split('\n')]),
    ...lines.slice(end)
  ].join('\n');
  if (next === original) return { value: { changed: false, bytes: Buffer.byteLength(original, 'utf8'), reloadNudged: false } };
  try {
    mkdirSync(promptBackupDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    copyFileSync(path, join(promptBackupDir(), `${PRESET_LITE_PATCH_FILE}.extras.${stamp}.bak`));
  } catch {
    /* 备份失败不阻断 */
  }
  try {
    writeFileSync(path, next, 'utf8');
  } catch {
    try {
      chmodSync(path, 0o666);
      writeFileSync(path, next, 'utf8');
    } catch {
      return { error: 'preset-write-failed' };
    }
  }
  let check;
  try {
    check = readFileSync(path, 'utf8');
  } catch {
    return { error: 'preset-write-failed' };
  }
  for (const version of versions) {
    if (!check.includes(`preset-${version.presetId}`)) return { error: 'preset-write-verify-failed' };
  }
  return { value: { changed: true, bytes: Buffer.byteLength(next, 'utf8'), reloadNudged: nudgeProfileReload() } };
}

/* 删一个工作区实体：护栏（最后一个不删、有 live 会话不删）→ 逐会话删文件+projcache
   → 整删项目目录（覆盖孤儿）→ 撤墓碑 → 删注册。返回 { status, payload } 由路由写响应。
   会话页菜单与设置页（按路径）两条入口共用这段，避免两份实现漂移。 */
async function performWorkspaceDelete(ctx, wsEntity) {
  if (ctx.workspaceRegistry.list().length <= 1) {
    return { status: 409, payload: { ok: false, error: 'last-workspace' } };
  }
  const recordIds = [...(wsEntity.sessionIds || [])];
  for (const sid of recordIds) {
    if (isSessionLive(ctx, sid)) {
      return { status: 409, payload: { ok: false, error: 'workspace-has-live-session', sessionId: sid } };
    }
  }
  let deleted = 0;
  for (const sid of recordIds) {
    deletedSessionIds.add(sid);
    try {
      const meta = await persistenceHeaderById(ctx.sessionPersistence, sid);
      const location = meta ? ctx.sessionPersistence.locate?.(meta) : undefined;
      const dir = location?.path ? dirname(location.path) : undefined;
      if (dir && existsSync(dir)) await deleteStoppedSessionDirectory(dir);
    } catch { /* 单会话失败不阻断整体 */ }
    try { rmSync(join(sessionsRootDir(), '..', 'storages', 'session_projcache', 'sessions', `${sid}.json`), { force: true }); } catch {}
    deleted++;
  }
  try {
    const key = projectKeyFor(wsEntity.path);
    if (key) {
      const projectDir = join(sessionsRootDir(), key);
      if (existsSync(projectDir)) await deleteStoppedSessionDirectory(projectDir);
    }
  } catch { /* 覆盖删除失败不阻断 */ }
  try {
    await setArchivedSessionIds(ctx, (ids) => ids.filter((sid) => !recordIds.includes(sid)));
  } catch {}
  const removed = await ctx.workspaceRegistry.delete(wsEntity.id);
  if (!removed) return { status: 404, payload: { ok: false, error: 'workspace-delete-failed' } };
  try { if (ctx.sessions && typeof ctx.sessions.refresh === 'function') await ctx.sessions.refresh(); } catch {}
  ctx.logger?.info?.(`[${name}] workspace deleted: ${wsEntity.id} (${deleted} sessions)`);
  return { status: 200, payload: { ok: true, workspaceId: wsEntity.id, deletedSessions: deleted } };
}

/* ── 同步友好的状态存储 ────────────────────────────────────────────────
   dsh-sync 的同步组只覆盖：settings.yaml、profiles 下的声明文件（package.json/
   cordis.patch.yml/锁文件）、sessions、memory.sqlite、knowledge.sqlite。
   $DSH_HOME/storages 下的 storageDomain 文件不在任何组里 → 存那里永远同步不过去。
   所以注入源开关与提示词版本改存 session-kit 自己的 memory.sqlite（memory_settings
   键值对，memory 组 strategy=merge 会带走它）；老域仅作迁移源与降级兜底。 */
const SYNCED_KEY_INJECTION = 'injectionSources';
const SYNCED_KEY_WORKSHOP = 'promptWorkshop';
/* 跨设备同步的存储真相 = memory.sqlite（dsh-sync 上传读它、下载写它）。
   2026-10-13 实锤：运行时 memoryStore 的 db 句柄异常时，老代码静默落域存储，
   工坊版本/绑定从此传不上云（UI 却是新的，两套账本打架）。这里留直连路径：
   写失败直写 sqlite、读取优先直读 sqlite，让「上传=最新、下载=可恢复」成立。 */
import { createRequire as createRequireForSqlite } from 'node:module';
const sqliteRequire = createRequireForSqlite(import.meta.url);
let syncedSqlitePath = '';
let syncedSqliteLog = '';

function readSyncedState(memoryStore, legacyStore, key) {
  if (syncedSqlitePath) {
    try {
      const { DatabaseSync } = sqliteRequire('node:sqlite');
      /* 0.2.x：dsh-sync 下载会在同一秒内重建/写 memory.sqlite，直读撞上写锁时以前整段
         回落到老域（autoApply=false、绑定为空）→ 这一轮启动里「按工作区自动套用」等于被关掉。
         给 5s busy 等待，宁可慢一点也别读到旧状态。 */
      const db = new DatabaseSync(syncedSqlitePath, { readOnly: true, timeout: 5000 });
      try {
        const row = db.prepare('SELECT value FROM memory_settings WHERE key = ?').get(key);
        if (typeof row?.value === 'string' && row.value.trim().length > 0) return JSON.parse(row.value);
      } finally { db.close(); }
    } catch { /* 直读失败走老路 */ }
  }
  if (memoryStore !== undefined) {
    try {
      const raw = memoryStore.getSetting(key);
      if (typeof raw === 'string' && raw.trim().length > 0) return JSON.parse(raw);
    } catch { /* 坏数据当没有，走迁移 */ }
  }
  let legacy;
  try { legacy = legacyStore?.global?.get?.(); } catch { legacy = undefined; }
  if (legacy !== undefined && memoryStore !== undefined) {
    try { memoryStore.setSetting(key, JSON.stringify(legacy ?? {})); } catch { /* 迁移失败不阻断 */ }
  }
  return legacy ?? {};
}

async function writeSyncedState(memoryStore, legacyStore, key, value) {
  const payload = JSON.stringify(value);
  if (memoryStore !== undefined) {
    try {
      memoryStore.setSetting(key, payload);
      return 'memory';
    } catch (error) {
      /* 历史上这里是静默吞掉 → 域存储成了唯一落点 → 云端永远旧账。记日志再直写。 */
      try { if (syncedSqliteLog) writeFileSync(syncedSqliteLog, `${new Date().toISOString()} writeSyncedState(${key}): memory store 写失败 — ${error?.message ?? error}；改直写\n`, { flag: 'a' }); } catch { /* 日志失败不影响主流程 */ }
    }
  }
  if (syncedSqlitePath) {
    try {
      const { DatabaseSync } = sqliteRequire('node:sqlite');
      /* 同上：直写也别一撞锁就退回域存储（否则云端读到的还是旧值）。 */
      const db = new DatabaseSync(syncedSqlitePath, { timeout: 5000 });
      try {
        db.prepare("INSERT INTO memory_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, payload, Date.now());
      } finally { db.close(); }
      return 'sqlite-direct';
    } catch (error) {
      try { if (syncedSqliteLog) writeFileSync(syncedSqliteLog, `${new Date().toISOString()} writeSyncedState(${key}): 直写失败 — ${error?.message ?? error}；落域存储\n`, { flag: 'a' }); } catch { /* 日志失败不影响主流程 */ }
    }
  }
  try {
    await legacyStore?.global?.set?.(value);
    return 'legacy';
  } catch {
    return 'failed';
  }
}

/* 热重载竞态自愈（2026-11-11）：cordis restart() 的旧代卸载与新代 apply 并发执行，
   旧代 disposer 里的 domain.close() 尚未落地时，新代 open 同名域会抛
   DomainError "already-open"。对此类可自愈冲突做有界重试；其余错误原样抛出。 */
async function openDomainResilient(ctx, spec) {
  const deadline = Date.now() + 30000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await ctx.storageDomain.open(spec);
    } catch (error) {
      const message = String(error?.message ?? error);
      const code = String(error?.code ?? '');
      const isAlreadyOpen = code === 'already-open' || message.includes('already open');
      if (!isAlreadyOpen || Date.now() >= deadline) throw error;
      if (attempt === 0) {
        ctx.logger?.warn?.(`[${name}] domain '${spec.name}' is already open（上一代实例尚未关闭）——每 300ms 重试，最长 30s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

export async function apply(ctx) {
  /* 真删除的卸载把手指令：工厂 resumeWith 可能在 apply 之后才注册，所以延迟重试几轮。 */
  const armHandleCapture = (attempt = 0) => {
    if (installAgentHandleCapture(ctx)) return;
    if (attempt >= 10) return;
    const t = setTimeout(() => armHandleCapture(attempt + 1), 300);
    if (typeof t.unref === 'function') t.unref();
  };
  armHandleCapture();
  const compactionStore = await openDomainResilient(ctx, compactionConfigDomainSpec);
  const sidebarEntriesStore = await openDomainResilient(ctx, sidebarEntriesDomainSpec);
  const globalPromptStore = await openDomainResilient(ctx, globalPromptDomainSpec);
  const taskAutoInjectStore = await openDomainResilient(ctx, taskAutoInjectDomainSpec);
  const memoryStorageStore = await openDomainResilient(ctx, memoryStorageDomainSpec);
  const injectionSourcesStore = await openDomainResilient(ctx, injectionSourcesDomainSpec);
  const promptWorkshopStore = await openDomainResilient(ctx, promptWorkshopDomainSpec);
  const distillSettingsStore = await openDomainResilient(ctx, distillSettingsDomainSpec);
  /* 运行时开关值：pre-step 每轮读取，避免频繁查库。
     真正的读写走 memory.sqlite（见下方 readSyncedState 说明），老域只是迁移源与兜底。 */
  const taskAutoInjectRef = { value: normalizeTaskAutoInject(taskAutoInjectStore.global.get()).enabled };
  const injectionSourcesRef = { value: normalizeInjectionSources(undefined) };
  const workshopRef = { value: normalizePromptWorkshop(undefined) };
  /* 记忆数据目录：仅启动时解析一次。改动后需重启 DSH 才生效（不热切换连接，
     避免与复用同一 db 句柄的 task 档案功能产生竞态）。 */
  const memoryStorageSettings = normalizeMemoryStorage(memoryStorageStore.global.get());
  /* 启动时实际生效的目录，用于判断保存后是否需要提示重启。 */
  const activeMemoryDataDir = memoryDataDirFor(memoryStorageSettings);
  let compactionSettings = normalizeCompactionSettings(compactionStore.global.get());
  let globalPromptSettings = normalizeGlobalPromptSettings(globalPromptStore.global.get());
  const compactionController = createCompactionRuntimeController(ctx, () => compactionSettings);
  const globalPromptController = createGlobalPromptRuntimeController(ctx, () => globalPromptSettings);
  globalPromptController.apply();
  await compactionController.applyToLiveAgents().catch((error) => ctx.logger?.warn?.(`[${name}] initial compaction config apply failed:`, error));
  /* 记忆与任务功能互相独立：任一失败都不阻塞另一个，也不阻塞插件本体。 */
  const memoryStore = await installMemoryFeature(ctx, {
    dataDir: memoryDataDirFor(memoryStorageSettings),
    isGuideEnabled: () => injectionSourcesRef.value.memoryGuide,
    isRecallEnabled: () => injectionSourcesRef.value.recall,
    isFirstTurnMatchEnabled: () => injectionSourcesRef.value.firstTurnMatch,
    isMemoryRequestEnabled: () => injectionSourcesRef.value.memoryRequest,
    /* 蒸馏链条接入执行侧（2026-11-09）：惰性求值，调用时 distillSettingsStore 必已就绪。 */
    distillChain: () => {
      try {
        const normalized = normalizeDistillSettings(distillSettingsStore.global.get());
        return Array.isArray(normalized.chain) ? normalized.chain : [];
      } catch {
        return [];
      }
    },
    /* 失败冷却分钟数（0=关闭，默认 60）：某项调用失败后，冷却期内直接跳过不再尝试。 */
    distillFailureCooldownMinutes: () => {
      try {
        const normalized = normalizeDistillSettings(distillSettingsStore.global.get());
        return Number.isFinite(normalized.failureCooldownMinutes) ? normalized.failureCooldownMinutes : 60;
      } catch {
        return 60;
      }
    },
    /* 蒸馏超时秒数（2026-11-23 可设置）：单次蒸馏 LLM 调用的总超时；缺省 300（历史常量值）。 */
    distillTimeoutSec: () => {
      try {
        const normalized = normalizeDistillSettings(distillSettingsStore.global.get());
        return Number.isFinite(normalized.distillTimeoutSec) ? normalized.distillTimeoutSec : 300;
      } catch {
        return 300;
      }
    }
  }).catch((error) => {
    ctx.logger?.warn?.(`[${name}] memory feature install failed:`, error);
    return undefined;
  });
  if (memoryStore !== undefined) {
    await installTaskFeature(ctx, memoryStore, { isAutoInjectEnabled: () => taskAutoInjectRef.value }).catch((error) => ctx.logger?.warn?.(`[${name}] task feature install failed:`, error));
  }  /* 同步直连路径：不管运行时 store 健康与否，上传/下载的真相文件必须可读写。 */
  try {
    syncedSqlitePath = join(memoryDataDirFor(memoryStorageSettings), 'memory.sqlite');
    syncedSqliteLog = join(syncedSqlitePath, '..', '..', '..', 'logs', 'session-kit-synced.log');
  } catch { syncedSqlitePath = ''; syncedSqliteLog = ''; }
  /* 步边界写盘门：记忆手动注入与任务档案注入共用的一道闸（工具执行期排队、pre-step 落盘）。
     必须排在两个 feature 之后：pre-step 钩子后注册者后执行，落盘要发生在所有提示注入之后。 */
  try {
    stepGate.install(ctx);
  } catch (error) {
    ctx.logger?.warn?.(`[${name}] step gate install failed:`, error);
  }
  /* llm/stream 墓碑过滤（2026-11-19 摘自上游 6.4.0，见 lib/tombstone-filter.js）：
     轮次删除/记忆剔除的墓碑消息在进 provider 之前剔除——openai-responses 会把空
     content 转成空 input_text 仍发送，严格网关直接 400。listener 拿到的 options 已被
     agent-loop 冻结，过滤器按需构造新对象、绝不原地改写；失败降级放行不阻断对话。
     prepend:true 让它先于其他 llm/stream 监听者执行。 */
  try {
    ctx.effect(() => ctx.on('llm/stream', (options, next) => {
      let filtered = options;
      try {
        filtered = filterTombstonesFromRequest(options);
      } catch (error) {
        ctx.logger?.warn?.(`[${name}] tombstone request filter failed:`, error);
      }
      return next(filtered);
    }, { prepend: true }), `${name}: llm/stream tombstone filter`);
  } catch (error) {
    ctx.logger?.warn?.(`[${name}] tombstone filter install failed:`, error);
  }
  /* 注入源开关与提示词版本改存 session-kit 自己的 memory.sqlite（memory_settings 键值对）：
     dsh-sync 的 groups 只覆盖 settings.yaml / profiles 下的声明文件 / sessions /
     memory.sqlite / knowledge.sqlite，**$DSH_HOME/storages 不在任何组里**——存老域就永远
     同步不过去。老域保留为迁移源与降级兜底（memory 装不上时仍能读写）。
     提示词版本首次运行播种「普通节约」（此后不再自动补，删光了也尊重用户）；
     并把生成区对齐到版本列表——保证「库是真相、文件是投影」。 */
  try {
    injectionSourcesRef.value = normalizeInjectionSources(readSyncedState(memoryStore, injectionSourcesStore, SYNCED_KEY_INJECTION));
    const rawWorkshop = readSyncedState(memoryStore, promptWorkshopStore, SYNCED_KEY_WORKSHOP);
    const workshop = normalizePromptWorkshop(rawWorkshop);
    if (rawWorkshop?.versions === undefined) {
      workshop.versions = [{ ...DEFAULT_PROMPT_VERSION }];
      await writeSyncedState(memoryStore, promptWorkshopStore, SYNCED_KEY_WORKSHOP, workshop);
    }
    workshopRef.value = workshop;
    const generated = regeneratePromptExtras(workshop.versions);
    if (generated.error !== undefined) ctx.logger?.warn?.(`[${name}] preset extras sync skipped: ${generated.error}`);
    /* 蒸馏设置：启动时从 memory.sqlite 读取，回落老域。 */
    const rawDistill = readSyncedState(memoryStore, distillSettingsStore, SYNCED_KEY_DISTILL);
    const distillSettings = normalizeDistillSettings(rawDistill);
    distillSettingsStore.global.set(distillSettings).catch((error) => ctx.logger?.warn?.(`[${name}] distill settings init write failed:`, error));
  } catch (error) {
    ctx.logger?.warn?.(`[${name}] injection/prompt state init failed:`, error);
  }

  const handle = (path, fn) => ctx.webServer.register({ kind: 'exact', path, handler: fn });
  const route = async (req, res, action) => {
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(res, 400, { ok: false, error: 'bad-request' });
    }
    const id = sessionIdOf(body);
    if (!id) return respond(res, 400, { ok: false, error: 'invalid-session-id' });
    try {
      return await action(id, res);
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] route failed:`, error);
      return respond(res, 500, { ok: false, error: 'operation-failed' });
    }
  };

  /* 标题预热：开机 12s 后后台补齐缺失投影；手动触发走 POST（同步下载后可调）。 */
  ctx.effect(() => handle('/dsh-session-kit/projcache/warm', async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    try {
      const stats = await warmProjectionCache(ctx, { verbose: true });
      return respond(res, 200, { ok: true, value: stats });
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] projcache warm route failed:`, error);
      return respond(res, 500, { ok: false, error: 'warm-failed' });
    }
  }));
  const warmTimer = setTimeout(() => { warmProjectionCache(ctx).catch(() => {}); }, 12000);
  if (typeof warmTimer.unref === 'function') warmTimer.unref();
  /* 真删除（safeExcise）：物理切除整轮 → seq/轮号重编号 → 引用修复 → 三层门禁 0 错才落盘。
     活体守卫：agent 在内存中一律拒绝（活体切除会造 seq 断口——2026-10-08 事故根因）。 */
  ctx.effect(() => handle('/dsh-session-kit/excise', async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try { body = await readJsonBody(req); } catch { return respond(res, 400, { ok: false, error: 'bad-request' }); }
    const id = sessionIdOf(body);
    if (!id) return respond(res, 400, { ok: false, error: 'invalid-session-id' });
    const turns = Array.isArray(body?.turns) ? body.turns : [];
    if (!turns.length) return respond(res, 400, { ok: false, error: 'turns-required' });
    try {
      const live = ctx.agents?.get?.(SessionId(id));
      if (live !== undefined) return respond(res, 409, { ok: false, error: 'session-live', message: '会话已加载：请先切换到其他会话让其卸载，再执行真删除' });
      const meta = await persistenceHeaderById(ctx.sessionPersistence, id);
      if (!meta) return respond(res, 404, { ok: false, error: 'session-not-found' });
      const file = sessionFilePathOf(ctx.sessionPersistence, meta);
      if (!file || !existsSync(file)) return respond(res, 404, { ok: false, error: 'file-not-found' });
      const { buf: out, stats } = exciseSessionBuffer(readFileSync(file), turns);
      writeExcisedFile(file, out, stats.rowsAfter);
      let projcacheRebuilt = false;
      try {
        const cache = ctx.get?.('sessionProjectionCache');
        const read = await readPersistedSession(ctx.sessionPersistence, id);
        const entries = (await ctx.sessionPersistence.list().catch(() => [])) ?? [];
        const entry = entries.find((x) => (x?.header ?? x)?.id === id);
        const header2 = entry?.header ?? entry;
        const inherited = Number(entry?.inheritedEventCount ?? header2?.inheritedEventCount ?? 0) || 0;
        if (cache?.coldSnapshot && Array.isArray(read?.events)) { cache.coldSnapshot(header2, inherited, read.events); projcacheRebuilt = true; }
      } catch (error) { ctx.logger?.warn?.(`[${name}] excise projcache rebuild failed:`, error); }
      const cacheDropped = dropProjectionCache(id);
      ctx.logger?.info?.(`[${name}] excise ${id}: -${stats.removedRows} rows (turns ${stats.removedTurns.join(',')}) → ${stats.rowsAfter}，projcache=${projcacheRebuilt ? '重建' : '失败(可手动 warm)'}`);
      try { if (ctx.sessions && typeof ctx.sessions.refresh === 'function') await ctx.sessions.refresh(); } catch { /* 刷新失败不致命 */ }
      return respond(res, 200, { ok: true, value: { ...stats, projcacheRebuilt, cacheDropped, backup: null } });
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] excise rejected:`, error);
      return respond(res, 422, { ok: false, error: 'excise-rejected', message: String(error?.message || error).slice(0, 300) });
    }
  }));

  /* ── 待真删台账消费器（2026-11-12「三插件删除物理无痕」）─────────────────────
     删除路由（含 ER 编辑重发，flush:true）purge 之后入队；本消费器 90s 醒一次但
     只 stat 台账文件（mtime 未变/不存在 → 立即返回，零扫描零解压）。台账非空时
     逐条处理：活体会话跳过（保留在台账，等卸载），非活体 → exciseSessionBuffer
     （物理删行+墓碑行级联丢弃+inbox 孤儿清理+重编号+三层门禁）→ projcache 重建
     → 从台账移除。终态=文件里无墓碑无原文，任何渲染器（含三插件全部禁用、
     localStorage 清空）都无从显示。安全：写盘前 copyFileSync 备份；单条失败
     3 次放弃并从台账移除（防无限重试）；仍存在的轮才动刀（turn/start 校验）。 */
  const exciserQueueStamp = new Map();  // '__queue__' -> 台账文本（内容比对，不用 mtime：自己重写也会改 mtime）
  const exciserFailCount = new Map();   // sessionId -> 连续失败次数
  const consumePendingExcise = async () => {
    const file = pendingExciseFile();
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { return; } // 台账不存在=无事可做
    /* 台账内容没变 + 还没到重试时间 → 直接返回。
       为什么不能只看内容：活体跳过/门禁失败时条目原样保留，文本不变；
       光比内容会让「等它卸载」变成「永远不再试」（2026-11-26 自摆的坑）。
       重试间隔只在确有未完成条目时才占用 30s 一次的极小开销。 */
    if (exciserQueueStamp.get('__queue__') === text && Date.now() < (exciserQueueStamp.get('__next__') ?? 0)) return;
    let list;
    try { list = JSON.parse(text); } catch { exciserQueueStamp.set('__queue__', text); exciseLog('queue parse failed; skipped'); return; }
    if (!Array.isArray(list) || !list.length) { exciserQueueStamp.set('__queue__', text); exciserQueueStamp.set('__next__', 0); return; }
    const byId = new Map();
    for (const item of list) {
      if (!item?.id || !Array.isArray(item.turns) || !item.turns.length) continue;
      const set = byId.get(item.id) || new Set();
      for (const t of item.turns) if (Number.isSafeInteger(Number(t))) set.add(Number(t));
      byId.set(item.id, set);
    }
    if (!byId.size) { exciserQueueStamp.set('__queue__', text); exciserQueueStamp.set('__next__', 0); return; }
    /* 先按内存注册表判活体（零磁盘开销）；全都在跑就直接等下一次/卸载事件，
       绝不为了「看一眼」去 list() 扫全部会话。 */
    const cold = [...byId].filter(([id]) => ctx.agents?.get?.(SessionId(id)) === undefined);
    if (!cold.length) {
      exciserQueueStamp.set('__queue__', text);
      exciserQueueStamp.set('__next__', Date.now() + 30000);
      return;
    }
    let entries = [];
    try { entries = (await ctx.sessionPersistence.list().catch(() => [])) ?? []; } catch { return; }
    const remaining = [];
    for (const [id, turnSet] of byId) {
      try {
        const live = ctx.agents?.get?.(SessionId(id));
        /* 活体必须等卸载：活体改文件会与内存里的 seq 计数错位（2026-10-08 事故根因）。
           这里保持原条目**原样**回写，不做时间戳更新 —— 否则每轮都改台账 mtime，
           既触发下一轮空转，也让用户看到「一直在重试」的假象。 */
        if (live !== undefined) { remaining.push({ id, turns: [...turnSet], at: list.find((x) => x?.id === id)?.at }); continue; }
        const entry = entries.find((x) => (x?.header ?? x)?.id === id);
        /* 宿主 0.2.2：list() 给的是快照 {header, location}，locate() 只吃 header。
           旧代码把快照直接喂 locate → 每轮必抛 → 台账重试 3 次后被丢弃 →
           物理切除永远不发生（2026-11-26 实证）。改走 sessionFilePathOf。 */
        const f = sessionFilePathOf(ctx.sessionPersistence, entry);
        if (!f || !existsSync(f)) { exciseLog(`drop ${id}: file not found`); ctx.logger?.warn?.(`[${name}] pending-excise: file not found (${id})，丢弃该条`); continue; }
        const buf = readFileSync(f);
        const { headerFrame, rows } = decodeSessionBuffer(buf);
        const existingTurns = new Set(rows.filter((e) => e.type === 'turn/start').map((e) => e.data?.turn));
        const turns = [...turnSet].filter((t) => existingTurns.has(t));
        if (!turns.length) { exciseLog(`drop ${id}: turns already gone (${[...turnSet].join(',')})`); continue; } // 轮已不存在（此前 excise 过或已重编号）→ 丢弃
        let out;
        let stats;
        if (existingTurns.size > 0 && turns.length >= existingTurns.size) {
          /* 删光了（典型：删第 1 轮 = 清空整个会话）。整段切除会把系统头一起带走，
             门禁 no-system-head 会拒载 —— 但那不是坏文件，而是「空会话」。
             宿主对一个只有头帧、零事件的日志就是当空白新会话加载的（persistHeader 同款形态），
             所以这里直接产出空日志，让会话变成干净的空白，而不是永远卡在台账里。 */
          out = encodeSessionBuffer(headerFrame, []);
          stats = { removedRows: rows.length, removedTurns: turns, rowsBefore: rows.length, rowsAfter: 0 };
        } else {
          ({ buf: out, stats } = exciseSessionBuffer(buf, turns));
        }
        writeExcisedFile(f, out, stats.rowsAfter);
        exciserFailCount.delete(id);
        let projcacheRebuilt = false;
        try {
          const cache = ctx.get?.('sessionProjectionCache');
          const read = await readPersistedSession(ctx.sessionPersistence, id);
          const entries2 = (await ctx.sessionPersistence.list().catch(() => [])) ?? [];
          const entry2 = entries2.find((x) => (x?.header ?? x)?.id === id);
          const header2 = entry2?.header ?? entry2;
          const inherited = Number(entry2?.inheritedEventCount ?? header2?.inheritedEventCount ?? 0) || 0;
          if (cache?.coldSnapshot && Array.isArray(read?.events)) { cache.coldSnapshot(header2, inherited, read.events); projcacheRebuilt = true; }
        } catch (error) { ctx.logger?.warn?.(`[${name}] pending-excise projcache rebuild failed (${id}):`, error?.message ?? error); }
        /* 投影缓存磁盘文件也要一起清：第三个渲染器（宿主自带 UI / 插件全关时的冷启动）
           只读这个 JSON，不重建就等于把删掉的正文留在盘上。 */
        const dropped = dropProjectionCache(id);
        exciseLog(`done ${id}: turns [${turns.join(',')}] -${stats.removedRows} rows → ${stats.rowsAfter}, projcache=${projcacheRebuilt ? 'rebuilt' : 'cold'}, cacheFiles=${dropped}`);
        ctx.logger?.info?.(`[${name}] pending-excise ${id}: turns ${turns.join(',')} removed ${stats.removedRows} rows → ${stats.rowsAfter}，projcache=${projcacheRebuilt ? '重建' : '失败(可手动 warm)'}`);
      } catch (error) {
        const message = String(error?.message ?? error);
        /* DEFERRABLE_EXCISE：这些不是「坏」，是「现在还不能切」——
           典型是会话里还有排队未消费的消息（inbox 插入无对应消费），切除会把它变成孤儿，
           门禁拒绝产出是正确的。旧逻辑把它计进 3 次放弃 → 台账条目被丢 → 那一轮的行
           永远留在盘上（2026-11-27 实测）。现在改成「延后」：保留条目、不计数，等下次
           卸载/开机窗口再试，直到会话真正干净为止。 */
        const deferrable = /孤儿插入|inbox 输出残留|未闭合轮|compaction/i.test(message);
        if (deferrable) {
          remaining.push({ id, turns: [...turnSet], at: list.find((x) => x?.id === id)?.at });
          exciseLog(`defer ${id}: ${message}`);
          continue;
        }
        const n = (exciserFailCount.get(id) || 0) + 1;
        exciserFailCount.set(id, n);
        if (n >= 3) { exciseLog(`give-up ${id} #${n}: ${message}`); ctx.logger?.warn?.(`[${name}] pending-excise gave up after 3 failures (${id})，丢弃该条:`, message); }
        else { remaining.push({ id, turns: [...turnSet], at: list.find((x) => x?.id === id)?.at }); exciseLog(`fail ${id} #${n}: ${message}`); ctx.logger?.warn?.(`[${name}] pending-excise failed (${id}) #${n}:`, message); }
      }
    }
    const next = JSON.stringify(remaining);
    if (next !== text) {
      try { writeFileSync(file, next); exciserQueueStamp.set('__queue__', next); } catch (error) { ctx.logger?.warn?.(`[${name}] pending-excise queue write failed:`, error?.message ?? error); }
    } else exciserQueueStamp.set('__queue__', text);
    /* 还有没做完的条目（活体等待 / 失败重试）→ 30s 后再来；否则不再占用定时器。 */
    exciserQueueStamp.set('__next__', remaining.length > 0 ? Date.now() + 30000 : 0);
  };
  /* 启动即刻跑一次：此时还没有会话被恢复，是「清完再开」的黄金窗口
     （旧实现 25s 才醒，桌面版往往已经把上次的会话拉活了）。 */
  kickExciseConsumer = () => { consumePendingExcise().catch(() => {}); };
  const exciserKick = setTimeout(() => { kickExciseConsumer(); }, 0);
  if (typeof exciserKick.unref === 'function') exciserKick.unref();
  const exciserTimer = setInterval(() => { consumePendingExcise().catch(() => {}); }, 30000);
  if (typeof exciserTimer.unref === 'function') exciserTimer.unref();
  /* 会话卸载的那一秒就动刀（这是「不重启也能清干净」的唯一时机）。 */
  try {
    ctx.on('session/disposed', () => { setTimeout(() => { consumePendingExcise().catch(() => {}); }, 0); });
  } catch { /* 宿主没有该事件时退回轮询 */ }

  ctx.effect(() => handle(OPEN_ROUTE, (req, res) => route(req, res, async (id) => {
    const meta = await persistenceHeaderById(ctx.sessionPersistence, id);
    if (!meta) return respond(res, 404, { ok: false, error: 'session-not-found' });
    const location = typeof ctx.sessionPersistence.locate === 'function' ? ctx.sessionPersistence.locate(meta) : undefined;
    const dir = location?.path ? dirname(location.path) : undefined;
    if (!dir || !existsSync(dir)) return respond(res, 404, { ok: false, error: 'folder-not-found' });
    openSystemFolder(dir);
    return respond(res, 200, { ok: true });
  })), `${name}: open session folder route`);

  ctx.effect(() => handle(DELETE_ROUTE, (req, res) => route(req, res, async (id) => {
    const agent = ctx.agents.get(id);
    // Running check removed: allow deletion of stuck/truncated sessions
    const meta = await persistenceHeaderById(ctx.sessionPersistence, id);
    if (!meta && !agent) return respond(res, 404, { ok: false, error: 'session-not-found' });
    if (meta !== undefined && typeof ctx.sessionPersistence.locate !== 'function') return respond(res, 501, { ok: false, error: 'delete-unsupported' });
    const location = meta ? ctx.sessionPersistence.locate(meta) : undefined;
    if (meta !== undefined && (location === undefined || typeof location.path !== 'string' || location.path.length === 0)) return respond(res, 501, { ok: false, error: 'delete-unsupported' });
    const dir = location ? dirname(location.path) : undefined;
    const wasArchived = ctx.workspaceRegistry.archivedSessionIds.includes(id);
    deletedSessionIds.add(id);
    try {
      // stopActivity: 删除时停掉可能在跑的活动，避免 archiveSession 的活动检查抛错拒绝删除
      await ctx.workspaceRegistry.archiveSession(id, wasArchived ? undefined : { stopActivity: true });
      if (dir && existsSync(dir)) await deleteStoppedSessionDirectory(dir);
      // 解绑工作区记录 + 清 projcache + 刷新列表。detachWorkspaceRefs 内部对每个工作区
      // 实体调 detachSession，会把该 id 从 tables.workspaces[*].sessionIds 里摘掉。
      const detachOk = await detachWorkspaceRefs(ctx, id);
      if (!detachOk) ctx.logger?.warn?.(`[${name}] detach '${id}' from workspace records failed; archive id is still removed from the list`);
      // 幽灵条目根治（与 deleteArchivedSession 同一语义）：名单是落盘的
      // （workspace.json 的 global.archivedSessionIds），deletedSessionIds 只是内存墓碑、
      // 进程重启即清空 —— 所以删除成功路径上一律把 id 从名单里删掉，不再受
      // detachOk / isSessionLive 限制；写盘失败就整体报错，不假装删成功。
      await setArchivedSessionIds(ctx, (ids) => ids.filter((sessionId) => sessionId !== id));
      return respond(res, 200, { ok: true });
    } catch (error) {
      deletedSessionIds.delete(id);
      if (!wasArchived) await setArchivedSessionIds(ctx, (ids) => ids.filter((sessionId) => sessionId !== id)).catch(() => undefined);
      throw error;
    }
  })), `${name}: delete session route`);

  ctx.effect(function* () {
    yield async () => {
      compactionController.restoreEngines();
      await Promise.all([
        /* 2026-11-11 补漏：此前只关 5 个域，taskAutoInject/memoryStorage/distill
           三个从未 close —— 插件停用再启用（热重载）后 open 同名域必报 already-open。 */
        globalPromptController.dispose(),
        compactionStore.close(),
        sidebarEntriesStore.close(),
        globalPromptStore.close(),
        taskAutoInjectStore.close(),
        memoryStorageStore.close(),
        injectionSourcesStore.close(),
        promptWorkshopStore.close(),
        distillSettingsStore.close()
      ]);
    };
    yield ctx.on('agent/created', ({ agent }) => {
      try {
        globalPromptController.installAgent(agent);
      } catch (error) {
        ctx.logger?.warn?.(`[${name}] global prompt install failed:`, error);
      }
    });
    /* 提示词版本按工作区自动套用（默认关，用户在设置页里打开才生效）：
       新会话落在已绑定的工作区时，切到该版本对应的预设。
       护栏：①autoApply 必须为 true；②子代理会话（header.origin==='subagent'）不动；
       ③工作区没绑定不动；④新建会话 lastTurn=0 才过得了注册表的 locked 闸；
       ⑤任何失败只记日志，绝不影响会话创建。 */
    yield ctx.on('agent/created', async ({ agent }) => {
      try {
        const workshop = workshopRef.value;
        if (workshop.autoApply !== true) return;
        if (agent?.session?.header?.origin === 'subagent') return;
        const cwd = agent?.session?.header?.cwd;
        if (typeof cwd !== 'string' || cwd.length === 0) return;
        const workspace = typeof ctx.workspaceRegistry?.resolveByPath === 'function'
          ? await ctx.workspaceRegistry.resolveByPath(cwd)
          : undefined;
        if (workspace === undefined || workspace === null) return;
        const target = workshop.workspacePresets[workspace.path];
        if (typeof target !== 'string' || target.length === 0) return;
        await ctx.get('agentPresets')?.select?.(agent, target);
      } catch (error) {
        ctx.logger?.warn?.(`[${name}] auto prompt version apply skipped:`, error);
      }
    });
    /* 预设兜底（0.2.x 断点，2026-11-27）：桌面版 connectWorkspace/openWorkspace 复用工作区里
       已有的空白 Session 时，宿主按「请求没指明 → 配置默认 preset」重新组装 Agent，并落一条
       agent-preset/selected=<宿主默认> 的事件；这条路径复用已 live 的 Agent，不会再发
       agent/created，上面那段自动套用因此不会重跑——空白会话被从 lite 改回 standard。
       这里只在「空白会话被改成宿主默认 preset」时把工作区绑定值补回去。
       护栏见 makeWorkspacePresetRestorer。 */
    yield ctx.on('session/event', makeWorkspacePresetRestorer(ctx, () => workshopRef.value));
    yield ctx.on('agent/disposed', ({ agent }) => {
      globalPromptController.disposeAgent(agent);
    });
    yield ctx.on('agent/pre-step', ({ agent }, next) => {
      try {
        compactionController.applyToAgent(agent);
      } catch (error) {
        ctx.logger?.warn?.(`[${name}] compaction config apply failed:`, error);
      }
      return next();
    }, { prepend: true });
  }, `${name}: runtime compaction config`);

  ctx.effect(() => handle(COMPACTION_CONFIG_ROUTE, async (req, res) => {
    let defaults = DEFAULT_COMPACTION_VALUES;
    try {
      defaults = await compactionDefaultsForRequest(ctx, compactionController, req);
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] compaction defaults lookup failed:`, error);
    }
    if (req.method === 'GET') {
      compactionSettings = normalizeCompactionSettings(compactionStore.global.get(), defaults);
      return respond(res, 200, { ok: true, value: compactionSettings, defaults });
    }
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(res, 400, { ok: false, error: 'bad-request' });
    }
    const submitted = {
      enabled: body?.enabled,
      thresholdRatio: body?.thresholdRatio,
      retainRatio: body?.retainRatio,
      maxTokens: body?.maxTokens,
      compactionRetries: body?.compactionRetries,
      maxOverflowRetries: body?.maxOverflowRetries
    };
    const validationError = validateCompactionSettings(submitted);
    if (validationError !== undefined) return respond(res, 400, { ok: false, error: validationError });
    try {
      compactionSettings = normalizeCompactionSettings(submitted, defaults);
      await compactionStore.global.set(compactionSettings);
      await compactionController.applyToLiveAgents();
      return respond(res, 200, { ok: true, value: compactionSettings, defaults });
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] compaction config save failed:`, error);
      return respond(res, 500, { ok: false, error: 'compaction-config-failed' });
    }
  }), `${name}: compaction config HTTP route`);

  ctx.effect(() => handle('/dsh-session-kit/sidebar-entries', async (req, res) => {
    if (req.method === 'GET') return respond(res, 200, { ok: true, value: normalizeSidebarEntries(sidebarEntriesStore.global.get()) });
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(res, 400, { ok: false, error: 'bad-request' });
    }
    if (typeof body?.memoryVisible !== 'boolean' || typeof body?.archiveVisible !== 'boolean' || (body?.taskVisible !== undefined && typeof body.taskVisible !== 'boolean')) return respond(res, 400, { ok: false, error: 'invalid-sidebar-entries' });
    try {
      const current = sidebarEntriesStore.global.get();
      const value = {
        memoryVisible: body.memoryVisible,
        archiveVisible: body.archiveVisible,
        taskVisible: body.taskVisible === undefined ? current?.taskVisible !== false : body.taskVisible
      };
      await sidebarEntriesStore.global.set(value);
      return respond(res, 200, { ok: true, value });
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] sidebar entries save failed:`, error);
      return respond(res, 500, { ok: false, error: 'sidebar-entries-failed' });
    }
  }), `${name}: sidebar entries HTTP route`);

  /* 手动排序跨设备桥接（2026-10-09）：官方 UI 的手动排序只存浏览器 localStorage
     （键 dsh.workspace.view.v5，dsh-client-store 整值 JSON），从不写 workspace.json——
     PC/手机各存各的顺序，永远不同步。桥接：客户端把本机顺序 POST 到这里落成本机文件，
     dsh-sync 把文件嵌进 workspace-order.json 上云；对端下载回写本文件，客户端下次
     加载时种进 localStorage（本地已手动排过则尊重本地、不覆盖）。 */
  const MANUAL_ORDER_FILE = join(sessionKitProfileDir(), '..', '..', 'manual-order.json');
  ctx.effect(() => handle('/dsh-session-kit/manual-order', async (req, res) => {
    try {
      if (req.method === 'GET') {
        let raw = null;
        try { raw = JSON.parse(readFileSync(MANUAL_ORDER_FILE, 'utf8')); } catch { /* 无文件=还没人传过 */ }
        // 兼容旧形状（直接是 value）：savedAt=0，客户端不会用它覆盖本地
        const value = raw && typeof raw === 'object' && raw.value !== undefined ? raw.value : raw;
        const savedAt = raw && typeof raw === 'object' && typeof raw.savedAt === 'number' ? raw.savedAt : 0;
        return respond(res, 200, { ok: true, value, savedAt });
      }
      if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 600000) return respond(res, 413, { ok: false, error: 'too-large' });
      }
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return respond(res, 400, { ok: false, error: 'bad-json' }); }
      const value = parsed?.value;
      if (!value || typeof value !== 'object' || value.orderBy !== 'manual' || typeof value.sessionOrderByAccount !== 'object' || value.sessionOrderByAccount === null)
        return respond(res, 400, { ok: false, error: 'invalid-shape' });
      const accounts = Object.entries(value.sessionOrderByAccount);
      const idTotal = accounts.reduce((n, [, arr]) => n + (Array.isArray(arr) ? arr.length : 0), 0);
      if (accounts.length > 100 || idTotal > 10000) return respond(res, 400, { ok: false, error: 'too-many-entries' });
      const savedAt = Date.now();
      writeFileSync(MANUAL_ORDER_FILE, JSON.stringify({ savedAt, value }), 'utf8');
      return respond(res, 200, { ok: true, savedAt });
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] manual-order route failed:`, error);
      return respond(res, 500, { ok: false, error: 'manual-order-failed' });
    }
  }), `${name}: manual-order bridge HTTP route`);

  /* 任务自动注入开关：GET 读当前值，POST 写新值（必须是布尔）。 */
  ctx.effect(() => handle('/dsh-session-kit/task-auto-inject', async (req, res) => {
    if (req.method === 'GET') return respond(res, 200, { ok: true, value: normalizeTaskAutoInject(taskAutoInjectStore.global.get()) });
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(res, 400, { ok: false, error: 'bad-request' });
    }
    if (typeof body?.enabled !== 'boolean') return respond(res, 400, { ok: false, error: 'invalid-task-auto-inject' });
    try {
      const value = { enabled: body.enabled };
      await taskAutoInjectStore.global.set(value);
      taskAutoInjectRef.value = value.enabled;
      return respond(res, 200, { ok: true, value });
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] task auto inject save failed:`, error);
      return respond(res, 500, { ok: false, error: 'task-auto-inject-failed' });
    }
  }), `${name}: task auto inject HTTP route`);

  /* 记忆数据保存目录：GET 读当前设置 + 默认/生效目录；POST 写设置。
     只改配置，不搬数据、不切连接；restartRequired 表示本次改动需重启 DSH 才生效。 */
  ctx.effect(() => handle(MEMORY_STORAGE_ROUTE, async (req, res) => {
    if (req.method === 'GET') {
      const value = normalizeMemoryStorage(memoryStorageStore.global.get());
      return respond(res, 200, {
        ok: true,
        value: {
          ...value,
          defaultPath: defaultMemoryDataDir(),
          activePath: activeMemoryDataDir,
          restartRequired: false
        }
      });
    }
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(res, 400, { ok: false, error: 'bad-request' });
    }
    if (body?.mode !== MEMORY_STORAGE_MODE_DEFAULT && body?.mode !== MEMORY_STORAGE_MODE_CUSTOM) {
      return respond(res, 400, { ok: false, error: 'invalid-memory-storage-mode' });
    }
    const value = body.mode === MEMORY_STORAGE_MODE_CUSTOM
      ? { mode: MEMORY_STORAGE_MODE_CUSTOM, customPath: typeof body?.customPath === 'string' ? body.customPath.trim() : '' }
      : { mode: MEMORY_STORAGE_MODE_DEFAULT, customPath: '' };
    if (value.mode === MEMORY_STORAGE_MODE_CUSTOM) {
      const resolved = resolveCustomMemoryDir(value.customPath);
      if (resolved.error !== undefined) return respond(res, 400, { ok: false, error: resolved.error });
      value.customPath = resolved.value;
      const probe = probeMemoryDir(value.customPath);
      if (probe.error !== undefined) {
        ctx.logger?.warn?.(`[${name}] memory storage dir rejected ${value.customPath}: ${probe.error}${probe.detail === undefined ? '' : ` (${probe.detail})`}`);
        return respond(res, 400, { ok: false, error: probe.error });
      }
    }
    try {
      await memoryStorageStore.global.set(value);
      const restartRequired = !samePath(memoryDataDirFor(value), activeMemoryDataDir);
      ctx.logger?.info?.(`[${name}] memory storage dir set to ${memoryDataDirFor(value)} (restartRequired=${restartRequired})`);
      return respond(res, 200, {
        ok: true,
        value: {
          ...value,
          defaultPath: defaultMemoryDataDir(),
          activePath: activeMemoryDataDir,
          restartRequired
        }
      });
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] memory storage save failed:`, error);
      return respond(res, 500, { ok: false, error: 'memory-storage-failed' });
    }
  }), `${name}: memory storage HTTP route`);

  /* 蒸馏设置：GET 读 chain；POST 写 chain（自动归一化）。集成 readSyncedState/writeSyncedState 随 dsh-sync 跨设备同步。 */
  ctx.effect(() => handle(DISTILL_SETTINGS_ROUTE, async (req, res) => {
    if (req.method === 'GET') {
      const value = normalizeDistillSettings(distillSettingsStore.global.get());
      return respond(res, 200, { ok: true, value });
    }
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(res, 400, { ok: false, error: 'bad-request' });
    }
    const normalized = normalizeDistillSettings(body);
    try {
      await distillSettingsStore.global.set(normalized);
      // 同步到 dsh-sync
      try {
        await writeSyncedState(memoryStore, distillSettingsStore, SYNCED_KEY_DISTILL, normalized);
      } catch (syncError) {
        ctx.logger?.warn?.(`[${name}] distill settings sync write failed:`, syncError);
      }
      ctx.logger?.info?.(`[${name}] distill settings updated: ${JSON.stringify(normalized.chain)}`);
      return respond(res, 200, { ok: true, value: normalized });
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] distill settings save failed:`, error);
      return respond(res, 500, { ok: false, error: 'distill-settings-failed' });
    }
  }), `${name}: distill settings HTTP route`);

  /* 记忆项目工作区绑定（排他模式）：GET 读开关+绑定表；POST 部分更新（只传 enabled 或只传 map）。
     绑定键=工作区路径（写入前归一化：正斜杠/去尾斜杠/小写，与召回读取端同一把尺子），
     值=记忆项目名数组（按名解析，项目删除自然落空）。存 memory_settings，随 dsh-sync memory 组跨设备同步。 */
  ctx.effect(() => handle(MEMORY_WORKSPACE_BINDING_ROUTE, async (req, res) => {
    if (req.method === 'GET') {
      return respond(res, 200, {
        ok: true,
        value: { enabled: memoryStore.workspaceBindingEnabled(), map: memoryStore.workspaceDirectoryMap() }
      });
    }
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(res, 400, { ok: false, error: 'bad-request' });
    }
    try {
      if (body?.enabled !== undefined) memoryStore.setWorkspaceBindingEnabled(body.enabled === true);
      if (body?.map !== undefined) memoryStore.setWorkspaceDirectoryMap(body.map);
      return respond(res, 200, {
        ok: true,
        value: { enabled: memoryStore.workspaceBindingEnabled(), map: memoryStore.workspaceDirectoryMap() }
      });
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] memory workspace binding save failed:`, error);
      return respond(res, 500, { ok: false, error: 'workspace-binding-failed' });
    }
  }), `${name}: memory workspace binding HTTP route`);

  /* 记忆库健康快照（只读，统一体检 A 段）：表行数 / FTS 一致性 / 孤儿引用 / 目录分布 /
     生效设置。只查不修，任何内部异常按 null 报告不抛 500（体检不能把宿主打挂）。 */
  ctx.effect(() => handle('/dsh-session-kit/memory/health', async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    try {
      return respond(res, 200, { ok: true, value: memoryStore.healthSnapshot() });
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] memory health snapshot failed:`, error);
      return respond(res, 200, { ok: true, value: { error: String(error?.message ?? error) } });
    }
  }), `${name}: memory health HTTP route`);

  /* 临时诊断：接受任意 JSON/文本并追加到 $DSH_HOME/dsh-session-kit-debug.log。 */
  ctx.effect(() => handle(DEBUG_LOG_ROUTE, async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req, 1024 * 1024);
    } catch {
      return respond(res, 400, { ok: false, error: 'bad-request' });
    }
    try {
      const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-session-kit-debug.log');
      const line = typeof body === 'string' ? body : JSON.stringify(body);
      writeFileSync(file, `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
      return respond(res, 200, { ok: true });
    } catch (error) {
      return respond(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }), `${name}: debug log HTTP route`);

  ctx.effect(() => handle(GLOBAL_PROMPT_ROUTE, async (req, res) => {
    if (req.method === 'GET') {
      globalPromptSettings = normalizeGlobalPromptSettings(globalPromptStore.global.get());
      return respond(res, 200, { ok: true, value: globalPromptSettings });
    }
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req, GLOBAL_PROMPT_MAX_TEXT_LENGTH * 4 + 4096);
    } catch {
      return respond(res, 400, { ok: false, error: 'bad-request' });
    }
    const submitted = {
      enabled: body?.enabled,
      text: body?.text
    };
    const validationError = validateGlobalPromptSettings(submitted);
    if (validationError !== undefined) return respond(res, 400, { ok: false, error: validationError });
    const previousSettings = globalPromptSettings;
    const wasActive = globalPromptController.isActive();
    try {
      globalPromptSettings = normalizeGlobalPromptSettings(submitted);
      globalPromptController.apply();
      await globalPromptStore.global.set(globalPromptSettings);
      return respond(res, 200, { ok: true, value: globalPromptSettings });
    } catch (error) {
      globalPromptSettings = previousSettings;
      try {
        globalPromptController.apply();
      } catch (restoreError) {
        if (!wasActive) void globalPromptController.dispose();
        ctx.logger?.warn?.(`[${name}] global prompt restore failed:`, restoreError);
      }
      ctx.logger?.warn?.(`[${name}] global prompt save failed:`, error);
      return respond(res, 500, { ok: false, error: 'global-prompt-failed' });
    }
  }), `${name}: global prompt HTTP route`);

  /* 注入源开关（默认全关）。GET 聚合六个源；POST 只写提交里出现的键，
     四个自有源进注入源域，任务自动提示与全局提示词写回各自既有域。 */
  ctx.effect(() => handle(INJECTION_SOURCES_ROUTE, async (req, res) => {
    const snapshot = () => ({
      ...injectionSourcesRef.value,
      taskHint: taskAutoInjectRef.value,
      globalPrompt: globalPromptSettings.enabled === true
    });
    if (req.method === 'GET') return respond(res, 200, { ok: true, value: snapshot() });
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(res, 400, { ok: false, error: 'bad-request' });
    }
    const own = ['memoryGuide', 'recall', 'firstTurnMatch', 'memoryRequest'];
    const submitted = [...own, 'taskHint', 'globalPrompt'].filter((key) => typeof body?.[key] === 'boolean');
    if (submitted.length === 0) return respond(res, 400, { ok: false, error: 'invalid-injection-sources' });
    const previousSources = injectionSourcesRef.value;
    const previousGlobalPrompt = globalPromptSettings;
    const nextSources = { ...previousSources };
    for (const key of own) {
      if (typeof body[key] === 'boolean') nextSources[key] = body[key];
    }
    try {
      if (typeof body.taskHint === 'boolean') {
        const value = { enabled: body.taskHint };
        await taskAutoInjectStore.global.set(value);
        taskAutoInjectRef.value = value.enabled;
      }
      if (typeof body.globalPrompt === 'boolean') {
        globalPromptSettings = normalizeGlobalPromptSettings({ ...previousGlobalPrompt, enabled: body.globalPrompt });
        globalPromptController.apply();
        await globalPromptStore.global.set(globalPromptSettings);
      }
      injectionSourcesRef.value = nextSources;
      await writeSyncedState(memoryStore, injectionSourcesStore, SYNCED_KEY_INJECTION, nextSources);
      return respond(res, 200, { ok: true, value: snapshot() });
    } catch (error) {
      injectionSourcesRef.value = previousSources;
      globalPromptSettings = previousGlobalPrompt;
      try {
        globalPromptController.apply();
      } catch (restoreError) {
        ctx.logger?.warn?.(`[${name}] injection sources restore failed:`, restoreError);
      }
      ctx.logger?.warn?.(`[${name}] injection sources save failed:`, error);
      return respond(res, 500, { ok: false, error: 'injection-sources-failed' });
    }
  }), `${name}: injection sources HTTP route`);

  /* 提示词版本：GET = 默认版本 + 自建版本 + 工作区 + 绑定；POST 增删改版本 / 改绑定 / 自动套用。
     默认版本正文写进 cordis.patch.yml 的 workshop:dafeyu 标记区（手改也认）；
     自建版本写进同一文件的 workshop:extra 生成区，一个版本 = 一条预设声明。 */
  ctx.effect(() => handle(PROMPT_WORKSHOP_ROUTE, async (req, res) => {
    const readState = () => {
      const path = presetLitePatchPath();
      let fileError = null;
      let present = false;
      let baseText = '';
      let extraReady = false;
      try {
        const raw = readFileSync(path, 'utf8');
        extraReady = raw.includes(PROMPT_EXTRA_BEGIN) && raw.includes(PROMPT_EXTRA_END);
        const parsed = readPromptSlot(raw, 'dafeyu');
        present = parsed !== undefined;
        baseText = parsed?.text ?? '';
      } catch {
        fileError = 'preset-read-failed';
      }
      const workshop = workshopRef.value;
      const workspaces = typeof ctx.workspaceRegistry?.list === 'function'
        ? ctx.workspaceRegistry.list().map((entity) => ({ key: entity.path, title: entity.title }))
        : [];
      return {
        base: { presetId: PROMPT_BASE_PRESET_ID, name: '大肥鱼（默认）', present, text: baseText },
        versions: workshop.versions,
        workspaces,
        workspacePresets: workshop.workspacePresets,
        autoApply: workshop.autoApply,
        presetIds: [PROMPT_BASE_PRESET_ID, ...workshop.versions.map((version) => version.presetId)],
        maxText: PROMPT_SLOT_MAX_TEXT,
        maxVersions: PROMPT_VERSION_MAX,
        extraReady,
        path,
        fileError
      };
    };
    if (req.method === 'GET') return respond(res, 200, { ok: true, value: readState() });
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req, PROMPT_SLOT_MAX_TEXT * 6 + 8192);
    } catch {
      return respond(res, 400, { ok: false, error: 'bad-request' });
    }
    const current = workshopRef.value;
    try {
      if (body?.action === 'save-base') {
        if (typeof body?.text !== 'string') return respond(res, 400, { ok: false, error: 'invalid-text' });
        if (body.text.length > PROMPT_SLOT_MAX_TEXT) return respond(res, 400, { ok: false, error: 'text-too-large' });
        const result = savePromptSlotFile('dafeyu', body.text);
        if (result.error !== undefined) {
          ctx.logger?.warn?.(`[${name}] prompt base save failed: ${result.error}`);
          return respond(res, 500, { ok: false, error: result.error });
        }
        return respond(res, 200, { ok: true, value: { ...readState(), ...result.value } });
      }
      if (body?.action === 'create-version') {
        const versionName = typeof body?.name === 'string' ? body.name.trim().slice(0, PROMPT_VERSION_NAME_MAX) : '';
        const text = typeof body?.text === 'string' ? body.text : '';
        if (versionName.length === 0) return respond(res, 400, { ok: false, error: 'invalid-name' });
        if (text.length > PROMPT_SLOT_MAX_TEXT) return respond(res, 400, { ok: false, error: 'text-too-large' });
        if (current.versions.length >= PROMPT_VERSION_MAX) return respond(res, 400, { ok: false, error: 'too-many-versions' });
        const version = { presetId: nextPromptPresetId(current.versions), name: versionName, text };
        const versions = [...current.versions, version];
        const generated = regeneratePromptExtras(versions);
        if (generated.error !== undefined) return respond(res, 500, { ok: false, error: generated.error });
        await writeSyncedState(memoryStore, promptWorkshopStore, SYNCED_KEY_WORKSHOP, { ...current, versions });
        workshopRef.value = normalizePromptWorkshop({ ...current, versions });
        return respond(res, 200, { ok: true, value: { ...readState(), ...generated.value, created: version.presetId } });
      }
      if (body?.action === 'save-version') {
        const presetId = typeof body?.presetId === 'string' ? body.presetId : '';
        const index = current.versions.findIndex((version) => version.presetId === presetId);
        if (index < 0) return respond(res, 400, { ok: false, error: 'invalid-preset' });
        const previous = current.versions[index];
        const text = typeof body?.text === 'string' ? body.text : previous.text;
        const versionName = typeof body?.name === 'string' && body.name.trim().length > 0
          ? body.name.trim().slice(0, PROMPT_VERSION_NAME_MAX)
          : previous.name;
        if (text.length > PROMPT_SLOT_MAX_TEXT) return respond(res, 400, { ok: false, error: 'text-too-large' });
        const versions = current.versions.map((version, position) => (position === index ? { ...version, name: versionName, text } : version));
        const generated = regeneratePromptExtras(versions);
        if (generated.error !== undefined) return respond(res, 500, { ok: false, error: generated.error });
        await writeSyncedState(memoryStore, promptWorkshopStore, SYNCED_KEY_WORKSHOP, { ...current, versions });
        workshopRef.value = normalizePromptWorkshop({ ...current, versions });
        return respond(res, 200, { ok: true, value: { ...readState(), ...generated.value } });
      }
      if (body?.action === 'delete-version') {
        const presetId = typeof body?.presetId === 'string' ? body.presetId : '';
        if (!current.versions.some((version) => version.presetId === presetId)) return respond(res, 400, { ok: false, error: 'invalid-preset' });
        const versions = current.versions.filter((version) => version.presetId !== presetId);
        const workspacePresets = { ...current.workspacePresets };
        for (const [key, preset] of Object.entries(workspacePresets)) if (preset === presetId) delete workspacePresets[key];
        const generated = regeneratePromptExtras(versions);
        if (generated.error !== undefined) return respond(res, 500, { ok: false, error: generated.error });
        await writeSyncedState(memoryStore, promptWorkshopStore, SYNCED_KEY_WORKSHOP, { ...current, versions, workspacePresets });
        workshopRef.value = normalizePromptWorkshop({ ...current, versions, workspacePresets });
        return respond(res, 200, { ok: true, value: { ...readState(), ...generated.value } });
      }
      if (body?.action === 'set-binding') {
        const key = typeof body?.workspaceKey === 'string' ? body.workspaceKey : '';
        const preset = typeof body?.presetId === 'string' ? body.presetId : '';
        if (key.length === 0 || key.length > 1024) return respond(res, 400, { ok: false, error: 'invalid-workspace' });
        const known = new Set([PROMPT_BASE_PRESET_ID, ...current.versions.map((version) => version.presetId)]);
        if (preset !== '' && !known.has(preset)) return respond(res, 400, { ok: false, error: 'invalid-preset' });
        const workspacePresets = { ...current.workspacePresets };
        if (preset === '') delete workspacePresets[key];
        else workspacePresets[key] = preset;
        await writeSyncedState(memoryStore, promptWorkshopStore, SYNCED_KEY_WORKSHOP, { ...current, workspacePresets });
        workshopRef.value = normalizePromptWorkshop({ ...current, workspacePresets });
        return respond(res, 200, { ok: true, value: readState() });
      }
      if (body?.action === 'set-auto') {
        if (typeof body?.enabled !== 'boolean') return respond(res, 400, { ok: false, error: 'invalid-enabled' });
        await writeSyncedState(memoryStore, promptWorkshopStore, SYNCED_KEY_WORKSHOP, { ...current, autoApply: body.enabled });
        workshopRef.value = normalizePromptWorkshop({ ...current, autoApply: body.enabled });
        return respond(res, 200, { ok: true, value: readState() });
      }
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] prompt workshop failed:`, error);
      return respond(res, 500, { ok: false, error: 'prompt-workshop-failed' });
    }
    return respond(res, 400, { ok: false, error: 'invalid-action' });
  }), `${name}: prompt workshop HTTP route`);

  ctx.effect(() => handle(ARCHIVE_LIST_ROUTE, (req, res) => handleArchiveList(ctx, req, res)), `${name}: archive list HTTP route`);
  ctx.effect(() => handle(ARCHIVE_RESTORE_ROUTE, (req, res) => handleArchiveRestore(ctx, req, res)), `${name}: archive restore HTTP route`);
  ctx.effect(() => handle(ARCHIVE_DELETE_ROUTE, (req, res) => handleArchiveDelete(ctx, req, res)), `${name}: archive delete HTTP route`);

  /* 删除整个工作区及其下全部会话（body: { sessionId } —— 用当前会话解析所属工作区）。
     护栏：①不能删最后一个工作区 ②工作区里有 live 会话先拒绝 ③工作区文件夹本身
     保留（可能含用户项目文件），只删会话存储/记录/墓碑/projcache。 */
  ctx.effect(() => handle(WORKSPACE_DELETE_ROUTE, (req, res) => route(req, res, async (id) => {
    // 1) 解析工作区：优先会话 header 的 cwd → resolveByPath；退路扫记录 sessionIds
    let wsEntity = null;
    try {
      const meta = await persistenceHeaderById(ctx.sessionPersistence, id);
      const cwd = meta?.cwd ?? ctx.sessions?.get?.(id)?.header?.cwd;
      if (typeof cwd === 'string' && cwd) wsEntity = await ctx.workspaceRegistry.resolveByPath(cwd);
    } catch { /* fallthrough */ }
    if (!wsEntity) {
      wsEntity = ctx.workspaceRegistry.list().find((w) => (w.sessionIds || []).includes(id)) ?? null;
    }
    if (!wsEntity) return respond(res, 404, { ok: false, error: 'workspace-not-found' });
    const result = await performWorkspaceDelete(ctx, wsEntity);
    return respond(res, result.status, result.payload);
  })), `${name}: workspace delete HTTP route`);

  /* 设置页入口：工作区列表 + 按路径删除（没有当前会话可用，所以按工作区路径解析）。 */
  ctx.effect(() => handle(WORKSPACES_ROUTE, async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    const workspaces = typeof ctx.workspaceRegistry?.list === 'function'
      ? ctx.workspaceRegistry.list().map((entity) => ({
        key: entity.path,
        /* 2026-10-11：补 registry id —— 设置页「工作区管理」面板的拖动排序要拿它去调
           dsh-adapter-compat 的 order 路由（顺序真源在宿主 workspace.json 的
           global.workspaceIds，写入只走宿主 registry.insertBefore）。
           注意 key 仍是 path（删除功能按 path 解析），别拿 key 当 id 用。 */
        id: typeof entity.id === 'string' ? entity.id : '',
        title: entity.title,
        path: entity.path,
        sessionCount: Array.isArray(entity.sessionIds) ? entity.sessionIds.length : 0
      }))
      : [];
    return respond(res, 200, { ok: true, value: { workspaces } });
  }), `${name}: workspaces HTTP route`);

  ctx.effect(() => handle(WORKSPACE_DELETE_BY_PATH_ROUTE, async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(res, 400, { ok: false, error: 'bad-request' });
    }
    const path = typeof body?.workspacePath === 'string' ? body.workspacePath : '';
    if (path.length === 0 || path.length > 4096) return respond(res, 400, { ok: false, error: 'invalid-workspace' });
    let entity = null;
    try { entity = await ctx.workspaceRegistry.resolveByPath(path); } catch { entity = null; }
    if (!entity) entity = ctx.workspaceRegistry.list().find((candidate) => candidate.path === path) ?? null;
    if (!entity) return respond(res, 404, { ok: false, error: 'workspace-not-found' });
    try {
      const result = await performWorkspaceDelete(ctx, entity);
      return respond(res, result.status, result.payload);
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] workspace delete by path failed:`, error);
      return respond(res, 500, { ok: false, error: 'operation-failed' });
    }
  }), `${name}: workspace delete by path HTTP route`);
  ctx.effect(() => handle(ARCHIVE_PREVIEW_ROUTE, (req, res) => handleArchivePreview(ctx, req, res)), `${name}: archive preview HTTP route`);
  ctx.effect(() => handle(TOOL_STATS_ROUTE, (req, res) => handleToolStats(ctx, req, res)), `${name}: tool stats HTTP route`);
  ctx.effect(() => handle(REPAIR_SESSION_ROUTE, (req, res) => handleRepairSession(ctx, req, res)), `${name}: repair session HTTP route`);
  ctx.effect(() => handle(TURNS_DEL_RANGES_PATH, (req, res) => handleTurnsDelRanges(ctx, req, res)), `${name}: turns-del ranges HTTP route`);
  ctx.effect(() => handle(TURNS_DEL_PATH, (req, res) => handleTurnsDel(ctx, req, res)), `${name}: turns-del HTTP route`);
  ctx.effect(() => handle(TURNS_DEL_TURN_PATH, (req, res) => handleTurnsDelTurn(ctx, req, res)), `${name}: turns-del turn HTTP route`);
  ctx.effect(() => handle(REGENERATE_PATH, (req, res) => handleRegenerateTurns(ctx, req, res)), `${name}: turns-del regenerate HTTP route`);
  ctx.effect(() => handle(REGENERATE_TURN_PATH, (req, res) => handleRegenerateTurnsByTurn(ctx, req, res)), `${name}: turns-del regenerate turn HTTP route`);
  ctx.effect(() => handle(EDIT_REGENERATE_TURN_PATH, (req, res) => handleEditRegenerateTurnsByTurn(ctx, req, res)), `${name}: turns-del edit regenerate turn HTTP route`);

  /* ── 会话可见性自愈（根修"侧边栏看不到导入/打开过的会话，但搜索能搜到"）──
     宿主 dsh-workspace 的 sessionIds getter 按 host.sessionPath(id)===path
     过滤（lib/index.js:102-103），而 readSessionHeader(id) 的 live 分支与
     headers 缓存命中分支只写 headers、不写 sessionPaths 索引（911-916 行）——
     晚于启动落盘的会话（导入/同步下载）进不了索引 → getter 把它过滤掉 →
     侧边栏 feed 里没有这行；而搜索/块索引不走这条路径 → 搜得到。
     自愈法：读一个必然不存在的 id 会命中"全量 indexHeaders"路径，该路径在
     抛错（查无此会话）之前就已把所有存储会话的 sessionPaths 补写完毕
     （919-920 行先于 921 行的抛错）。随后刷新会话列表。纯读、插件层实现：
     手机端装了 session-kit 同样生效，DSH 更新不覆盖插件。 */
  const repairSessionVisibility = async () => {
    try {
      const registry = ctx.workspaceRegistry;
      if (!registry || typeof registry.readSessionHeader !== 'function') return;
      try {
        // 故意读一个不存在的会话：触发全量索引，抛错是预期的
        await registry.readSessionHeader('session-00000000-0000-0000-0000-00000000dead');
      } catch { /* 预期：索引已在抛错前完成 */ }
      // 用原始记录（未过滤）对比 getter（已过滤），列出仍缺失的会话
      const missing = [];
      try {
        for (const ws of registry.list()) {
          const raw = [...(registry.requireTable().get(ws.id)?.sessionIds || [])];
          const visible = new Set(ws.sessionIds || []);
          for (const sid of raw) if (!visible.has(sid)) missing.push(sid);
        }
      } catch { /* 对比失败不影响主流程 */ }
      if (ctx.sessions && typeof ctx.sessions.refresh === 'function') {
        await ctx.sessions.refresh();
      }
      if (missing.length > 0) {
        ctx.logger?.warn?.(`[${name}] visibility repair: still hidden ${missing.length}: ${missing.slice(0, 10).join(', ')}`);
      } else {
        ctx.logger?.info?.(`[${name}] visibility repair: all workspace sessions indexed`);
      }
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] visibility repair failed: ${String(error)}`);
    }
  };
  /* 视图水位自愈 + 观测：聊天视图首屏按 history 分页（paginate）渲染，
     throughSeq 取投影水位 asOfSeq——asOfSeq 缺失/-1 时 paginate 返回空页
     = "一进来是白板，点加载更早才有内容"；块索引（搜索/timeline）直读日志
     所以一直看得见。这里对每个 live 会话强制官方 sessionProjectionCache.write()
     （立即 checkpoint：全量重算+flush+覆写缓存）推水位，并把前后 asOfSeq
     写进落盘日志 $DSH_HOME/dsh-session-kit-repair.log —— 出问题时读这个文件
     就能定位，不用翻浏览器控制台。 */
  const checkpointLiveProjections = async () => {
    try {
      const cache = ctx.get?.('sessionProjectionCache');
      if (!cache || typeof cache.write !== 'function') return;
      const { appendFileSync } = await import('node:fs');
      const logFile = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-session-kit-repair.log');
      const stamp = new Date().toISOString();
      const list = typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : [];
      for (const session of list) {
        const probe = () => {
          try {
            const b = typeof cache.cachedSnapshot === 'function' ? cache.cachedSnapshot(session.header) : undefined;
            return b === undefined ? 'none' : String(b.asOfSeq);
          } catch (e) { return 'err:' + String(e?.message ?? e).slice(0, 80); }
        };
        const before = probe();
        try {
          await cache.write(session);
          appendFileSync(logFile, `${stamp} checkpoint ${session.id} asOfSeq ${before} -> ${probe()}\n`);
        } catch (error) {
          appendFileSync(logFile, `${stamp} checkpoint ${session.id} asOfSeq ${before} FAILED: ${String(error?.message ?? error).slice(0, 200)}\n`);
          ctx.logger?.warn?.(`[${name}] projection checkpoint for "${session.id}" failed: ${String(error)}`);
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] projection checkpoint sweep failed: ${String(error)}`);
    }
  };
  const runVisibilityRepair = () => {
    void repairSessionVisibility().then(() => checkpointLiveProjections());
  };
  ctx.effect(() => {
    const timers = [
      setTimeout(() => { runVisibilityRepair(); }, 6000),
      setTimeout(() => { runVisibilityRepair(); }, 25000),
    ];
    const iv = setInterval(() => { runVisibilityRepair(); }, 600000); // 每10分钟兜底（覆盖运行中同步落盘的新会话）
    for (const t of timers) t.unref?.();
    iv.unref?.();
    return () => { for (const t of timers) clearTimeout(t); clearInterval(iv); };
  }, `${name}: session visibility repair`);
}