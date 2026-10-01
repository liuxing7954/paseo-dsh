# 把 DSH 接进 Paseo：改造指南

这份文档面向"我有 Paseo，我有一个自己的 agent 运行时，想把它们接起来"的人。
它不讲 Paseo 或 DSH 本身怎么用，只讲**之间那一层**是怎么搭的、哪里会塌、怎么确认它没塌。

按这里的步骤走，**Paseo 源码不需要改一行，你的 agent 运行时也不需要 fork**。

---

## 0. 先看架构，再动手

```
┌─────────┐   原生 provider 协议    ┌──────────────┐   stdio JSON-RPC   ┌──────────┐
│  Paseo  │ ◄────────────────────► │  Paseo 插件   │ ◄────────────────► │  bridge  │
│  界面    │   （进程内，私有）        │ (server.ts)  │   （你自己定的）      │  bundle  │
└─────────┘                        └──────────────┘                    └────┬─────┘
                                                                            │ 进程内
                                                                       ┌────▼─────┐
                                                                       │   DSH    │
                                                                       │ profile  │
                                                                       └────┬─────┘
                                                                            │ HTTP
                                                                       ┌────▼─────┐
                                                                       │  你的模型  │
                                                                       └──────────┘
```

三个关键事实：

1. **Paseo 侧走的是"direct provider plugin"，不是 ACP。** Paseo 的 `@getpaseo/plugin`
   暴露 `registerProvider()`，插件在 daemon 进程里直接提供模型目录、会话、时间线、
   权限卡片。这就是 Codex / Claude Code 那种"原生接入"的机制。
2. **一个会话 = 你的运行时一个进程。** 插件为每个 Paseo 会话起一个子进程，用
   stdio 上的换行分隔 JSON-RPC 通话。进程隔离意味着会话崩了不会拖垮 daemon。
3. **中间那层协议是你自己定的。** Paseo 的 provider 契约要遵守（这是硬约束），
   但插件和 bridge 之间怎么说话完全自由。**这既是自由度，也是最大的坑源**——见第 4 节。

---

## 1. 改动点清单

| # | 在哪 | 改什么 | 因人而异？ |
|---|------|--------|-----------|
| A | 你的运行时 | 一个 **profile**：把你的运行时组装成可被 stdio 驱动的一个 app | 结构固定，内容随你的运行时 |
| B | 你的运行时 | 一个 **bridge bundle**：实现 JSON-RPC 方法 | 一次性 |
| C | 你的运行时 | profile 里的 **模型路由声明**（含推理能力） | **每次换模型都要动** ← 见第 3 节 |
| D | Paseo | 一个 **provider 插件**：实现 Paseo 的 provider 契约 | 一次性 |
| E | Paseo | `~/.paseo/config.json` 里启用插件 | 一次性 |

**只有 C 是真正因人而异的。** A/B/D 都是"接一次，之后不动"的东西——所以别人要复用
你的成果，主要是复用 B+D，然后自己填 C。

> 用 DSH 举例：A = `dsh-bridge/cordis.patch.yml`，B = `dsh-bridge/lib/*.js`，
> C = `~/.dsh/profiles/<name>/cordis.patch.yml` 里的 `llm-pi-ai` 段，
> D = `paseo-plugin/server/*.ts`，E = `~/.paseo/config.json`。

---

## 2. 四个步骤

### 第 1 步：让运行时能被 stdio 驱动

你的运行时需要有一个"起一个进程，从 stdin 读请求，往 stdout 写响应"的模式。
**stdout 只能有协议帧**——任何一句话打到 stdout 都会破坏协议。日志一律走 stderr。

在 DSH 里这是一个 profile bundle。别人的运行时里可能是别的东西，但要求一样：
**一个进程，一条 stdio，帧格式自定，日志走 stderr。**

### 第 2 步：写 bridge，把 Paseo 的语义翻译成你的运行时的语义

bridge 要实现的方法不多，DSH 这边是这 8 个：

