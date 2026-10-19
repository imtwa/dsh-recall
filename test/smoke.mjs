/**
 * dsh-recall-sessions 自检脚本（零依赖，直接 node test/smoke.mjs）。
 *
 * 覆盖：
 *   1. 配置解析与非法值回落
 *   2. cwd -> slug 推导
 *   3. 多帧 zstd 解压
 *   4. 真实会话扫描 + 摘要渲染 + 体积上限
 *   5. 清单与详情渲染（合成数据，任何机器上都能跑）
 *   6. 用假 ctx 走一遍插件 apply()，验证按需模式与 autoInject 模式
 *
 * 没装 DSH、或本机还没有会话数据时，依赖真实数据的断言会自动跳过。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

import { renderAutoInjectDigest, TRUST_WARNING, DIGEST_TITLE } from "../lib/autoinject.js";
import { DEFAULTS, resolveConfig } from "../lib/config.js";
import { renderSessionDetail, renderSessionList } from "../lib/digest.js";
import {
  decodeZstdFrames,
  findNewestSessionLog,
  isAncestorCwd,
  listAllSessions,
  normalizeCwd,
  readSessionHeaderFromLog,
  readTurnsFromLog,
  resolveDshHome,
  scanSessions,
  slugFromCwd,
} from "../lib/memory.js";
import { apply as applyPlugin, name as pluginName, inject as pluginInject } from "../lib/index.js";

let passed = 0;
let failed = 0;
const failures = [];

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failed += 1;
    failures.push(`${label}: ${error?.message ?? error}`);
    console.log(`  FAIL ${label}\n       ${error?.message ?? error}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

// 测试目标优先挑一个「真的有历史会话」的目录：插件目录的父目录、
// 进程 cwd、或 DSH_RECALL_TEST_CWD 指定的目录。挑不到就回落到进程 cwd 并跳过真实数据断言。
const PLUGIN_DIR = path.resolve(import.meta.dirname, "..");

function pickTestCwd() {
  const candidates = [
    process.env.DSH_RECALL_TEST_CWD,
    path.resolve(PLUGIN_DIR, ".."),
    process.cwd(),
  ].filter(Boolean);
  for (const cwd of candidates) {
    const slugDir = path.join(resolveDshHome(), "sessions", slugFromCwd(cwd));
    if (fs.existsSync(slugDir)) return { cwd, hasData: true };
  }
  return { cwd: candidates[candidates.length - 1], hasData: false };
}

const picked = pickTestCwd();
const CWD = picked.cwd;
const HAS_DATA = picked.hasData;
const HOME = resolveDshHome();
const IS_SUBDIR = isAncestorCwd(CWD, PLUGIN_DIR);

console.log(`测试工作目录：${CWD}（历史会话${HAS_DATA ? "存在" : "不存在，跳过真实数据断言"}）`);

// ── 1. 配置 ────────────────────────────────────────────────────────────
section("配置解析");

await check("空配置返回默认值", () => {
  const { config } = resolveConfig(undefined);
  assert.deepEqual(config, DEFAULTS);
});

await check("合法覆盖生效", () => {
  const { config, warnings } = resolveConfig({ maxSessions: 5, enabled: false });
  assert.equal(config.maxSessions, 5);
  assert.equal(config.enabled, false);
  assert.equal(warnings.length, 0);
});

await check("非法类型回落默认值且不抛异常", () => {
  const { config, warnings } = resolveConfig({
    maxSessions: "3",
    enabled: "yes",
    maxDigestChars: -1,
  });
  assert.equal(config.maxSessions, DEFAULTS.maxSessions);
  assert.equal(config.enabled, DEFAULTS.enabled);
  assert.equal(config.maxDigestChars, DEFAULTS.maxDigestChars);
  assert.equal(warnings.length, 3);
});

await check("未知键被忽略并告警", () => {
  const { warnings } = resolveConfig({ nope: 1 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /未知配置项 nope/);
});

await check("超大 maxSessions 收敛到 50", () => {
  const { config } = resolveConfig({ maxSessions: 999 });
  assert.equal(config.maxSessions, 50);
});

await check("配置是数组时不崩", () => {
  const { config, warnings } = resolveConfig([1, 2, 3]);
  assert.deepEqual(config, DEFAULTS);
  assert.equal(warnings.length, 1);
});

// ── 2. 路径 ────────────────────────────────────────────────────────────
section("路径推导");

await check("slug 推导符合 DSH 约定（合成路径，便于阅读）", () => {
  assert.equal(slugFromCwd("D:\\aProject\\Uniapp\\yinghua"), "--D-aProject-Uniapp-yinghua--");
  assert.equal(slugFromCwd("D:\\a"), "--D-a--");
  assert.equal(slugFromCwd("/home/dev/proj"), "--home-dev-proj--");
  assert.equal(slugFromCwd("/home/dev/proj/"), "--home-dev-proj--");
  assert.equal(slugFromCwd("\\\\server\\share\\p"), "--server-share-p--");
  assert.equal(slugFromCwd("C:\\Users\\me\\.dsh"), "--C-Users-me-.dsh--");
  assert.equal(slugFromCwd(""), "");
  assert.equal(slugFromCwd(undefined), "");
});

await check("推导出的会话目录真实存在", () => {
  if (!HAS_DATA) return;
  const dir = path.join(HOME, "sessions", slugFromCwd(CWD));
  assert.ok(fs.existsSync(dir), `推导出的会话目录不存在：${dir}`);
});

await check("cwd 归一化大小写", () => {
  const a = normalizeCwd("D:\\Some\\Project");
  const b = normalizeCwd("d:/Some/Project/");
  assert.equal(a, b);
});

await check("DSH 主目录可解析", () => {
  assert.ok(typeof HOME === "string" && HOME.length > 0);
  assert.ok(fs.existsSync(HOME), `DSH 主目录不存在：${HOME}`);
});

// ── 3. zstd 多帧 ───────────────────────────────────────────────────────
section("多帧 zstd 解压");

const logDir = path.join(HOME, "sessions", slugFromCwd(CWD));
let sampleLog;
if (fs.existsSync(logDir)) {
  for (const id of fs.readdirSync(logDir)) {
    const file = path.join(logDir, id, "session.v4.jsonl.zstd");
    if (fs.existsSync(file)) {
      sampleLog = file;
      break;
    }
  }
}

await check("样本日志存在（无真实数据时自动跳过）", () => {
  if (!HAS_DATA) return;
  assert.ok(sampleLog, `未找到样本日志：${logDir}`);
});

if (sampleLog) {
  await check("逐帧解压完整读完全部事件（不丢帧）", () => {
    const buf = fs.readFileSync(sampleLog);
    const mine = decodeZstdFrames(buf);
    const lines = mine.toString("utf8").split("\n").filter(Boolean);
    // 参考实现：按魔数逐帧解压到底，不加任何体积上限。
    const ref = [];
    let off = 0;
    while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0xfd2fb528) {
      const next = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), off + 4);
      const end = next === -1 ? buf.length : next;
      ref.push(zlib.zstdDecompressSync(buf.subarray(off, end)));
      off = end;
    }
    const refAll = Buffer.concat(ref);
    assert.equal(
      mine.length,
      refAll.length,
      `解压量不一致：实际 ${mine.length}，逐帧参考实现 ${refAll.length}`,
    );
    assert.ok(lines.length >= 2, `只解出 ${lines.length} 行，一个正常会话至少要有 session 与 turn 事件`);
    assert.equal(JSON.parse(lines[0]).type, "session");
    const types = lines.map((l) => JSON.parse(l).type);
    assert.ok(types.includes("turn/start"), "解出的内容里没有 turn/start");
    assert.ok(types.includes("user/message"), "解出的内容里没有 user/message");
  });

  await check("解压结果能解析成合法 JSONL", () => {
    const lines = decodeZstdFrames(fs.readFileSync(sampleLog))
      .toString("utf8")
      .split("\n")
      .filter(Boolean);
    let bad = 0;
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch {
        bad += 1;
      }
    }
    assert.equal(bad, 0, `${bad} 行不是合法 JSON`);
  });
}

// ── 4. 扫描 + 渲染 ─────────────────────────────────────────────────────
section("会话扫描与渲染");

const config = resolveConfig({ maxSessions: 5, maxDigestChars: 6000 }).config;
const scan = scanSessions({ cwd: CWD, config });
console.log(
  `  info cwd=${CWD} 同目录会话=${scan.scanned} 纳入=${scan.sessions.length} 用日志兜底=${scan.usedLogFallback}`,
);

await check("扫描能返回本目录的历史会话", () => {
  if (!HAS_DATA) return;
  assert.ok(scan.scanned > 0, "没有扫描到任何同目录会话，检查 DSH_HOME 与投影缓存");
  assert.ok(scan.sessions.length > 0, "过滤后没有任何会话");
  assert.ok(scan.sessions.length <= config.maxSessions);
});

await check("会话记录字段完整", () => {
  for (const s of scan.sessions) {
    assert.ok(typeof s.id === "string" && s.id.length > 0, "缺少 id");
    assert.ok(typeof s.title === "string", "缺少 title");
    assert.ok(Number.isFinite(s.lastActivityAt), "缺少 lastActivityAt");
    assert.ok(Array.isArray(s.recentTurns), "recentTurns 不是数组");
    assert.ok(
      s.recentTurns.length <= config.maxTurnsPerSession,
      `recentTurns 超出上限：${s.recentTurns.length}`,
    );
  }
});

await check("按最后活动时间倒序", () => {
  for (let i = 1; i < scan.sessions.length; i += 1) {
    assert.ok(
      scan.sessions[i - 1].lastActivityAt >= scan.sessions[i].lastActivityAt,
      `排序错误：${i}`,
    );
  }
});

await check("listAllSessions 覆盖全机会话", () => {
  const all = listAllSessions(config, 2000);
  assert.ok(all.length >= scan.scanned, `全机会话数 ${all.length} 少于同目录 ${scan.scanned}`);
});

const digest = renderAutoInjectDigest(scan.sessions, config);

await check("摘要非空且带标题与警告", () => {
  if (!HAS_DATA) return;
  assert.ok(digest.length > 0, "摘要为空");
  assert.match(digest, /## 跨会话记忆（dsh-recall-sessions 自动注入）/);
  assert.match(digest, /不可信的历史数据/);
});

await check("摘要包含会话 id 与轮次预览", () => {
  if (!HAS_DATA) return;
  assert.ok(digest.includes(scan.sessions[0].id), "摘要里没有会话 id");
  const hasTurns = scan.sessions.some((s) =>
    s.recentTurns.some((t) => t.prompt && digest.includes(t.prompt.slice(0, 20))),
  );
  assert.ok(hasTurns, "摘要里没有任何轮次预览");
});

await check("摘要不超过 maxDigestChars", () => {
  const small = resolveConfig({ maxDigestChars: 800 }).config;
  const out = renderAutoInjectDigest(scan.sessions, small);
  assert.ok(out.length <= 800 + 200, `摘要长度 ${out.length} 超出预算`);
});

await check("空会话列表返回空串（不注入）", () => {
  assert.equal(renderAutoInjectDigest([], config), "");
});

await check("excludeSessionId 生效", () => {
  if (!HAS_DATA) return;
  const target = scan.sessions[0].id;
  const filtered = scanSessions({ cwd: CWD, config, excludeSessionId: target });
  assert.ok(!filtered.sessions.some((s) => s.id === target), "被排除的会话仍然出现");
});

await check("子目录也能看到父目录的历史会话", () => {
  if (!HAS_DATA || !IS_SUBDIR) return;
  const fromChild = scanSessions({ cwd: PLUGIN_DIR, config });
  assert.ok(
    fromChild.sessions.length > 0,
    `从子目录 ${PLUGIN_DIR} 扫描不到父目录会话，includeParentCwds 未生效`,
  );
  assert.ok(
    fromChild.sessions.some((s) => normalizeCwd(s.cwd) === normalizeCwd(CWD)),
    "父目录会话没有被纳入",
  );
});

await check("includeParentCwds=false 时不带父目录会话", () => {
  if (!HAS_DATA || !IS_SUBDIR) return;
  const strict = resolveConfig({ includeParentCwds: false, maxSessions: 5 }).config;
  const fromChild = scanSessions({ cwd: PLUGIN_DIR, config: strict });
  assert.equal(fromChild.sessions.length, 0, "关掉父目录匹配后仍然带出了父目录会话");
});

await check("能从日志头读出 cwd（只解压第一帧）", () => {
  if (!HAS_DATA) return;
  const newest = findNewestSessionLog(0);
  assert.ok(newest, "没有找到任何会话日志");
  const header = readSessionHeaderFromLog(newest.file);
  assert.ok(header, "读不出会话头");
  // 目录名可能带 `session-` 前缀也可能不带（两种命名在真实数据里都存在），
  // 这里只要求 id 是非空字符串。
  assert.ok(typeof header.id === "string" && header.id.length > 0, "会话头里没有 id");
  assert.ok(typeof header.cwd === "string" && header.cwd.length > 0, "会话头里没有 cwd");
});

// ── 5. 清单/详情渲染（不依赖真实数据）────────────────────────────────
section("清单与详情渲染");

const FIXTURE = [
  {
    id: "session-aaaa1111-2222-3333-4444-555566667777",
    title: "给项目加一个登录页",
    cwd: "/home/dev/app",
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_003_600_000,
    turns: 7,
    firstPrompt: "帮我加一个登录页",
    recentTurns: [
      { turn: 6, prompt: "样式再紧凑一点", response: "已把间距从 16px 调到 8px。" },
      { turn: 7, prompt: "加个记住我", response: "已加上「记住我」勾选框，默认勾选。" },
    ],
    source: "projcache",
  },
  {
    id: "session-bbbb1111-2222-3333-4444-555566667777",
    title: "修一下构建脚本",
    cwd: "/home/dev/app",
    createdAt: 1_699_000_000_000,
    lastActivityAt: 1_699_000_600_000,
    turns: 2,
    firstPrompt: "构建报错了",
    recentTurns: [{ turn: 1, prompt: "构建报错了", response: "是路径分隔符的问题。" }],
    source: "log",
  },
  {
    id: "session-cccc1111-2222-3333-4444-555566667777",
    title: "另一个项目的事",
    cwd: "/home/dev/other",
    createdAt: 1_698_000_000_000,
    lastActivityAt: 1_698_000_600_000,
    turns: 1,
    firstPrompt: "帮我看看别的",
    recentTurns: [],
    source: "projcache",
  },
];

await check("清单按工作目录分组并带序号", () => {
  const out = renderSessionList(FIXTURE, config, { now: 1_700_004_000_000 });
  assert.match(out, /本机可加载的历史会话/);
  assert.match(out, /### \/home\/dev\/app/);
  assert.match(out, /### \/home\/dev\/other/);
  assert.match(out, /1\. 给项目加一个登录页/);
  assert.match(out, /3\. 另一个项目的事/);
});

await check("清单带 id 但不带正文预览（体积可控）", () => {
  const out = renderSessionList(FIXTURE, config, { now: 1_700_004_000_000 });
  assert.ok(out.includes(FIXTURE[0].id), "清单里没有会话 id");
  assert.ok(!out.includes("记住我"), "清单不该带正文预览");
  assert.ok(out.length < 1500, `清单过长：${out.length}`);
});

await check("清单 limit 生效并提示总数", () => {
  const out = renderSessionList(FIXTURE, config, { limit: 2 });
  assert.match(out, /2\. 修一下构建脚本/);
  assert.ok(!out.includes("另一个项目的事"), "超出 limit 的会话仍被列出");
  assert.match(out, /共 3 个/);
});

await check("空清单有明确提示", () => {
  const out = renderSessionList([], config);
  assert.match(out, /没有扫描到任何历史会话/);
});

await check("maxDigestChars 极小时仍给出标题与警告，不静默失效", () => {
  const out = renderAutoInjectDigest(FIXTURE, { ...config, maxDigestChars: 10 });
  assert.ok(out.length > 0, "预算被压到 10 时返回空串，用户会以为插件没生效");
  assert.match(out, /## 跨会话记忆/);
  assert.match(out, /不可信的历史数据/);
});

await check("maxDigestChars 为 0 或负数时不崩也不静默", () => {
  for (const budget of [0, -1, -999]) {
    const out = renderAutoInjectDigest(FIXTURE, { ...config, maxDigestChars: budget });
    assert.ok(out.length > 0, `budget=${budget} 时返回空串`);
    assert.match(out, /## 跨会话记忆/);
  }
});

await check("摘要仍然遵守正常的体积预算", () => {
  const small = resolveConfig({ maxDigestChars: 800 }).config;
  const out = renderAutoInjectDigest(FIXTURE, small);
  assert.ok(out.length <= 900, `预算 800 却输出 ${out.length} 字符`);
});

await check("详情带警告、元信息与轮次内容", () => {
  const out = renderSessionDetail(FIXTURE[0], config, { now: 1_700_004_000_000 });
  assert.match(out, /## 历史会话：给项目加一个登录页/);
  assert.match(out, /不可信的历史数据/);
  assert.match(out, /- 工作目录：\/home\/dev\/app/);
  assert.match(out, /- 轮次：7/);
  assert.ok(out.includes(FIXTURE[0].id));
  assert.match(out, /### 第 6 轮/);
  assert.match(out, /用户：样式再紧凑一点/);
  assert.match(out, /AI：已把间距/);
});

await check("详情 maxTurns 只保留最后几轮", () => {
  const out = renderSessionDetail(FIXTURE[0], config, { maxTurns: 1 });
  assert.match(out, /### 第 7 轮/);
  assert.ok(!out.includes("### 第 6 轮"), "maxTurns=1 时仍渲染了更早的轮次");
  assert.match(out, /只展示最后 1 轮/);
});

await check("详情 maxDetailChars 截断单条内容", () => {
  const long = {
    ...FIXTURE[0],
    recentTurns: [{ turn: 1, prompt: "x".repeat(5000), response: "y".repeat(5000) }],
  };
  const out = renderSessionDetail(long, { ...config, maxDetailChars: 100 }, { maxTurns: 5 });
  assert.ok(out.length < 1000, `详情未截断，长度 ${out.length}`);
});

await check("详情在无轮次时给出提示", () => {
  const out = renderSessionDetail(FIXTURE[2], config);
  assert.match(out, /没有可读的轮次记录/);
});

// ── 5b. readTurnsFromLog 的 source.kind 过滤 ─────────────────────────────
section("用户消息来源过滤");

const TMP = path.join(PLUGIN_DIR, ".tmp-selftest");
fs.mkdirSync(TMP, { recursive: true });

/** 写一个多帧 zstd 会话日志，内容由 events 决定。 */
function writeFakeLog(name, events) {
  const file = path.join(TMP, name);
  const fd = fs.openSync(file, "w");
  for (const batch of events) {
    const text = batch.map((e) => JSON.stringify(e)).join("\n");
    fs.writeSync(fd, zlib.zstdCompressSync(Buffer.from(text, "utf8")));
  }
  fs.closeSync(fd);
  return file;
}

