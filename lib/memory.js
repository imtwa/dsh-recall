/**
 * dsh-recall-sessions 会话扫描。
 *
 * 两条数据源，按可靠性排序：
 *   ① 投影缓存 `$DSH_HOME/storages/session_projcache/sessions/<id>.json`
 *      —— DSH 自己维护的已解压投影（标题、轮次大纲、首问、最后提问时间都在里面），
 *         读一个 JSON 就够，最省事也最快。
 *   ② 会话日志 `$DSH_HOME/sessions/<cwd-slug>/<id>/session.v4.jsonl.zstd`
 *      —— 多帧 zstd 拼接的 JSONL，作为缓存缺失/过期时的兜底。
 *
 * 全程只用 node 内置模块，任何一步失败都只是「少一条记录」，不抛异常。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

/** zstd 帧魔数（小端读出来的值）。 */
const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 默认扫描时间预算（毫秒）；超时后返回已经拿到的部分结果。 */
const DEFAULT_BUDGET_MS = 4000;

/**
 * 解析 DSH 主目录：优先 `DSH_HOME` 环境变量，其次 `~/.dsh`。
 */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME;
  if (typeof configured === "string" && configured.trim()) {
    return path.resolve(expandHome(configured.trim(), env));
  }
  return path.join(os.homedir(), ".dsh");
}

/** 展开开头的 `~`。 */
function expandHome(input, env = process.env) {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/** 规范化 cwd 用于比较：Windows 下大小写不敏感。 */
export function normalizeCwd(cwd) {
  if (typeof cwd !== "string" || !cwd) return "";
  let out = cwd.replace(/\//g, path.sep).replace(/[\\/]+$/, "");
  if (process.platform === "win32") out = out.toLowerCase();
  return out;
}

/** 由 cwd 推导会话目录 slug：`D:\a\b` -> `--D-a-b--`。 */
export function slugFromCwd(cwd) {
  if (typeof cwd !== "string" || !cwd) return "";
  // 缩成一层分隔符（Windows 的 `\` 与 POSIX 的 `/` 统一按 `/` 处理），
  // 再去掉首尾多余的斜杠，最后剥掉盘符后的冒号。
  // 这样 `D:\a\b` 与 `D:/a/b` 得到同一个结果 `--D-a-b--`。
  const flat = cwd
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/^([A-Za-z]):/, "$1")
    .replace(/\/+/g, "-");
  return `--${flat}--`;
}

/** 路径是否互为同一目录（Windows 大小写不敏感）。 */
export function sameCwd(a, b) {
  const na = normalizeCwd(a);
  const nb = normalizeCwd(b);
  return Boolean(na) && na === nb;
}

/** 判断 `parent` 是否是 `child` 的祖先目录。 */
export function isAncestorCwd(parent, child) {
  const p = normalizeCwd(parent);
  const c = normalizeCwd(child);
  if (!p || !c || p === c) return false;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** 向上取 n 级父目录。 */
export function parentCwd(cwd, levels = 1) {
  let out = cwd;
  for (let i = 0; i < levels; i += 1) {
    const next = path.dirname(out);
    if (!next || next === out) return undefined;
    out = next;
  }
  return out;
}

/** 从投影缓存行的 `{ ver, seq, val }` 包装里取出 `val`。 */
function rowVal(rows, key) {
  const row = rows?.[key];
  if (row && typeof row === "object" && "val" in row) return row.val;
  return undefined;
}

/** 安全读 JSON 文件；失败返回 undefined。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** 把任意文本块数组拼成纯文本。 */
function blocksToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join(" ");
}

/**
 * 解压多帧拼接的 zstd 缓冲区。
 *
 * DSH 每写一批事件就追加一个独立 zstd 帧，`zstdDecompressSync` 一次只解第一帧，
 * 所以必须自己按魔数切帧、逐帧解压再拼接。
 *
 * 两道护栏各管一头，谁都不能省：
 *   - `maxInputBytes`（压缩态）限制从文件里消费多少字节 —— 防读取超大文件；
 *   - `maxOutputBytes`（解压态）限制产出多少字节 —— 防解压炸弹。
 * 曾经踩过的坑：只按解压态设一个偏小的上限，而 zstd 对 JSONL 的压缩比能到 4 倍上下，
 * 于是大日志刚越过解压上限就被截断，后面几千帧全丢（一轮都没读全）。
 * 所以压缩态的上限要按文件体积来判断，解压态单独放一个高得多的值。
 *
 * @param {Buffer} buf 整个 zstd 文件内容。
 * @param {number} [maxInputBytes] 压缩态输入上限，默认 32MB。
 * @param {number} [maxOutputBytes] 解压态输出上限，默认 128MB。
 * @returns {Buffer} 拼接后的 JSONL 字节（触上限时会被截断）。
 */
export function decodeZstdFrames(buf, maxInputBytes = 33554432, maxOutputBytes = 134217728) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return Buffer.alloc(0);
  const inputCap =
    Number.isFinite(maxInputBytes) && maxInputBytes > 0 ? maxInputBytes : 33554432;
  const outputCap =
    Number.isFinite(maxOutputBytes) && maxOutputBytes > 0 ? maxOutputBytes : 134217728;

  const parts = [];
  let totalOut = 0;
  let consumed = 0;
  let offset = 0;

  // 帧数上限只是防呆：正常会话几千帧，真到十万帧说明文件结构坏了。
  while (offset + 4 <= buf.length && parts.length < 100000 && consumed < inputCap) {
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) {
      // 不是帧头：可能是文件尾的填充或损坏，直接停。
      break;
    }
    // 先算出这一帧到哪结束，再只解这一段。
    // 不显式给 end 而直接把后面的字节一起交给 zstdDecompressSync，行为依赖
    // 具体 Node 版本的实现细节，显式切片更稳。
    let end = buf.indexOf(ZSTD_MAGIC_BYTES, offset + 4);
    if (end < 0) end = buf.length;
    let out;
    try {
      out = zlib.zstdDecompressSync(buf.subarray(offset, end));
    } catch {
      break;
    }
    if (!out || out.length === 0) break;
    parts.push(out);
    totalOut += out.length;
    consumed = end;
    offset = end;
    if (totalOut >= outputCap) break;
  }

  return Buffer.concat(parts);
}

