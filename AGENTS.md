# 给 AI Agent 的说明

这个文件有两个用途，按你来的目的看对应那节。

---

## 一、如果你是被用户叫来"安装这个东西"的

完整的分步指令在 [README 的「复制这段给你的 AI Agent」](./README.md#-复制这段给你的-ai-agent推荐)
一节。照那份走，不要自己发明流程。

动手前必须先完整读 [docs/ADOPTION.md](./docs/ADOPTION.md)——它解释了架构和已知的坑，
跳过它几乎必然踩到配置里的两个陷阱。

三条最容易犯的错，先记住：

1. **不要自己编模型配置。** 用 `npx paseo-dsh probe` 探测出结果（仓库里的
   `tools/probe-provider.mjs` 是同一个实现的瘦启动器），原样采用。
2. **安装命令是 `paseo plugin add npm:paseo-dsh`。** 它会打印一条「Plugins are trusted,
   unsandboxed code...」安全提示——先把原文转述给用户并取得同意，再执行安装。
   插件首次加载会自己建好 DSH profile，**不需要再跑 `install.sh`**。
3. **不要把 API key 写进任何会被提交的文件**。它在 `~/.dsh/.credentials.yaml`。
4. **装完/改完配置后跑 `npx paseo-dsh doctor`** 确认全绿，再重启 daemon。

---

## 二、如果你是被叫来"改这个仓库"的

### 架构是三段，别搞混

```
Paseo  ⇄  paseo-plugin/（direct provider 插件，跑在 daemon 进程里）
              ⇄  dsh-bridge/（stdio JSON-RPC，每个会话一个子进程）
                 ⇄  DSH profile
```

- **Paseo 源码不需要改，DSH 也不需要 fork。** 两边都走公开扩展点。
- `paseo-plugin/server/*.ts` 是 Paseo 那一侧的契约实现；`dsh-bridge/lib/*.js` 是
  运行时的桥接。**中间那层协议是这个仓库自己定的**，改它要同时改两边。

### 改之前先读

- [docs/FIELD-NOTES.md](./docs/FIELD-NOTES.md) — 19 个真实缺陷。里面有整整一类错误叫
  **静默降级**（把不知道的东西当成成功、把不支持的能力悄悄丢掉）。改动前先看一遍，
  避免重新发明这些 bug。
- [docs/ADOPTION.md](./docs/ADOPTION.md) 第 4 节 — 教训按主题归纳。

### 硬性约束

| 约束 | 原因 |
|---|---|
| **不要自造协议形状** | Paseo 自己的 Codex / Claude 适配器就是权威协议文档。提问卡和计划卡的形状必须和它一致，否则界面会以奇怪的方式坏掉 |
| **能力声明要和数据源一致** | 声明了什么，UI 就长成什么样。漏声明 = 功能消失（不报错）；过度声明 = 用户选了却被丢弃（更糟） |
| **失败要响亮** | 不认识的输入类型发 `request.failed`，不要发 `request.completed`；翻译不了的内容块抛错，不要跳过 |
| **取消是取消回合，不是杀进程** | 杀进程会连会话一起报废 |
| **不要硬编码某个人的 provider/model** | 这个仓库是给别人用的。路由从 profile 读，读不到就带说明失败 |
| **改了 `dsh-bridge/` 必须重生成内嵌桥** | `paseo-plugin/server/bridge-assets.ts` 是桥的 base64 内嵌副本，供插件自举 profile（Paseo 安装插件不跑脚本）。跑 `node paseo-plugin/scripts/generate-bridge-assets.mjs`（`npm publish` 的 `prepack` 也会跑），并提交生成结果 |

### 改完怎么验证

界面不可信，断言要打在协议层：

```bash
npx paseo-dsh doctor          # 一眼看安装是否完整：CLI/版本/profile/bridge/路由/key
node harness/catalog.mjs      # provider / 模型 / 每个模型的真实思考档位
node harness/probe.mjs        # 端到端提问往返
node harness/route-test.mjs   # 逐条路由跑真实回合
cd paseo-plugin && npx tsc --noEmit
```

**动了插件层（`paseo-plugin/server/*.ts`）就一定跑 `harness/plugin-check.cjs`**——
它断言的是事件形状，而事件形状错了界面不会报错，只会悄悄不对。运行步骤写在那个文件
的头部注释里（插件是 TS，要先编成 CJS 才能 require）。

**注意一个反直觉的坑**：`waitFor` 式的等待会匹配到上一条陈旧事件。换阶段时清空事件数组，
或按 `turnId` 过滤——有一次就是因为匹配到了被取消那一回合的事件，误判成"取消后对话
无法继续"，差点去改一段本来正确的代码。

### 提交前

- 跑一遍 `node --check` / `tsc --noEmit`
- 确认没有引入任何具体的 provider 名、模型 id、base URL、密钥
- 用户本机路径（`/Users/...`）不要出现在任何文件里