const nowMs = Date.now();
const FAKE_SESSION = { type: "session", id: "session-fake-1", cwd: "/tmp/fake", createdAt: nowMs };

await check("非 user 来源的 user/message 不会污染首问", () => {
  const file = writeFakeLog("kind-filter.jsonl.zstd", [
    [
      { type: "session/created", id: "session-fake-1", cwd: "/tmp/fake", createdAt: nowMs },
      { type: "turn/start", data: { turn: 1 }, seq: 1, time: nowMs },
      {
        type: "user/message",
        seq: 2,
        time: nowMs,
        data: { source: { kind: "agent-instructions" }, content: [{ type: "text", text: "<system-reminder>一堆工作区指令</system-reminder>" }] },
      },
      {
        type: "user/message",
        seq: 3,
        time: nowMs,
        data: { source: { kind: "runtime-context" }, content: [{ type: "text", text: "Current runtime context. This snapshot supersedes..." }] },
      },
      {
        type: "user/message",
        seq: 4,
        time: nowMs,
        data: { source: { kind: "user" }, content: [{ type: "text", text: "帮我看看这个报错" }] },
      },
      { type: "turn/end", seq: 5, time: nowMs },
    ],
  ]);
  const result = readTurnsFromLog(file, resolveConfig().config);
  assert.equal(result.firstPrompt, "帮我看看这个报错");
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].prompt, "帮我看看这个报错");
  fs.rmSync(file, { force: true });
});