/** 把投影缓存里的一条 record 规范化成内部结构。 */
function normalizeFromCache(id, payload) {
  const record = payload?.record;
  if (!record || typeof record !== "object") return undefined;
  const identity = record.identity ?? {};
  const rows = record.rows ?? {};

  const title = rowVal(rows, "title");
  const titleInput = rowVal(rows, "titleInput");
  const outline = rowVal(rows, "turnOutline");
  const stats = rowVal(rows, "sessionStats");
  const listMeta = rowVal(rows, "sessionListMetadata");

  const turns = Array.isArray(outline?.turns) ? outline.turns : [];
  const recentTurns = turns.map((t) => ({
    turn: t?.turn,
    prompt: typeof t?.prompt === "string" ? t.prompt : "",
    response: typeof t?.response === "string" ? t.response : "",
  }));

  let firstPrompt = "";
  if (typeof titleInput === "string") firstPrompt = titleInput;
  else if (titleInput && typeof titleInput === "object" && typeof titleInput.first?.text === "string") {
    firstPrompt = titleInput.first.text;
  }
  if (!firstPrompt && recentTurns.length > 0) firstPrompt = recentTurns[0].prompt;

  const createdAt = Number(identity.createdAt) || 0;
  const lastPromptAt = Number(listMeta?.lastPromptAt) || 0;

  return {
    id,
    title: typeof title === "string" ? title : "",
    cwd: typeof identity.cwd === "string" ? identity.cwd : "",
    createdAt,
    lastActivityAt: lastPromptAt || createdAt,
    turns: Number(stats?.turns) || turns.length,
    steps: Number(stats?.steps) || 0,
    firstPrompt,
    recentTurns,
    source: "projcache",
    cachePath: undefined,
    logPath: undefined,
  };
}

