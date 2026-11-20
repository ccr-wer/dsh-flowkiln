# dsh-flowkiln — 把重复的 DSH 提示词炼成可审阅的 SKILL.md

DeepSeek Harness（DSH）插件：自动采集会话提示词 → 离线聚类出"重复工作流"候选 → 候选清单贴进对话 → **用户点头才**写成 `~/.dsh/skills/<name>/SKILL.md`，说不要则指纹-dismiss、永不再现。

与 codex-flowkiln（https://github.com/ccr-wer/codex-flowkiln）同一套审阅哲学，适配 DSH 的 Cordis 插件体系。

## 四段流水线

| 阶段 | 机制 | 成本 |
|---|---|---|
| collect | `agent/pre-step` waterfall 钩子，取最新一轮用户话术，脱敏后追加 `~/.dsh/flowkiln/prompts.jsonl` | 0 token |
| mine | TF-IDF 余弦 ≥0.72 **或** 共享实词 ≥3 双判据，簇 ≥3 条才成候选；零模型调用，确定性可复现 | 0 token |
| review | `flowkiln_list` 把清单渲染进对话；工具描述硬性约束模型：用户没点头不许 promote/dismiss | 0 token |
| act | `flowkiln_promote`（默认 dry-run，`apply:true` 才写盘）/ `flowkiln_dismiss`（骨架词指纹，重合 ≥75% 拉黑） | 0 token |

可选 `refine:true` 才花一次短 LLM 调用（`ctx.llm.stream`）润色技能名与描述，默认关闭。

## 真机验证（2026-11-19，DSH 桌面版 CLI，Windows 11）

方式：独立 `headless` profile + `--patch` 注入，未改动 desktop profile。

- 内核自测 `node bin/selftest.js` → **29/29 通过**
- 端到端：3 条相似中文提示词跨 3 个会话采集 → 聚类出 1 个候选（无关英文提示词未被误并）→ 清单进对话 → 用户批准后 `apply:true` 真实写入 `~/.dsh/skills/wf/SKILL.md`
- 审阅门禁实测生效：未获批准时模型明确拒绝执行 promote/dismiss

## 官方文档确认的两个坑（本插件已修复）

1. **`agent/pre-step` 是 waterfall**（官方插件教程/扩展点文档）：监听器签名是 `(payload, next)`，**必须 `await next()` 并返回其结果**，否则不是"加钩子"而是"把整条链替换成空"。之前用普通监听器短路了流水线，报 `Cannot read properties of undefined (reading 'kind')`。
2. **裸 `ctx.tools.register()` 的 `parameters` 必须是 JSON Schema object root**（`{ type:'object', properties, required }`）；`{ 字段: { type, required } }` 那种属性表是 `defineTool` 的 DSL，defineTool 会转换成规范 schema，裸注册则原样上线，root 无 `type`。官方 troubleshooting 记载此类坏 schema 会导致整个会话每轮请求都 400。

另一条教训：`ctx.effect(fn)` 会**立即执行** fn 作为 setup，返回值才是 cleanup——直接传 dispose 会在 apply 后把所有注册瞬间拆光。

## 已知限制

- 聚类骨架词可能抓到提示词里的套话（如测试里的"请只回复OK"），写成 `[TODO]` 步骤骨架需要人工修订；`refine:true` 可缓解命名问题
- `sanitizeName` 会剥掉 CJK 字符，纯中文候选 id 可能退化成短名（如 `wf`）——建议对中文候选开启 refine
- 集群判定是纯启发式，宁缺勿滥：簇 <3 条不出候选

## 文件

- `index.js` — 插件入口：采集钩子 + 4 个工具（mine/list/promote/dismiss）
- `lib/redact.js` — API key / token 脱敏
- `lib/miner.js` — TF-IDF + 共享实词双判据聚类
- `lib/store.js` — prompts.jsonl / candidates.json / dismissed.json（`DFK_DATA_DIR` 可覆盖）
- `lib/review.js` — 清单渲染 + dismiss 指纹过滤
- `lib/skill.js` — SKILL.md 生成（frontmatter + TODO 骨架，不覆盖已有技能）
- `bin/selftest.js` — 29 项内核自测
- `flowkiln.patch.yml` — headless 验证用 patch（file:// 绝对路径指向 index.js）

## 运行方式（验证用）

Windows（PowerShell，CLI 随桌面版安装）：

```powershell
$env:DEEPSEEK_API_KEY = "<你的 key>"
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" headless --patch ./flowkiln.patch.yml "<任意提示词>"
```

macOS / Linux：插件本体是纯 Node.js ESM，无需改动；只需把 patch 里的 `file:///D:/.../index.js` 换成你机器上的绝对路径，并按 DSH 在该平台的方式启动 CLI：

```bash
export DEEPSEEK_API_KEY="<你的 key>"
npx @deepseek-ai/dsh headless --patch ./flowkiln.patch.yml "<任意提示词>"
```

插件只依赖 `node:fs` / `node:path` / `node:os`，数据目录由 `homedir()` 推导（`~/.dsh/flowkiln`、`~/.dsh/skills`），可用 `DFK_DATA_DIR` / `DFK_SKILLS_DIR` 覆盖。