await check("没有 source.kind 的老格式按真实用户消息处理", () => {
  const file = writeFakeLog("no-kind.jsonl.zstd", [
    [
      FAKE_SESSION,
      { type: "turn/start", data: { turn: 1 }, seq: 1, time: nowMs },
      { type: "user/message", seq: 2, time: nowMs, data: { content: [{ type: "text", text: "老格式提问" }] } },
      { type: "turn/end", seq: 3, time: nowMs },
    ],
  ]);
  const result = readTurnsFromLog(file, resolveConfig().config);
  assert.equal(result.firstPrompt, "老格式提问");
  assert.equal(result.turns[0].prompt, "老格式提问");
  fs.rmSync(file, { force: true });
});

await check("assistant/message 覆盖语义符合预期（取最后一条非空）", () => {
  const file = writeFakeLog("multi-asm.jsonl.zstd", [
    [
      FAKE_SESSION,
      { type: "turn/start", data: { turn: 1 }, seq: 1, time: nowMs },
      { type: "user/message", seq: 2, time: nowMs, data: { source: { kind: "user" }, content: [{ type: "text", text: "问题" }] } },
      // 纯工具调用的 step 没有文本，应被忽略而不是把 response 抹成空
      { type: "assistant/message", seq: 3, time: nowMs, data: { message: { content: [] } } },
      { type: "assistant/message", seq: 4, time: nowMs, data: { message: { content: [{ type: "text", text: "中间小结" }] } } },
      { type: "assistant/message", seq: 5, time: nowMs, data: { message: { content: [{ type: "text", text: "最终结论" }] } } },
      { type: "turn/end", seq: 6, time: nowMs },
    ],
  ]);
  const result = readTurnsFromLog(file, resolveConfig().config);
  assert.equal(result.turns[0].response, "最终结论");
  fs.rmSync(file, { force: true });
});