/** 枚举投影缓存目录，返回全部会话（未按 cwd 过滤）。 */
function scanProjectionCache(home, budget) {
  const dir = path.join(home, "storages", "session_projcache", "sessions");
  const out = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  const deadline = Date.now() + budget;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (Date.now() > deadline) break;
    const file = path.join(dir, name);
    const payload = readJson(file);
    const record = normalizeFromCache(name.slice(0, -5), payload);
    if (!record) continue;
    record.cachePath = file;
    out.push(record);
  }
  return out;
}

/**
 * 列出本机全部会话（不做 cwd 过滤），按最后活动时间倒序。
 *
 * 用途：当进程 cwd 不是项目目录时，用最近活跃会话的 cwd 作为兜底猜测。
 */
export function listAllSessions(config, budgetMs = 2000) {
  const home = resolveDshHome();
  const all = scanProjectionCache(home, budgetMs);
  all.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  return all;
}

/**
 * 按会话 id 在**全机范围内**查找会话，不受当前工作目录限制。
 *
 * 支持只给 id 后缀（形如 `4e5c-91b4` 这种片段）做模糊匹配：
 * 会话 id 太长，手输时通常只记得尾巴。
 *
 * @param {string} query 完整 id 或 id 片段。
 * @param {object} config 已解析的配置。
 * @returns {{ exact?: object, matches: object[] }}
 */
export function findSession(query, config) {
  const wanted = typeof query === "string" ? query.trim() : "";
  if (!wanted) return { matches: [] };

  const all = listAllSessions(config, 3000);
  const exact = all.find((record) => record.id === wanted);
  if (exact) return { exact, matches: [exact] };

  const lower = wanted.toLowerCase();
  const matches = all.filter((record) => record.id.toLowerCase().includes(lower));
  if (matches.length === 1) return { exact: matches[0], matches };
  return { matches };
}

/**
 * 加载一个会话的完整轮次内容。
 *
 * 投影缓存里只有「有界预览」，所以这里优先读会话日志拿全文；
 * 日志读不到（缺失/损坏/超限）时回落到投影缓存的轮次大纲。
 *
 * @param {object} record `findSession` / `scanSessions` 返回的记录。
 * @param {object} config 已解析的配置。
 * @returns {object} 补齐了 recentTurns 的记录。
 */
export function loadSessionDetail(record, config) {
  const out = { ...record, recentTurns: Array.isArray(record.recentTurns) ? [...record.recentTurns] : [] };
  const home = resolveDshHome();

  if (!out.logPath) {
    const logDir = findLogDir(home, out.id, out.cwd, 2000);
    if (logDir) out.logPath = path.join(logDir, "session.v4.jsonl.zstd");
  }
  if (!out.logPath) return out;

  const extra = readTurnsFromLog(out.logPath, config);
  if (!extra) return out;

  if (!out.title && extra.title) out.title = extra.title;
  if (!out.firstPrompt && extra.firstPrompt) out.firstPrompt = extra.firstPrompt;
  if (!out.createdAt && extra.createdAt) out.createdAt = extra.createdAt;
  if (extra.lastActivityAt > out.lastActivityAt) out.lastActivityAt = extra.lastActivityAt;
  if (extra.turns.length > out.recentTurns.length) out.recentTurns = extra.turns;
  if (!out.turns || out.turns === 0) out.turns = extra.turns.length;
  out.source = "log";
  return out;
}

/** 在 `$DSH_HOME/sessions` 下按会话 id 找日志目录（有界遍历）。 */
function findLogDir(home, sessionId, cwd, budget) {
  const root = path.join(home, "sessions");
  const candidates = [];
  const slug = slugFromCwd(cwd);
  if (slug) candidates.push(path.join(root, slug, sessionId));
  for (const dir of candidates) {
    const file = path.join(dir, "session.v4.jsonl.zstd");
    if (fs.existsSync(file)) return dir;
  }

  // 兜底：遍历一层子目录找同名会话目录。会话目录总数很小，成本可接受。
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const deadline = Date.now() + Math.max(200, Math.floor(budget / 4));
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    if (Date.now() > deadline) break;
    const dir = path.join(root, entry.name, sessionId);
    if (fs.existsSync(path.join(dir, "session.v4.jsonl.zstd"))) return dir;
  }
  return undefined;
}

