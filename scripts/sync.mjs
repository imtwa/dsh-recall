/**
 * 把本仓库的插件源码同步到 DSH 插件目录。
 *
 * 为什么需要它：Windows 上 pnpm 的 `link:` 对非系统盘的路径会解析错，
 * 所以插件实体要放在系统盘，profile 再用 `link:` 指过来。源码留在仓库里
 * 方便改，改完跑这个脚本推过去。
 * macOS / Linux 上同样可用，只是那边直接 `link:` 仓库目录也没问题。
 *
 * 用法：
 *   node scripts/sync.mjs                      # 同步到 <DSH_HOME>/plugins/dsh-recall
 *   node scripts/sync.mjs --check              # 只比对，不写
 *   node scripts/sync.mjs --target /some/dir   # 指定目标目录
 *   DSH_HOME=/custom/.dsh node scripts/sync.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SRC = path.resolve(import.meta.dirname, "..");

/** 解析 DSH 主目录：优先 DSH_HOME，其次 ~/.dsh。跨平台。 */
function resolveHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === "string" && configured.trim()) {
    const raw = configured.trim();
    if (raw === "~") return os.homedir();
    if (raw.startsWith("~/") || raw.startsWith("~\\")) {
      return path.join(os.homedir(), raw.slice(2));
    }
    return path.resolve(raw);
  }
  return path.join(os.homedir(), ".dsh");
}

/** 解析 --target 参数。 */
function resolveTarget() {
  const argv = process.argv.slice(2);
  const index = argv.findIndex((arg) => arg === "--target" || arg === "-t");
  if (index >= 0 && argv[index + 1]) return path.resolve(argv[index + 1]);
  const inline = argv.find((arg) => arg.startsWith("--target="));
  if (inline) return path.resolve(inline.slice("--target=".length));
  return path.join(resolveHome(), "plugins", "dsh-recall");
}

const DST = resolveTarget();
const FILES = ["package.json", "cordis.patch.yml", "README.md", "PUBLISHING.md", "LICENSE"];
const DIRS = ["lib", "test", "scripts"];

const checkOnly = process.argv.includes("--check");

/** 递归列出目录下的文件绝对路径。 */
function walk(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** 收集要同步的 (源绝对路径, 相对目标路径) 列表。 */
function collect() {
  const items = [];
  for (const file of FILES) {
    const from = path.join(SRC, file);
    if (fs.existsSync(from)) items.push([from, file]);
  }
  for (const dir of DIRS) {
    for (const from of walk(path.join(SRC, dir))) {
      items.push([from, path.relative(SRC, from)]);
    }
  }
  return items;
}

function main() {
  const items = collect();
  if (items.length === 0) {
    console.error(`没有找到可同步的文件，源目录：${SRC}`);
    process.exitCode = 1;
    return;
  }

  let copied = 0;
  let same = 0;
  const changed = [];

  for (const [from, rel] of items) {
    const to = path.join(DST, rel);
    const src = fs.readFileSync(from);
    const exists = fs.existsSync(to);
    const dst = exists ? fs.readFileSync(to) : undefined;
    if (dst && src.equals(dst)) {
      same += 1;
      continue;
    }
    changed.push(rel);
    if (!checkOnly) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, src);
    }
    copied += 1;
  }

  console.log(`源目录：${SRC}`);
  console.log(`目标：  ${DST}`);
  console.log(
    `共 ${items.length} 个文件：${same} 个一致，${changed.length} 个${checkOnly ? "有差异" : "已同步"}`,
  );
  if (changed.length > 0) {
    for (const rel of changed) console.log(`  ${checkOnly ? "diff" : "copy"} ${rel}`);
  }

  if (checkOnly && changed.length > 0) {
    console.log("\n提示：跑 node scripts/sync.mjs 同步过去，然后重启 dsh 生效。");
    process.exitCode = 1;
    return;
  }
  if (!checkOnly && copied > 0) {
    console.log("\n同步完成。重启 dsh 生效。");
  } else if (!checkOnly) {
    console.log("\n已经是最新，无需同步。");
  }
}

main();