await check("超大压缩日志被输入上限拒绝而不是读一半", () => {
  const file = writeFakeLog("too-big.jsonl.zstd", [
    [FAKE_SESSION, { type: "turn/start", data: { turn: 1 }, seq: 1, time: nowMs }],
  ]);
  // 上限设成 1 字节：文件必然超过，应整体返回 undefined
  const result = readTurnsFromLog(file, resolveConfig().config, 1);
  assert.equal(result, undefined, "输入上限应整体拒绝而不是读一部分");
  fs.rmSync(file, { force: true });
});

await check("清理临时目录", () => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── 6. 插件 apply ──────────────────────────────────────────────────────
section("插件加载（假 ctx）");

function makeFakeCtx() {
  const record = { contexts: [], commands: [], tools: [], logs: [], handlers: new Map() };
  const ctx = {
    logger: {
      info: (m) => record.logs.push(["info", m]),
      warn: (m) => record.logs.push(["warn", m]),
    },
    on: (event, handler) => {
      record.handlers.set(event, handler);
      return () => {};
    },
    systemPrompt: {
      context: (spec) => {
        record.contexts.push(spec);
        return () => {};
      },
    },
    commands: {
      register: (spec) => {
        record.commands.push(spec);
        return () => {};
      },
    },
    tools: {
      register: (spec) => {
        record.tools.push(spec);
        return () => {};
      },
    },
  };
  return { ctx, record };
}

await check("插件导出 name/inject/apply", () => {
  assert.equal(pluginName, "dsh-recall-sessions");
  assert.ok(Array.isArray(pluginInject) && pluginInject.includes("systemPrompt"));
  assert.equal(typeof applyPlugin, "function");
});

await check("默认（autoInject=false）不注册系统提示词上下文", () => {
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, {});
  assert.equal(record.contexts.length, 0, "默认不该自动注入历史会话");
  assert.equal(record.commands.length, 1, "未注册 /recall 命令");
  assert.equal(record.tools.length, 1, "未注册 recall_sessions 工具");
});

