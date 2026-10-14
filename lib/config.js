/**
 * dsh-recall 配置解析。
 *
 * 插件配置来自 profile 的 cordis 补丁层（`cordis.patch.yml` 里 `insert[].config`），
 * 是一个普通 JS 对象。这里只做「取默认值 + 类型校验」，不引入任何依赖，
 * 保证插件在只有 node 内置模块的情况下也能加载。
 */

/** 全部可配置项及其默认值。 */
export const DEFAULTS = {
  /** 总开关；false 时插件完全不注册任何东西。 */
  enabled: true,
  /**
   * 是否自动把历史会话摘要注入到系统提示词里。
   *
   * 默认 **false**：插件不会自作主张把整个项目的历史带进新会话。
   * 用户主动说「看看之前那个会话」时，才用 /recall 或 recall_sessions 去读。
   * 想要老行为（开局自动带上最近几个会话摘要）就把它改成 true。
   */
  autoInject: false,
  /** 自动注入模式下，每次最多纳入的旧会话数。 */
  maxSessions: 3,
  /** 自动注入模式下，每个会话最多渲染的轮次数（取最后 N 轮）。 */
  maxTurnsPerSession: 4,
  /** 清单模式下一次最多列出多少个会话。 */
  maxListSessions: 20,
  /** 详情模式下最多渲染多少轮。 */
  maxDetailTurns: 30,
  /** 详情模式下单条提问/回答的最大字符数。 */
  maxDetailChars: 1200,
  /** 单条标题的最大字符数。 */
  maxTitleChars: 120,
  /** 单条提问/回答预览的最大字符数。 */
  maxPreviewChars: 320,
  /** 整段摘要的最大字符数；超出则从最旧的会话开始丢弃。 */
  maxDigestChars: 6000,
  /** 是否包含最后一次会话（也就是当前这次）。 */
  includeCurrentSession: false,
  /**
   * 是否把「当前目录的父目录」下的会话也算进来。
   * 例如在 `D:\proj\sub` 开会话时，`D:\proj` 的历史也会被带上 —— 子目录开发时很有用。
   */
  includeParentCwds: true,
  /** 向上追溯几级父目录。 */
  maxParentLevels: 1,
  /** 摘要块在系统提示词上下文里的排序位置（只在 autoInject=true 时生效）。 */
  order: 108,
  /** 投影缓存判定为「新鲜」的时长（毫秒）；超出则回落到直接读会话日志。 */
  cacheFreshMs: 600000,
  /** 读取压缩会话日志时允许读入的最大字节（按**压缩态**算，即文件体积）。 */
  maxLogBytes: 8388608,
  /** 调试日志开关。 */
  verbose: false,
};

const INT_FIELDS = [
  "maxSessions",
  "maxTurnsPerSession",
  "maxListSessions",
  "maxDetailTurns",
  "maxDetailChars",
  "maxTitleChars",
  "maxPreviewChars",
  "maxDigestChars",
  "order",
  "cacheFreshMs",
  "maxLogBytes",
  "maxParentLevels",
];

const BOOL_FIELDS = ["enabled", "autoInject", "includeCurrentSession", "includeParentCwds", "verbose"];

/**
 * 把用户配置合并到默认值上，并校验类型。
 *
 * 非法值不抛异常（抛异常会让整个 profile 启动失败），而是记一条警告后回落到默认值，
 * 这样用户写错一个字段不会把 DSH 启动搞崩。
 *
 * @param {unknown} raw profile 传入的原始配置。
 * @param {(message: string) => void} [warn] 警告回调。
 * @returns {{ config: typeof DEFAULTS, warnings: string[] }}
 */
export function resolveConfig(raw, warn) {
  const warnings = [];
  const out = { ...DEFAULTS };

  if (raw === undefined || raw === null) return { config: out, warnings };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`配置必须是对象，收到 ${Array.isArray(raw) ? "数组" : typeof raw}；已全部使用默认值`);
    return { config: out, warnings };
  }

  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULTS)) {
      warnings.push(`未知配置项 ${key}，已忽略`);
      continue;
    }
    if (BOOL_FIELDS.includes(key)) {
      if (typeof value !== "boolean") {
        warnings.push(`${key} 必须是布尔值，收到 ${typeof value}；已用默认值 ${DEFAULTS[key]}`);
        continue;
      }
      out[key] = value;
      continue;
    }
    if (INT_FIELDS.includes(key)) {
      if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
        warnings.push(`${key} 必须是整数，收到 ${JSON.stringify(value)}；已用默认值 ${DEFAULTS[key]}`);
        continue;
      }
      if (value < 0) {
        warnings.push(`${key} 不能为负数，已用默认值 ${DEFAULTS[key]}`);
        continue;
      }
      out[key] = value;
      continue;
    }
    out[key] = value;
  }

  if (out.maxSessions > 50) {
    warnings.push(`maxSessions=${out.maxSessions} 过大，已收敛到 50`);
    out.maxSessions = 50;
  }
  if (out.maxTurnsPerSession > 50) {
    warnings.push(`maxTurnsPerSession=${out.maxTurnsPerSession} 过大，已收敛到 50`);
    out.maxTurnsPerSession = 50;
  }
  if (out.maxListSessions > 200) {
    warnings.push(`maxListSessions=${out.maxListSessions} 过大，已收敛到 200`);
    out.maxListSessions = 200;
  }
  if (out.maxDetailTurns > 500) {
    warnings.push(`maxDetailTurns=${out.maxDetailTurns} 过大，已收敛到 500`);
    out.maxDetailTurns = 500;
  }

  if (typeof warn === "function") for (const message of warnings) warn(message);
  return { config: out, warnings };
}