```
initialize          route + cwd，校验模型可用性
paseo/catalog       返回模型目录、模式、思考档位
session/prompt      发一条消息（要区分"新回合"和"插话"）
session/cancel      取消当前回合（保留会话！）
paseo/plan/get      读计划模式状态
paseo/plan/set      切换计划模式
paseo/config/set    切模型 / 切思考档位
shutdown            收尾
```

**最容易漏的一条：`session/cancel` 不是杀进程。** 见第 4.4 节。

### 第 3 步：声明你的模型能力 ← 这步每个人都不一样

Paseo 的模型选择器、思考档位选择器、图片上传按钮**全部由你报的能力驱动**。
报错了不会报错，只会"功能悄悄不对"。

**别猜，去探测。** 本仓库带了一个工具：

```bash
node tools/probe-provider.mjs \
  --base-url https://your-gateway/v1 \
  --api-key-env YOUR_API_KEY \
  --model your-model-id
```

它会直接打你的端点，回答两个决定配置的问题，并吐出可直接粘贴的片段：

```
model: deepseek-v4-flash
  baseline call .......... ok (reasoning content at baseline: yes)
  role=developer ......... REJECTED -> needs compat.supportsDeveloperRole: false
  reasoning_effort=low     accepted
  reasoning_effort=medium  accepted
  ...

  profile fragment:
          - id: deepseek-v4-flash
            reasoningEfforts:
              off:
              low: low
              medium: medium
```

把片段粘进 profile 的 provider 配置即可。两个要点：

- **`off` 必须留空。** 关掉思考的做法是**不发 `reasoning_effort` 参数**；多数网关
  拒绝字面量 `"off"`（`unknown variant`）。
- **`xhigh` / `max` 必须显式列出。** DSH 对这两档的处理和五个基础档不同：**缺键即视为
  不支持**，而不是取默认。漏了就是"为什么没有 max 档"。

### 第 4 步：验证

**不要靠肉眼看界面来验证。** 界面会乐观显示、会缓存、会骗你。要直接对着 bridge 打
协议帧，断言事件流。本仓库的 `harness/` 就是这套东西，第 5 节讲方法。

---

## 3. 配置：模型能力怎么声明

DSH 用 `dsh-llm-pi-ai` 接 OpenAI 兼容端点。**路由的推理能力不会自动发现**，必须声明：

```yaml
providers:
  your-route:
    api: openai-completions
    baseURL: https://your-gateway/v1
    apiKeyEnv: YOUR_API_KEY

    # 一旦声明了推理能力，pi-ai 会改用 OpenAI 推理模型的 `developer` 角色
    # 承载系统提示。网关不认就必须关掉，否则每个回合 422。
    compat:
      supportsDeveloperRole: false

    models:
      - id: your-model
        name: your-model
        reasoningEfforts:
          off:            # 留空 = 不发参数
          low: low
          medium: medium
          high: high
          max: max        # max/xhigh 必须显式列出
```

**`compat.supportsDeveloperRole: false` 和 `reasoningEfforts` 必须成对出现。**
只加后者会让每个回合 422 —— 这是最容易卡住人的一个组合坑。

如果探测下来**一个档位都不接受**，声明 `reasoningEfforts: false`，明确告诉 DSH
这是个不支持推理的路由，而不是省略字段让 DSH 去猜。

---

## 4. 踩坑清单

下面每一条都是真实发生过的：症状 → 根因 → 修法。**按教训分组，不是按 bug 分组**，
因为同类错误会反复犯。

### 4.1 教训一：不要自造协议形状，去抄 Paseo 自己的适配器

这是**最贵的一类错误**，我在这上面栽了四次。

| 症状 | 根因 | 修法 |
|------|------|------|
| 选 A 得到别的答案 | 我从 `selectedActionId` 取答案；Paseo 的共享提问 UI 实际把答案放在 `updatedInput.answers[header]` | 照抄 Paseo 自己的 provider 实现 |
| 3 个问题要点 3 次提交 | 我给每个问题发了一张权限卡。Paseo 的一次 `input.questions` 数组就是**一张卡、一次提交、步进式** | 把所有问题打包进一个 `input.questions` |
| 计划审批按钮文案怪异、出现重复选项 | 我在计划卡上自己造了 `actions`，和原生选择器重复了 | 提问卡**不要**带 `actions`；计划卡用 Codex 那两个 |
| 计划还没看到就要求批准 | 我把计划放进了 `description` | 计划放 `input.plan`；同时**另发一条时间线 `{type:"plan", text}`** 让它先可见 |