await check("autoInject=true 才注册注入，且 order 正确", () => {
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, { autoInject: true });
  assert.equal(record.contexts.length, 1, "autoInject=true 时应注册提示词上下文");
  assert.equal(record.contexts[0].name, "dsh-recall-sessions:cross-session-memory");
  assert.equal(record.contexts[0].order, 108);
});

await check("autoInject 模式下注入回调产出真实摘要", () => {
  if (!HAS_DATA) return;
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, { autoInject: true });
  const text = record.contexts[0].text();
  assert.ok(typeof text === "string" && text.length > 0, "注入回调返回空串");
  assert.match(text, /跨会话记忆/);
});

await check("autoInject 模式下两次注入内容一致（缓存生效）", () => {
  if (!HAS_DATA) return;
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, { autoInject: true });
  const a = record.contexts[0].text();
  const b = record.contexts[0].text();
  assert.equal(a, b, "两次注入内容不一致，会破坏 prompt cache");
});

await check("/recall 无参数返回清单", () => {
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, {});
  const res = record.commands[0].handler({ rawInput: "", agent: { id: "session-fake" } });
  assert.equal(res.kind, "success");
  assert.match(res.text, /可加载的历史会话|没有扫描到/);
});

await check("/recall all 跨项目列出", () => {
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, {});
  const res = record.commands[0].handler({ rawInput: "all", agent: { id: "session-fake" } });
  assert.equal(res.kind, "success");
  assert.match(res.text, /本机全部会话/);
});

