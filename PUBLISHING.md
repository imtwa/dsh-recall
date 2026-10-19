# 发布与上架

面向维护者。用户只需要看 `README.md`。

---

## 1. 兼容性声明怎么填

DSH 插件市场（dsh-market）的卡片上会显示一个宿主要求徽章，比如 `DSH >=0.2.0-rc.1`。
它只认两种声明（判定逻辑见 dshmarket 的 `discovery-compatibility.ts`）：

| 声明位置 | 是否被采纳 |
| --- | --- |
| `package.json` 顶层 `engines.dsh` | ✅ 采纳 |
| `package.json` 里 `dsh.engines.dsh` | ✅ 采纳（两者都有时顶层优先） |
| `peerDependencies` 里 `@deepseek-ai/dsh-*` 且本机确实装了这个包 | ✅ 采纳 |
| `peerDependencies` 里 `@deepseek-ai/cordis` / `schemastery` | ❌ **明确排除** |

最后一行是关键：cordis 是宿主包，但不在 DSH 的 lockstep 0.x 发布线上，所以它说明不了
DSH 版本。**只声明 cordis peer 的插件会被标成「未声明宿主要求」**，本插件之前就是这样。

本插件现在的声明：

```jsonc
"engines": {
  "node": ">=20.11",           // node:zlib 的 zstdDecompressSync 需要
  "dsh": ">=0.1.0-rc.1"        // 市场据此显示徽章并判断兼容
},
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.1" // 插件契约；不参与宿主要求判定
}
```

`engines.dsh` 只是元数据，npm 不会拦安装（npm 只对 `engines.node` / `engines.npm` 生效），
所以写宽一点是安全的。这里**故意不写上界**：插件用的是
`ctx.systemPrompt.context()` / `ctx.commands.register()` / `ctx.tools.register()` 这套老接口，
读磁盘格式的部分读不动只会降级、不会崩，所以没必要替未来的版本预判「不兼容」。
真遇到宿主换代导致失效，再把上界收紧即可。

---

## 2. 上架 DSH 插件市场

市场里的列表来自精选目录 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：
`dsh-market` 每次打开都实时请求 `https://awesome-dsh-plugin.com/plugins.json`
（本机实测该文件约 4600 条）。**上架 = 往那个仓库提一个 PR。**

### 提交什么

一个 PR 加**一个文件**，放在 `data/plugins/` 下，文件名按仓库名来
（monorepo 子包用 `owner__repo--packages-my-plugin.yml`）：

```yaml
# data/plugins/<owner>__<repo>.yml
url: https://github.com/<owner>/dsh-recall-sessions   # 必须与仓库地址完全一致
name: <owner>/dsh-recall-sessions                     # 列表里显示的链接文字
category: memory
description:
  en: Cross-session memory for DeepSeek Harness, loaded on demand: list and load what earlier sessions did without polluting the current context.
  zh: DeepSeek Harness 跨会话记忆（按需）：列出并加载之前会话干了什么，不自动污染上下文。
```

要点：

- **只有 `description.en` 必填**；写不了中文可以只留 `en`，维护者会补。
- 描述里出现半角冒号加空格（`: `）必须给整个值加引号，否则 YAML 会被解析成嵌套键。
  中文全角冒号没这个问题。
- `category` 选贴合实际功能的那个，本插件用 `memory`。可选值：
  `agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun`。
- README 是**脚本生成的**，别手改；只改自己那个 yml。
- **一个 PR 最多 3 条**，超过会被 CI 拒。

### 硬性要求（会被 CI 自动检查）

1. `package.json` 里必须声明 `dsh.bundle` —— 这是 `dsh plugin add` 能装的前提。
   **最常见的被拒原因就是只声明了 `dsh.client`。** 本插件满足：

   ```jsonc
   "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
   ```

   仓库根还要有 `cordis.patch.yml`：

   ```yaml
   - insert:
       - id: dsh-recall-sessions
         name: 'dsh-recall-sessions'
   ```

2. 仓库**创建满 1 天**（过滤 PR 前几分钟才建的仓库）。
3. 仓库里有**真实可用的代码**，不是占位或纯 README。
4. 给仓库加 **`dsh-plugin`** 这个 GitHub topic。
5. 描述**必须属实**：写了几个工具就要真有几个，提到某个命令就要真存在。
   夸大是让一个本来不错的插件被打回的主要原因。
6. 项目处于活跃维护状态（长期停更会被定期扫描标记并移除）。

CI 的检查顺序是：条目数 → `dsh.bundle` → 仓库年龄 → `awesome-lint` 与站点构建。
失败时 CI 会指出要改什么，在同一个分支推修复即可，不用重开 PR。

### 可选但推荐

**截图**：在 `package.json` 旁边放 `screenshots.json`，列 1–8 张图片路径
（相对路径不能跳出插件目录，也不能用第三方图床，只认 GitHub 托管的 https）：

```jsonc
// screenshots.json
["assets/screenshot-1.png", "assets/screenshot-2.png"]
```

不声明也行，市场会从 README 里自动抽图；声明只是为了控制顺序和内容。

**预构建 tarball**（不想发 npm 时）：把 tarball 挂到 GitHub Release，
在条目 yml 里加 `tarball:` 字段：

```yaml
tarball: https://github.com/<owner>/dsh-recall-sessions/releases/latest/download/dsh-recall-sessions.tgz
```

⚠️ `latest/download/` 只在请求时解析 `latest`，文件名是照字面取的。
文件名带版本号的话，你下次发版这个链接就会 404。要么文件名不带版本，要么钉住 tag：

```yaml
tarball: https://github.com/<owner>/dsh-recall-sessions/releases/download/v0.1.0/dsh-recall-sessions-0.1.0.tgz
```

---

## 3. 发布到 npm

它就是一个普通的 ESM npm 包，没有任何运行时依赖：

```bash
npm publish
```

- `files` 白名单里要带上 `cordis.patch.yml`（漏了就装不上）；
- 想指定 registry 就加 `"publishConfig": { "registry": "..." }`；
- **`repository` 字段必须指回市场收录的那个仓库**，否则 npm 包和列表条目不会关联，
  市场也就显示不出下载量。这是刻意的：防止某个包挂到一个并未认领它的仓库上；
- 条目 yml 里**不要**手写 `npm:` 字段，映射由 registry 自动采集，手写会被校验拒；
- 建议 `prepublishOnly` 跑一遍 `node test/smoke.mjs`（本包已配）。

**发不发 npm 都不影响收录**，只影响市场能不能按下载量排序。

### peer 范围的预发布陷阱

官方 `@deepseek-ai/*` 包要用 `peerDependencies` 而不是 `dependencies`。
范围里**必须带一个显式的预发布分支**，否则会静默排除 harness 的所有预发布构建：

```jsonc
// ❌ 看着很宽，实际匹配不到 0.1.0-rc.6
"@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.2.0"

// ✅ 在 0.1.0 这个元组上带预发布标签
"@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0"
```

原因是 node-semver 只有在范围里**某个比较符**与该版本的 `major.minor.patch`
完全一致、且自身带预发布标签时，才放行这个预发布版本。

本插件不 import 任何 `@deepseek-ai/*`，所以不受这条影响；如果以后引入了宿主包，
按上面的写法声明。