/**
 * 从事件里取「真实用户说的话」，取不到返回空串。
 *
 * DSH 会往会话里塞各种非用户来源的 `user/message` 事件（`source.kind` 为
 * `agent-instructions` / `runtime-context` / `skill-catalog` / `tool-jobs`），
 * 内容动辄几千字符的系统提示词。它们不是用户提问，必须丢掉，
 * 否则首问会被一大段 `<system-reminder>` 污染。
 */
function userTextFromEvent(event) {
  const kind = event?.data?.source?.kind;
  // 没有 kind 说明是老格式，按真实用户消息处理。
  if (typeof kind === "string" && kind !== "user") return "";
  return blocksToText(event?.data?.content);
}

/**
 * 直接从会话日志补齐一个会话的轮次信息。
 *
 * 只在投影缓存缺失或明显过期时调用，代价是解压整个日志。
 *
 * @param {string} logPath 会话日志路径。
 * @param {object} config 已解析的配置。
 * @param {number} [maxInputBytes] 压缩态输入上限，默认取配置的 maxLogBytes。
 */
export function readTurnsFromLog(logPath, config, maxInputBytes) {
  let buf;
  try {
    const stat = fs.statSync(logPath);
    const cap = Number.isFinite(maxInputBytes) && maxInputBytes > 0
      ? maxInputBytes
      : config.maxLogBytes;
    // 按压缩态大小设硬闸：文件本身超过上限就直接放弃，
    // 不要指望解压后的上限来兜（压缩比决定了那会静默丢内容）。
    if (stat.size > cap * 8) return undefined;
    buf = fs.readFileSync(logPath);
  } catch {
    return undefined;
  }

  const raw = decodeZstdFrames(
    buf,
    Number.isFinite(maxInputBytes) && maxInputBytes > 0 ? maxInputBytes : config.maxLogBytes,
  );
  if (raw.length === 0) return undefined;

  const turns = [];
  let current = undefined;
  let title = "";
  let firstPrompt = "";
  let createdAt = 0;
  let lastActivityAt = 0;

  for (const line of raw.toString("utf8").split("\n")) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const time = Number(event?.time) || 0;
    if (time > lastActivityAt) lastActivityAt = time;

    switch (event?.type) {
      case "session": {
        createdAt = Number(event.createdAt) || createdAt;
        break;
      }
      case "session/title": {
        const t = event.data?.title ?? event.data;
        if (typeof t === "string") title = t;
        break;
      }
      case "turn/start": {
        current = { turn: Number(event.data?.turn) || turns.length + 1, prompt: "", response: "" };
        turns.push(current);
        break;
      }
      case "user/message": {
        const text = userTextFromEvent(event);
        if (!text) break;
        if (!firstPrompt) firstPrompt = text;
        if (current && !current.prompt) current.prompt = text;
        break;
      }
      case "assistant/message": {
        const text = blocksToText(event.data?.message?.content);
        if (!text) break;
        if (current) current.response = text;
        break;
      }
      default:
        break;
    }
  }

  // 丢掉一个 turn/end 之后再出现的零星 assistant/message（理论上不会发生，
  // 但真出现时说明事件流有交叉，把它们挂到当前轮次末尾更安全）。
  return { title, firstPrompt, createdAt, lastActivityAt, turns };
}

/**
 * 选出与当前 cwd 相关的会话。
 *
 * 匹配规则（从紧到松）：
 *   0 = 完全同一个目录
 *   1..n = 当前目录的第 n 级父目录（在子目录里开会话时，仍然能看到项目根目录的历史）
 * 排序：先按匹配层级，再按最后活动时间倒序。
 */