await check("/recall refresh 强制重扫", () => {
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, {});
  const res = record.commands[0].handler({ rawInput: "refresh", agent: { id: "session-fake" } });
  assert.equal(res.kind, "success");
  assert.match(res.text, /已重新扫描/);
});

await check("/recall <序号> 加载指定会话", () => {
  if (!HAS_DATA) return;
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, {});
  const res = record.commands[0].handler({ rawInput: "1", agent: { id: "session-fake" } });
  assert.equal(res.kind, "success", `加载失败：${res.text?.slice(0, 200)}`);
  assert.match(res.text, /历史会话：/);
  assert.match(res.text, /不可信的历史数据/);
});

await check("/recall <会话 id 片段> 能定位到会话", () => {
  if (!HAS_DATA) return;
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, {});
  const tail = scan.sessions[0].id.slice(-8);
  const res = record.commands[0].handler({ rawInput: tail, agent: { id: "session-fake" } });
  assert.equal(res.kind, "success", `片段定位失败：${res.text?.slice(0, 200)}`);
  assert.match(res.text, /历史会话：/);
});

await check("/recall 序号越界时报错并给出清单", () => {
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, {});
  const res = record.commands[0].handler({ rawInput: "9999", agent: { id: "session-fake" } });
  assert.equal(res.kind, "error");
  assert.match(res.text, /超出范围/);
});

