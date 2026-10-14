/**
 * dsh-recall —— DSH 跨会话记忆插件。
 *
 * 默认行为是**按需加载**：插件不会自作主张把项目历史塞进新会话的上下文。
 * 用户说「看看之前那个会话」时才用 /recall 列出清单，指定了具体会话才去读它的内容；
 * 也可以让模型自己调 recall_sessions 工具按需拉取。
 *
 * 想要「开局自动带上最近几个会话摘要」的老行为，把 `autoInject` 设成 true。
 *
 * 与内置 `@deepseek-ai/dsh-session-reference` 的区别：那个需要用户在消息里
 * 手动写 `@[标题](dsh-session:<id>)`；本插件提供按序号/片段 id 的检索与加载。
 *
 * 设计约束（故意为之）：
 * - 零依赖，只 import node 内置模块，不 import 任何 `@deepseek-ai/*`；
 * - autoInject 模式下首次组装提示词时扫描一次并缓存，之后返回同一份缓存
 *   —— 保证注入文本稳定，不破坏上游 prompt cache；
 * - 任何异常都只记日志，绝不向上抛（抛异常会拖垮整个 profile 启动）。
 */

import { renderAutoInjectDigest } from "./autoinject.js";
import { DEFAULTS, resolveConfig } from "./config.js";
import { renderSessionDetail, renderSessionList } from "./digest.js";
import {
  findNewestSessionLog,
  findSession,
  listAllSessions,
  loadSessionDetail,
  normalizeCwd,
  readSessionHeaderFromLog,
  readTurnsFromLog,
  resolveDshHome,
  scanSessions,
} from "./memory.js";

/** Cordis 插件名。 */
export const name = "dsh-recall";

/** 依赖的服务：缺哪个就等哪个，不会因为服务没装而崩。 */
export const inject = ["systemPrompt", "commands", "tools"];

/** 摘要注入的默认排序位置，落在沙箱策略（110）之前。 */
const DEFAULT_ORDER = 108;

/**
 * 每个插件实例一份状态。
 *
 * `cwdCache` 按工作目录缓存扫描结果 —— 一次进程里可能有多个 agent
 * （子代理、不同会话）用不同的 cwd，缓存必须分桶。
 */