**方法：把 Paseo 的 `app.asar` 解开，找到它自己的 Codex / Claude Code 适配器，逐字照抄
它构造的对象。** 不要去推断"应该是什么形状"：

```bash
# 在 app.asar 里定位适配器源码
node -e '
const fs=require("fs");
const b=fs.readFileSync("/Applications/Paseo.app/Contents/Resources/app.asar");
const i=b.indexOf("buildPlanPermissionActions");
console.log(b.slice(i-200,i+900).toString());
'
```

Paseo 自己的实现就是最权威的协议文档，而且比你读类型定义快得多。

### 4.2 教训二：能力声明决定 UI，漏了功能会整个消失

| 症状 | 根因 | 修法 |
|------|------|------|
| 界面上**根本没有**插话入口 | `CAPABILITIES` 里漏了 `prompt.steer` | 声明它，并且用 `negotiateProviderCapabilities` 协商 |
| 界面给不支持的模型显示档位选择器 | provider 级默认值用了**所有模型档位的并集** | 改成**所有模型都支持的交集**；每模型自己的档位单独报 |
| 选了档位又被弹回 off | 声明了但校验时不认，于是被丢弃 | 报了就必须认；丢弃等于对用户撒谎 |

**规则：你报什么，UI 就长什么样；你没报的，能力再强用户也看不到。**
`prompt.steer`、`prompt.image`、`session.list` 这类能力位都是开关，漏一个就少一个功能，
而且**不会报任何错**。

### 4.3 教训三：静默降级是最贵的 bug

这一类最难发现，因为**什么都没坏，只是悄悄不对**。

| 症状 | 静默降级在哪 |
|------|-------------|
| 插话内容石沉大海 | `delivery: "steer"` 和普通消息都走 `followup()`，插话排到了下一个回合 |
| 图片凭空消失，模型还煞有介事地回答 | 非文本内容块被映射成空字符串，且 `contentBlocks` 传了 `undefined` |
| 用量读数永远空白 | 运行时把 token 记账挂在消息事件上，我从没转发（`session.usage` 从未发出） |
| 未知请求"成功"了 | `switch` 的 `default` 分支发的是 `request.completed` |

**规则：宁可响亮地失败，也不要安静地做错。** 具体做法：

- 不认识的输入类型 → 发 `request.failed` 并**点名类型**，不要假装成功
- 翻译不了的内容块 → **抛错**，不要跳过
- 该发的事件 → 检查是否真的发了（第 5 节的方法能查出来）

### 4.4 教训四：生命周期要和"会话"对齐，不是和"进程"对齐

| 症状 | 根因 | 修法 |
|------|------|------|
| 终止后再发消息就"续不上"了 | `interrupt()` 直接 `kill()` 了子进程 —— **杀进程 = 会话报废** | 接运行时的取消接口（DSH 是 `agent.cancel({kind:"user"})`），只取消当前回合 |
| 切模型/切模式时"未知会话"报错 | Paseo 会**只开会话读一下能力、从不发消息**，此时会话对象还不存在 | 让配置类操作可排队，别让它们依赖活会话 |

第二条值得展开：Paseo 的 `listDraftFeatures` 会调 `createSession` 然后读
`session.features`，**整个过程不 prompt**。如果你的 `planSet`/`configSet` 依赖一个
"已经有 agent 的会话"，这里必然报 `unknown or not-yet-created session`。

### 4.5 教训五：别硬编码你自己那套

给别人用的代码里，`provider ?? 'your-provider'` 这种默认值会让别人在
"完全没配"的情况下**跑在一个他不认识的模型上**。正确做法是从配置读，读不到就
**带着说明失败**：