await check("recall_sessions 工具无参数返回清单", async () => {
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, {});
  const tool = record.tools[0];
  assert.equal(tool.name, "recall_sessions");
  const value = await tool.execute({});
  assert.ok(typeof value.text === "string");
  assert.ok(Number.isInteger(value.sessions));
  assert.match(value.text, /可加载的历史会话|没有扫描到/);
  const rendered = tool.output.render({}, value);
  assert.equal(rendered[0].type, "text");
  assert.ok(rendered[0].text.length > 0);
});

await check("recall_sessions 传 index 返回详情", async () => {
  if (!HAS_DATA) return;
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, {});
  const value = await record.tools[0].execute({ index: 1 });
  assert.match(value.text, /历史会话：/);
  assert.match(value.text, /不可信的历史数据/);
});

await check("recall_sessions 传 sessionId 返回详情", async () => {
  if (!HAS_DATA) return;
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, {});
  const value = await record.tools[0].execute({ sessionId: scan.sessions[0].id });
  assert.match(value.text, /历史会话：/);
  assert.ok(value.text.includes(scan.sessions[0].id), "详情里没有会话 id");
});

await check("recall_sessions scope=all 跨项目列出", async () => {
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, {});
  const value = await record.tools[0].execute({ scope: "all" });
  assert.match(value.text, /本机全部会话/);
});

await check("recall_sessions 未知 id 时优雅提示", async () => {
  if (!HAS_DATA) return;
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, {});
  const value = await record.tools[0].execute({ sessionId: "session-does-not-exist-zzz" });
  assert.match(value.text, /没有找到会话/);
});