export function apply(ctx, rawConfig) {
  const { config } = resolveConfig(rawConfig, (message) => {
    try {
      ctx.logger?.warn?.(`[dsh-recall] ${message}`);
    } catch {
      /* 日志本身失败不影响加载 */
    }
  });

  if (!config.enabled) {
    ctx.logger?.info?.("[dsh-recall] enabled=false，插件已跳过");
    return;
  }

  const log = (level, message) => {
    try {
      const fn = ctx.logger?.[level];
      if (typeof fn === "function") fn.call(ctx.logger, `[dsh-recall] ${message}`);
    } catch {
      /* 忽略 */
    }
  };

  /** @type {Map<string, { digest: string, info: object, at: number }>} */
  const cwdCache = new Map();

  /**
   * 本进程里已创建（且尚未销毁）的会话：`会话 id → { cwd, createdAt }`。
   *
   * 这是「当前工作目录」最可靠的来源 —— `AssembleContext` 拿不到 cwd，
   * 但 `session/created` 事件会把带 cwd 的会话头直接递过来。
   */
  const liveSessions = new Map();

  const order = Number.isFinite(config.order) ? config.order : DEFAULT_ORDER;
  const home = resolveDshHome();

  // ── 0. 跟踪会话生命周期，拿到准确的 cwd ─────────────────────────────
  //
  // 关键点：`session/created` 事件是**按 agent 作用域**投递的，每个会话创建时
  // DSH 会把带 cwd 的会话头递过来。这样即使进程 cwd 不是项目目录
  // （比如从别处启动 dsh web），也能准确知道「当前这次对话在哪个项目里」。
  const rememberSession = (session) => {
    const id = session?.header?.id ?? session?.id;
    const cwd = session?.header?.cwd;
    if (typeof id !== "string" || !id) return;
    liveSessions.set(id, {
      cwd: typeof cwd === "string" ? cwd : "",
      createdAt: Number(session?.header?.createdAt) || Date.now(),
    });
  };

  try {
    if (typeof ctx.on === "function") {
      // `session/created` / `session/disposed` / `session/event` 都是 agent 作用域事件，
      // 回调签名是 `(session)`，`session.header` 带 { id, cwd, createdAt }。
      ctx.on("session/created", rememberSession);
      // 兜底：有些版本不派发 session/created，只在事件流里露会话 id。
      // 收到任何会话事件就顺手记录一次（幂等，代价只有一次 Map 写入）。
      ctx.on("session/event", (session) => {
        const id = session?.header?.id ?? session?.id;
        if (typeof id === "string" && !liveSessions.has(id)) rememberSession(session);
      });
      ctx.on("session/disposed", (session) => {
        const id = session?.header?.id ?? session?.id;
        if (typeof id === "string") liveSessions.delete(id);
      });
    }
  } catch (error) {
    log("warn", `会话生命周期监听失败（不影响按需加载）：${error?.message ?? error}`);
  }

  /**
   * 取当前 agent 的会话 id。`Agent` 公开类型只保证 `id`，运行时还有 `session`，
   * 这里全部用可选链读，读不到就返回 undefined（不影响功能，只是不排除当前会话）。
   */
  const sessionIdOf = (agent) =>
    (typeof agent?.id === "string" && agent.id) ||
    (typeof agent?.session?.id === "string" && agent.session.id) ||
    undefined;

  /**
   * 找「当前工作目录」。
   *
   * `AssembleContext` 只带 `scope` / `signal`，拿不到 cwd，所以按可靠性排序取候选：
   * ① `session/created` 事件里记下的会话 cwd（最准，DSH 自己传的）；
   * ② 最近被写入的会话日志的 header.cwd（进程 cwd 不对时的兜底，只解压第一帧）；
   * ③ 进程 cwd。
   */
  function candidateCwds() {
    const list = [];
    for (const entry of liveSessions.values()) {
      if (entry.cwd) list.push(entry.cwd);
    }
    try {
      const newest = findNewestSessionLog(config.cacheFreshMs);
      if (newest) {
        const header = readSessionHeaderFromLog(newest.file);
        if (header?.cwd) list.push(header.cwd);
      }
    } catch {
      /* 探测失败继续用后面的候选 */
    }
    if (process.cwd()) list.push(process.cwd());

    const seen = new Set();
    const out = [];
    for (const cwd of list) {
      const key = normalizeCwd(cwd);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(cwd);
    }
    return out;
  }

  /**
   * 扫描并渲染指定 cwd 的摘要，结果进缓存。
   * `force=true` 时忽略缓存重新扫描（供 /recall refresh 使用）。
   */
  function buildDigest(cwd, options = {}) {
    const key = `${normalizeCwd(cwd)}\u0000${options.excludeSessionId ?? ""}`;
    if (!options.force) {
      const hit = cwdCache.get(key);
      if (hit) return hit;
    }

    let result;
    try {
      result = scanSessions({
        cwd,
        // includeCurrentSession=true 时故意不排除当前会话，让它也出现在记忆里。
        excludeSessionId: config.includeCurrentSession ? undefined : options.excludeSessionId,
        config,
        warn: (message) => log("warn", message),
      });
    } catch (error) {
      log("warn", `扫描会话失败：${error?.message ?? error}`);
      result = { sessions: [], scanned: 0, usedLogFallback: 0, warnings: [], home };
    }

    const now = Date.now();
    const digest = renderAutoInjectDigest(result.sessions, config, now);
    const entry = {
      digest,
      at: now,
      info: {
        cwd,
        home: result.home ?? home,
        scanned: result.scanned,
        included: result.sessions.length,
        usedLogFallback: result.usedLogFallback,
        sessions: result.sessions,
      },
    };
    cwdCache.set(key, entry);
    return entry;
  }

  /** 首次调用时扫描，之后返回缓存；用于系统提示词注入。 */
  function getDigestLazy(cwd, excludeSessionId) {
    const key = `${normalizeCwd(cwd)}\u0000${excludeSessionId ?? ""}`;
    const hit = cwdCache.get(key);
    if (hit) return hit;
    return buildDigest(cwd, { excludeSessionId });
  }

  /**
   * 解析「这次请求应该用哪个 cwd」。
   *
   * 命令 / 工具调用时能拿到 agent，可以精确定位它自己的会话；
   * 拿不到 agent 就退回到候选列表的第一个。
   */  function resolveCwdFor(agent) {
    const id = sessionIdOf(agent);
    if (id) {
      const entry = liveSessions.get(id);
      if (entry?.cwd) return entry.cwd;
      try {
        // 缓存里没有（典型场景：子 agent 的 cwd 从未递过来）时，
        // 直接去全机扫一遍，靠会话 id 反查它的 cwd。
        const found = findSession(id, config);
        if (found.exact?.cwd) return found.exact.cwd;
      } catch {
        /* 继续往下退 */
      }
    }
    const candidates = candidateCwds();
    return candidates[0] ?? process.cwd();
  }

  /**
   * 当前 cwd 下最近创建的会话 id，用于把「当前会话」从记忆里排除掉。
   *
   * 拿不到 agent 时（例如系统提示词组装阶段）就退化成扫 liveSessions
   * —— 里面记的都是本进程真实创建过的会话，选最新的那个即当前会话。
   */
  function currentSessionId(cwd, agent) {
    const wanted = normalizeCwd(cwd);
    const fromAgent = sessionIdOf(agent);
    if (fromAgent) {
      const entry = liveSessions.get(fromAgent);
      // agent 的 cwd 对得上才算「同一目录下的当前会话」；
      // 对不上（例如子 agent 跑在别的目录）就让它继续参与记忆。
      if (!entry?.cwd || normalizeCwd(entry.cwd) === wanted) return fromAgent;
    }
    let best;
    let newest = 0;
    for (const [id, entry] of liveSessions) {
      if (normalizeCwd(entry.cwd) !== wanted) continue;
      if (entry.createdAt >= newest) {
        newest = entry.createdAt;
        best = id;
      }
    }
    return best;
  }

  // ── 1. 系统提示词注入（默认关闭，只有 autoInject=true 才注册）──────────
  if (!config.autoInject) {
    log(
      "info",
      "autoInject=false：不自动注入历史会话。用 /recall 查看清单、/recall <序号|id> 加载指定会话，" +
        "或让模型调 recall_sessions 工具按需拉取。",
    );
  } else if (ctx.systemPrompt?.context) {
    ctx.systemPrompt.context({
      name: "dsh-recall:cross-session-memory",
      order,
      text: () => {
        try {
          for (const cwd of candidateCwds()) {
            const entry = getDigestLazy(cwd, currentSessionId(cwd));
            if (entry.digest) {
              log("info", `注入跨会话记忆（${entry.info.included} 个会话，cwd=${cwd}）`);
              return entry.digest;
            }
          }
        } catch (error) {
          log("warn", `注入失败：${error?.message ?? error}`);
        }
        return "";
      },
    });
    log("info", `autoInject=true：已注册系统提示词上下文（order=${order}）`);
  } else {
    log("warn", "ctx.systemPrompt.context 不可用，跳过提示词注入");
  }

  // ── 按需加载的共用逻辑 ───────────────────────────────────────────────

  /**
   * 列出当前工作目录（含父目录）下可加载的会话。
   * 传入 `scope: "all"` 时列出全机所有项目的会话。
   */
  function listAvailable(agent, options = {}) {
    if (options.scope === "all") {
      const all = listAllSessions(config, 3000);
      const exclude = config.includeCurrentSession ? undefined : sessionIdOf(agent);
      const sessions = exclude ? all.filter((s) => s.id !== exclude) : all;
      return { sessions, scanned: all.length, cwd: resolveCwdFor(agent), scope: "all" };
    }

    const cwd = resolveCwdFor(agent);
    const result = scanSessions({
      cwd,
      config: { ...config, maxSessions: config.maxListSessions },
      excludeSessionId: config.includeCurrentSession ? undefined : sessionIdOf(agent),
      budgetMs: 4000,
      warn: (message) => log("warn", message),
    });
    return {
      sessions: result.sessions,
      scanned: result.scanned,
      cwd: result.matchedCwds?.length > 1 ? result.matchedCwds.join(", ") : cwd,
      scope: "cwd",
    };
  }

  /** 按序号（从 1 开始）或 id（支持片段）解析出一个会话。 */
  function resolveTarget(agent, target, options = {}) {
    const raw = String(target ?? "").trim();
    if (!raw) return { error: "没有给出要加载的会话" };

    const list = listAvailable(agent, options);
    if (/^\d+$/.test(raw)) {
      const index = Number(raw);
      const hit = list.sessions[index - 1];
      if (!hit) {
        return {
          error: `序号 ${index} 超出范围（当前有 ${list.sessions.length} 个可加载会话）`,
          list,
        };
      }
      return { session: hit, list };
    }

    const local = list.sessions.find((s) => s.id === raw || s.id.endsWith(raw));
    if (local) return { session: local, list };

    // 本地清单里没有：按 id 片段在全机范围内找一次。
    const found = findSession(raw, config);
    if (found.exact) return { session: found.exact, list, fromAll: true };
    if (found.matches.length > 1) {
      return {
        error: `id 片段 "${raw}" 匹配到 ${found.matches.length} 个会话，请给更长的片段`,
        candidates: found.matches,
        list,
      };
    }
    return { error: `没有找到会话 "${raw}"`, list };
  }

  // ── 2. /recall 命令 ─────────────────────────────────────────────────
  if (ctx.commands?.register) {
    ctx.commands.register({
      name: "recall",
      description: "列出并加载本机历史会话（dsh-recall 按需读取，不自动带进上下文）",
      input: { hint: "[<序号>|<会话 id 片段>|all|refresh]" },
      handler: (invocation) => {
        try {
          const raw = String(invocation?.rawInput ?? "").trim();
          const lower = raw.toLowerCase();
          const agent = invocation?.agent;

          if (lower === "refresh") {
            cwdCache.clear();
            const list = listAvailable(agent, { scope: "all" });
            return {
              kind: "success",
              text: `已重新扫描磁盘。\n\n${renderSessionList(list.sessions, config, {
                limit: config.maxListSessions,
              })}`,
            };
          }

          // 无参数：列出当前项目的可加载会话。
          if (!raw) {
            const list = listAvailable(agent, { scope: "cwd" });
            const head =
              `- 当前工作目录：${list.cwd}\n` +
              `- 相关会话：${list.scanned} 个（列出最新 ${Math.min(list.scanned, config.maxListSessions)} 个）\n` +
              `- DSH 主目录：${home}`;
            return {
              kind: "success",
              text: `${head}\n\n${renderSessionList(list.sessions, config, {
                limit: config.maxListSessions,
              })}`,
            };
          }

          // /recall all：跨项目列出全部会话。
          if (lower === "all") {
            const list = listAvailable(agent, { scope: "all" });
            return {
              kind: "success",
              text:
                `- 本机全部会话：${list.scanned} 个（列出最新 ${Math.min(list.scanned, config.maxListSessions)} 个）\n\n` +
                renderSessionList(list.sessions, config, { limit: config.maxListSessions }),
            };
          }

          // /recall <序号|id 片段>：加载指定会话的内容。
          const resolved = resolveTarget(agent, raw, { scope: "cwd" });
          if (resolved.error) {
            const extra = Array.isArray(resolved.candidates)
              ? `\n\n候选：\n${resolved.candidates
                  .slice(0, 10)
                  .map((s) => `- ${s.id} | ${s.title || "(无标题)"} | ${s.cwd}`)
                  .join("\n")}`
              : "";
            const tail = resolved.list
              ? `\n\n${renderSessionList(resolved.list.sessions, config, {
                  limit: config.maxListSessions,
                })}`
              : "";
            return { kind: "error", text: `${resolved.error}${extra}${tail}` };
          }

          const detail = loadSessionDetail(resolved.session, config);
          return {
            kind: "success",
            text: renderSessionDetail(detail, config, { maxTurns: config.maxDetailTurns }),
          };
        } catch (error) {
          return { kind: "error", text: `dsh-recall 执行失败：${error?.message ?? error}` };
        }
      },
    });
    log("info", "已注册 /recall 命令");
  } else {
    log("warn", "ctx.commands.register 不可用，跳过命令注册");
  }

  // ── 3. recall_sessions 工具 ─────────────────────────────────────────
  if (ctx.tools?.register) {
    ctx.tools.register({
      name: "recall_sessions",
      description:
        "查看本机历史会话（dsh-recall 按需读取，不会自动出现在上下文里）。" +
        "不传参数返回当前项目可加载的会话清单；传 index 或 sessionId 返回该会话的轮次内容；" +
        "scope=all 列出本机所有项目的会话；refresh=true 强制重新扫描磁盘。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: {
            type: "integer",
            description: "清单里的序号（从 1 开始），用于加载指定会话",
            minimum: 1,
          },
          sessionId: {
            type: "string",
            description: "会话 id 或它的片段（形如 session-xxxxxxxx-... 或末尾几个字符）",
          },
          scope: {
            type: "string",
            description: "cwd（默认，只看当前项目）或 all（全机所有项目）",
            enum: ["cwd", "all"],
          },
          refresh: {
            type: "boolean",
            description: "是否强制重新扫描磁盘（默认 false，用缓存）",
          },
          limit: {
            type: "integer",
            description: "清单最多列出多少个会话（1-200，默认取配置的 maxListSessions）",
            minimum: 1,
            maximum: 200,
          },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            sessions: { type: "integer" },
            cwd: { type: "string" },
          },
          required: ["text", "sessions", "cwd"],
        },
        render: (_args, value) => [
          { type: "text", text: String(value?.text ?? "(无内容)") },
        ],
      },
      async execute(args = {}, exec) {
        const agent = exec?.agent ?? exec;
        const scope = args.scope === "all" ? "all" : "cwd";
        const limit =
          Number.isInteger(args.limit) && args.limit > 0
            ? Math.min(args.limit, 200)
            : config.maxListSessions;

        if (args.refresh === true) cwdCache.clear();

        const hasTarget =
          (Number.isInteger(args.index) && args.index > 0) ||
          (typeof args.sessionId === "string" && args.sessionId.trim());

        // 没指定会话：返回清单，让模型自己挑。
        if (!hasTarget) {
          const list = listAvailable(agent, { scope });
          const head =
            scope === "all"
              ? `- 本机全部会话：${list.scanned} 个`
              : `- 当前项目：${list.cwd}\n- 相关会话：${list.scanned} 个`;
          return {
            text: `${head}\n\n${renderSessionList(list.sessions, config, { limit })}`,
            sessions: list.scanned,
            cwd: list.cwd,
          };
        }

        const target = Number.isInteger(args.index) && args.index > 0 ? args.index : args.sessionId;
        const resolved = resolveTarget(agent, target, { scope });
        if (resolved.error) {
          const extra = Array.isArray(resolved.candidates)
            ? `\n\n候选：\n${resolved.candidates
                .slice(0, 10)
                .map((s) => `- ${s.id} | ${s.title || "(无标题)"} | ${s.cwd}`)
                .join("\n")}`
            : "";
          const tail = resolved.list
            ? `\n\n${renderSessionList(resolved.list.sessions, config, { limit })}`
            : "";
          return {
            text: `${resolved.error}${extra}${tail}`,
            sessions: resolved.list?.scanned ?? 0,
            cwd: resolved.list?.cwd ?? resolveCwdFor(agent),
          };
        }

        const detail = loadSessionDetail(resolved.session, config);
        return {
          text: renderSessionDetail(detail, config, { maxTurns: config.maxDetailTurns }),
          sessions: resolved.list?.scanned ?? 1,
          cwd: detail.cwd || resolveCwdFor(agent),
        };
      },
    });
    log("info", "已注册 recall_sessions 工具");
  } else {
    log("warn", "ctx.tools.register 不可用，跳过工具注册");
  }

  log(
    "info",
    `加载完成：cwd=${process.cwd()}，DSH 主目录=${home}，autoInject=${config.autoInject}，` +
      `maxListSessions=${config.maxListSessions}，maxDetailTurns=${config.maxDetailTurns}`,
  );
}

/** 供外部直接引用默认配置（例如写文档或自检脚本）。 */
export { DEFAULTS, resolveDshHome, scanSessions, readTurnsFromLog };

/** 显式导出便于测试。 */
export const internals = {
  normalizeCwd,
  readTurnsFromLog,
  scanSessions,
  renderSessionList,
  renderSessionDetail,
  findSession,
  loadSessionDetail,
  DEFAULTS,
};