function matchSessions(all, cwd, config) {
  const target = normalizeCwd(cwd);
  const maxLevels = config.includeParentCwds ? Math.max(0, config.maxParentLevels | 0) : 0;

  const ancestors = [];
  for (let level = 1; level <= maxLevels; level += 1) {
    const parent = parentCwd(cwd, level);
    if (!parent) break;
    const norm = normalizeCwd(parent);
    if (!norm || norm === target) break;
    ancestors.push(norm);
  }

  const matched = [];
  for (const record of all) {
    const rc = normalizeCwd(record.cwd);
    if (!rc) continue;
    let level;
    if (rc === target) level = 0;
    else {
      const index = ancestors.indexOf(rc);
      if (index < 0) continue;
      level = index + 1;
    }
    matched.push({ ...record, cwdMatchLevel: level });
  }

  matched.sort((a, b) => {
    if (a.cwdMatchLevel !== b.cwdMatchLevel) return a.cwdMatchLevel - b.cwdMatchLevel;
    return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
  });
  return matched;
}

/**
 * 扫描本机会话，返回与 `cwd` 匹配、按「匹配层级 → 最后活动时间」排序的记录。
 *
 * @param {object} options
 * @param {string} options.cwd 当前工作目录。
 * @param {object} options.config 已解析的配置。
 * @param {string} [options.excludeSessionId] 要排除的会话（当前会话）。
 * @param {(message: string) => void} [options.warn]
 * @param {number} [options.budgetMs]
 * @returns {{ sessions: object[], scanned: number, usedLogFallback: number, warnings: string[], home: string, matchedCwds: string[] }}
 */
export function scanSessions(options) {
  const { cwd, config, excludeSessionId, warn } = options;
  const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : DEFAULT_BUDGET_MS;
  const warnings = [];
  const say = (message) => {
    warnings.push(message);
    if (typeof warn === "function") warn(message);
  };

  const home = resolveDshHome();
  const target = normalizeCwd(cwd);
  if (!target) {
    say(`无法确定当前工作目录（cwd=${JSON.stringify(cwd)}），跳过跨会话记忆扫描`);
    return { sessions: [], scanned: 0, usedLogFallback: 0, warnings, home, matchedCwds: [] };
  }

  const all = scanProjectionCache(home, budgetMs);
  const matched = matchSessions(all, cwd, config);

  const now = Date.now();
  let usedLogFallback = 0;
  const deadline = now + budgetMs;

  // 日志兜底只对最有希望的候选做，避免为几十个同目录会话逐个解压整份日志。
  const candidateLimit = Math.max(config.maxSessions * 4, config.maxSessions + 2);
  const candidates = (excludeSessionId
    ? matched.filter((record) => record.id !== excludeSessionId)
    : matched
  ).slice(0, candidateLimit);

  for (const record of candidates) {
    // 两种情况下回落到日志：
    //   1. 投影缓存文件太旧（可能还没把最近的事件投影进去）；
    //   2. 缓存里压根没有可用的轮次数据 —— 新会话的缓存常常是「刚建好、
    //      还没写进任何一轮」的状态，这时不补日志就会在摘要里出现空壳条目。
    const stale = !record.cachePath || now - fsMtime(record.cachePath) > config.cacheFreshMs;
    const noTurns = !Array.isArray(record.recentTurns) || record.recentTurns.length === 0;
    if (!stale && !noTurns) continue;
    if (Date.now() > deadline) break;
    const logDir = findLogDir(home, record.id, record.cwd, budgetMs);
    if (!logDir) continue;
    const logPath = path.join(logDir, "session.v4.jsonl.zstd");
    const extra = readTurnsFromLog(logPath, config);
    if (!extra) continue;
    usedLogFallback += 1;
    if (!record.title && extra.title) record.title = extra.title;
    if (!record.firstPrompt && extra.firstPrompt) record.firstPrompt = extra.firstPrompt;
    if (!record.createdAt && extra.createdAt) record.createdAt = extra.createdAt;
    if (extra.lastActivityAt > record.lastActivityAt) record.lastActivityAt = extra.lastActivityAt;
    if (record.recentTurns.length === 0 && extra.turns.length > 0) {
      record.recentTurns = extra.turns.map((t) => ({
        turn: t.turn,
        prompt: t.prompt,
        response: t.response,
      }));
    }
    if (!record.turns || record.turns === 0) record.turns = extra.turns.length;
    record.source = "log";
    record.logPath = logPath;
  }

  let sessions = matched;
  if (excludeSessionId) sessions = sessions.filter((record) => record.id !== excludeSessionId);

  // 日志兜底可能刷新了 lastActivityAt，这里在「匹配层级」内重排一次；
  // 层级优先级必须保留，否则父目录的会话会挤到子目录会话前面。
  sessions = [...sessions].sort((a, b) => {
    const la = a.cwdMatchLevel ?? 0;
    const lb = b.cwdMatchLevel ?? 0;
    if (la !== lb) return la - lb;
    return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
  });

  // 只给最终入选的会话补日志路径与轮次，避免为落选的会话白跑目录遍历和解压。
  const selected = sessions.slice(0, config.maxSessions);
  for (const record of selected) {
    record.recentTurns = record.recentTurns.slice(-config.maxTurnsPerSession);
    if (!record.logPath) {
      const logDir = findLogDir(home, record.id, record.cwd, budgetMs);
      if (logDir) record.logPath = path.join(logDir, "session.v4.jsonl.zstd");
    }
  }

  return {
    sessions: selected,
    scanned: matched.length,
    usedLogFallback,
    warnings,
    home,
    matchedCwds: [...new Set(matched.map((record) => record.cwd))],
  };
}