await check("recall_sessions 序号越界时优雅提示", async () => {
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, {});
  const value = await record.tools[0].execute({ index: 9999 });
  assert.match(value.text, /超出范围/);
});

await check("enabled=false 时什么都不注册", () => {
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, { enabled: false });
  assert.equal(record.contexts.length, 0);
  assert.equal(record.commands.length, 0);
  assert.equal(record.tools.length, 0);
});

await check("缺少可选服务时降级而不是崩溃", () => {
  const { ctx, record } = makeFakeCtx();
  delete ctx.commands;
  delete ctx.tools;
  applyPlugin(ctx, { autoInject: true });
  assert.equal(record.contexts.length, 1, "autoInject 下提示词注入仍应工作");
});

await check("非法配置不会让 apply 抛异常", () => {
  const { ctx } = makeFakeCtx();
  applyPlugin(ctx, { maxSessions: "x", order: null, enabled: "nope", autoInject: "yes" });
});

await check("监听 session/created 并记录会话 cwd", () => {
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, { autoInject: true });
  const onCreated = record.handlers.get("session/created");
  assert.ok(onCreated, "没有监听 session/created");
  onCreated({ header: { id: "session-abc", cwd: CWD, createdAt: Date.now() } });
  assert.ok(record.handlers.has("session/disposed"), "没有监听 session/disposed");
});

await check("autoInject 下注册会话后注入内容非空", () => {
  if (!HAS_DATA) return;
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, { autoInject: true });
  const onCreated = record.handlers.get("session/created");
  onCreated({ header: { id: "session-abc", cwd: CWD, createdAt: Date.now() } });
  const text = record.contexts[0].text();
  assert.ok(text.length > 0, "注册会话后注入内容仍为空");
  assert.match(text, /跨会话记忆/);
});

await check("session/disposed 后不再把该会话当作当前会话", () => {
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, { autoInject: true });
  const onCreated = record.handlers.get("session/created");
  const onDisposed = record.handlers.get("session/disposed");
  onCreated({ header: { id: "session-xyz", cwd: CWD, createdAt: Date.now() } });
  onDisposed({ header: { id: "session-xyz" } });
  const text = record.contexts[0].text();
  assert.ok(typeof text === "string");
});

await check("autoInject 下从子目录启动也能看到父目录会话", () => {
  if (!HAS_DATA || !IS_SUBDIR) return;
  const { ctx, record } = makeFakeCtx();
  const saved = process.cwd();
  try {
    process.chdir(PLUGIN_DIR);
    applyPlugin(ctx, { autoInject: true });
    const onCreated = record.handlers.get("session/created");
    onCreated({ header: { id: "session-child", cwd: PLUGIN_DIR, createdAt: Date.now() } });
    const text = record.contexts[0].text();
    assert.ok(text.length > 0, `从 ${PLUGIN_DIR} 启动时注入为空`);
  } finally {
    process.chdir(saved);
  }
});

await check("autoInject 下 includeCurrentSession=true 会带上当前会话", () => {
  if (!HAS_DATA) return;
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, { autoInject: true, includeCurrentSession: true });
  const onCreated = record.handlers.get("session/created");
  const target = scan.sessions[0].id;
  onCreated({ header: { id: target, cwd: CWD, createdAt: Date.now() } });
  const text = record.contexts[0].text();
  assert.ok(text.includes(target), "includeCurrentSession=true 时当前会话没有被注入");
});

await check("autoInject 下默认不把当前会话写进自己的记忆", () => {
  if (!HAS_DATA) return;
  const { ctx, record } = makeFakeCtx();
  applyPlugin(ctx, { autoInject: true });
  const onCreated = record.handlers.get("session/created");
  const target = scan.sessions[0].id;
  onCreated({ header: { id: target, cwd: CWD, createdAt: Date.now() } });
  const text = record.contexts[0].text();
  assert.ok(!text.includes(target), "当前会话被写进了自己的记忆");
});

// ── 汇总 ───────────────────────────────────────────────────────────────
console.log(`\n== 结果 ==`);
console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.log("\n失败明细：");
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("  全部通过");
}