```js
if (provider === undefined || model === undefined) {
  throw new Error('no provider/model was given and this profile configures no default model');
}
```

同理，"按 provider 名字猜要不要动态加载适配器"也应该变成显式配置（一个
`provider -> adapter 模块` 的映射），而不是 `if (provider !== 'some-name')`。

---

## 5. 验证方法论：怎么自己把问题找出来

界面不可信，日志太吵。**直接对 bridge 打协议帧**是最可靠的方式。

### 5.1 用一次性脚本断言事件流

写一个脚本，起 bridge 子进程，发 JSON-RPC，收集事件，断言：

```js
const ev = [];
connection.onEvent((e) => ev.push(e));

await c.send({ type: "session.open", /* ... */ });
await waitFor(ev, (e) => e.type === "session.ready");

await c.send({ type: "session.prompt", /* ... */ });
await waitFor(ev, (e) => e.type === "session.turn" && e.state === "completed");

// 断言，不要"看起来对了"
assert(ev.some((e) => e.type === "session.usage"), "usage 事件没发出来");
assert.equal(ev.filter((e) => e.type === "request.failed").length, 0);
```

**脚本里最容易骗自己的地方：`waitFor` 会匹配到上一条陈旧事件。** 换阶段时清空事件数组，
或者按 `turnId` 过滤。我有一次就是因为匹配到了被取消那一回合的 `completed`，
误判成"取消后对话无法继续"，差点去改一段本来正确的代码。

### 5.2 把运行时的事件全集拉出来对账

**这是找出"漏了什么"最有效的手段。** 运行时的事件类型是一个联合类型，把它枚举出来，
和你 `switch` 里处理的对比：

```bash
grep -n "'[a-z_]*/[a-z_]*':" <runtime>/lib/types/types.d.ts
```

DSH 有 13 种 session 事件，我只映射了 4 种 —— 对账之后才发现 `assistant/attempt`
承载着重试信息、`assistant/message` 里藏着从没转发过的 `usage`。

### 5.3 断言"没有静默降级"

专门测这些场景，每个都应该**要么正常、要么报错**：

- 发一条非文本内容（图片）→ 确认模型真的收到了
- 发一个不支持的输入类型 → 确认返回 `request.failed` 而不是 `request.completed`
- 切一个模型不支持的档位 → 确认被明确拒绝，而不是悄悄变成 off

### 5.4 TypeScript 项目：如何跑一次性验证脚本

插件是 ESM + TS，直接 `require` 会报 `ERR_MODULE_NOT_FOUND`（扩展名解析问题）。
转成 CJS 再跑：

```bash
npx tsc --noEmit false --outDir .dbg --declaration false \
  --module commonjs --moduleResolution node
echo '{"type":"commonjs"}' > .dbg/package.json
node .dbg/yours.cjs
rm -rf .dbg          # 记得清理
```

### 5.5 插件的加载时机

**插件改动不会热重载。** 改完要么重启 daemon，要么重载插件。
但 bridge 的子进程是**每个会话新起的**，所以 bridge 的改动会立即生效——
分清楚你改的是哪一层，能省很多次重启。

---

## 6. 给别人用：你需要开源什么

想让别人复用，真正需要交付的是**第 1 节里的 B 和 D**（bridge 和 provider 插件），
加上一份"怎么填 C"的说明。

- **B 和 D 与你的模型无关**，可以直接开源。
- **C 每个人不同**，所以别把它编译进代码——让它在配置里，并且把第 3 节的探测工具
  一起交出去。
- **删掉所有你自己的痕迹**：provider 名、模型 id、base URL、密钥环境变量名。
  默认值应该是"未配置"，而不是"我的配置"。

本仓库的目录就是按这个切的：

```
dsh-bridge/           ← 应交付：bridge bundle（你的运行时那一侧）
paseo-plugin/         ← 应交付：Paseo provider 插件
tools/probe-provider.mjs  ← 应交付：能力探测（帮别人填 C）
harness/              ← 可选：验证脚本，展示第 5 节的方法
docs/NOTES.md         ← 不交付：作者本机的具体配置与记录
```