/** 读文件 mtime，失败返回 0。 */
function fsMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 从会话日志里只读**第一个 zstd 帧**，取出会话头（含 cwd / createdAt）。
 *
 * 用来在「进程 cwd 不是项目目录」时定位当前会话真正的工作目录，
 * 只解压第一帧，代价极小。
 *
 * @returns {{ id: string, cwd: string, createdAt: number } | undefined}
 */
export function readSessionHeaderFromLog(logPath) {
  let buf;
  try {
    const fd = fs.openSync(logPath, "r");
    try {
      const chunk = Buffer.alloc(8192);
      const read = fs.readSync(fd, chunk, 0, chunk.length, 0);
      buf = chunk.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }

  if (buf.length < 4 || buf.readUInt32LE(0) !== ZSTD_MAGIC) return undefined;
  let out;
  try {
    out = zlib.zstdDecompressSync(buf);
  } catch {
    return undefined;
  }
  if (!out || out.length === 0) return undefined;

  for (const line of out.toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "session") {
        return {
          id: typeof event.id === "string" ? event.id : "",
          cwd: typeof event.cwd === "string" ? event.cwd : "",
          createdAt: Number(event.createdAt) || 0,
        };
      }
    } catch {
      /* 第一帧里可能有半行，忽略 */
    }
  }
  return undefined;
}
/**
 * 找出最近被写入的会话日志（当前正在跑的会话）。
 *
 * @param {number} withinMs 只接受这个时间窗内改动过的文件。
 */
export function findNewestSessionLog(withinMs = 600000) {
  const root = path.join(resolveDshHome(), "sessions");
  let slugDirs;
  try {
    slugDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let best;
  for (const slug of slugDirs) {
    if (!slug.isDirectory()) continue;
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(path.join(root, slug.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessionDirs) {
      if (!session.isDirectory()) continue;
      const file = path.join(root, slug.name, session.name, "session.v4.jsonl.zstd");
      const mtime = fsMtime(file);
      if (mtime <= 0) continue;
      if (!best || mtime > best.mtime) best = { file, mtime };
    }
  }

  if (!best) return undefined;
  if (withinMs > 0 && Date.now() - best.mtime > withinMs) return undefined;
  return best;
}
