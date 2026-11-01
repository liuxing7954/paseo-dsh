# 实战缺陷记录

这份文件是开发过程中**真实发生过**的问题清单，按发现顺序排列。每一条都写清了
症状、根因和修法。

它比 [ADOPTION.md](./ADOPTION.md) 更啰嗦——ADOPTION 把教训按主题归纳，这里保留
时间顺序和当时的错误判断。**如果你正在接自己的运行时，这份清单可以当检查表用。**

前 11 条来自界面反馈驱动的迭代，接下来 4 条来自一次针对"未完成实现"的专项审计，
最后 1 条来自"重载一个正在运行的会话"这条平时不会走的路径。

---

## 第一轮：基础契约

### 1. 会话事件信封解包

**症状**：时间线上只有用户消息，助手回复、推理、工具调用全部丢失。

**根因**：线上事件结构是 `{type, seq, time, data}`，载荷在 `data` 里，我按平铺结构读了。

**修法**：所有处理器统一从 `event.data` 取载荷。

### 2. draft features 会话

**症状**：每次改配置都报 `unknown or not-yet-created session: <id>`。

**根因**：Paseo 会调 `createSession` **只为读 composer 特性，从不 prompt**。我的
`plan/*` 和 `config/set` 依赖"agent 已存在"。

**修法**：配置类操作改为记录**待生效意图**（`pendingPlanMode`、路由、思考档位），
agent 创建时再应用。

### 3. sessionId 冲突

**症状**：Paseo 刷新/重连后用同一 id 重开会话，agent 直接报废。

**根因**：DSH 会持久化会话，同 id 再创建时回 `already exists`。

**修法**：捕获该错误后转为 `ctx.agents.resume`，历史与可用性都保住。

### 4. 无效思考档位

**症状**：切到模型不支持的档位会让**整个回合失败**。

**根因**：运行时对不支持的档位是硬拒绝，不是忽略。

**修法**：按 catalog 校验后再下发；不支持的档位忽略并记日志。

---

## 第二轮：协议错配（因为自造形状）

这一轮最贵。第一轮修复时我自创了不少协议形状，反而把 Paseo 自带的能力弄坏了。
最终全部改为**照抄 Paseo 自己的 Codex / Claude 适配器**。

### 5. 选项答非所问

**症状**：提问时选 A，结果给了个 B。

**根因**：Paseo 的共享提问 UI 通过 `updatedInput.answers[question.header]` 回答案
（字符串，多选用逗号连接）。我只读 `selectedActionId`，取不到就回退到第一个选项。

**修法**：按 `header` 取值，给缺失 `header` 的问题补答案键，`selectedActionId` 仅作兜底。

### 6. 每个问题都要提交一次

**症状**：3 个问题要点 3 次提交；期望是步进式、一次提交。

**根因**：我把每个问题拆成了独立卡片。Paseo 的设计是**一张卡片装多个问题**：
`input.questions` 数组配步进式选择器。

**修法**：整批问题合成一张卡片、一次提交。

### 7. 看不到计划就被要求批准

**症状**：直接弹出同意/拒绝，看不到计划内容。

**根因**：我自作聪明把计划从时间线里删了，只留审批卡。

**修法**：Paseo 的 Codex 适配器是**两个东西一起发**——时间线上一条
`detail: { type: "plan", text }` 的可读计划卡片，加一张审批卡片。照做。

### 8. 计划卡片形状自造

**症状**：计划卡片文案怪异，出现重复选项。

**根因**：计划该放 `input.plan`，我放了 `description`；按钮自己造了一套。

**修法**：按钮用 `Dismiss(deny, danger, dismiss)` + `Implement(allow, primary, implement)`，
与 Codex 的 `buildPlanPermissionActions()` 完全一致。提问卡**不要**带 `actions`。

### 9. 思考档位被弹回 off

**症状**：选好档位，一批准计划就变回 off。

**根因**：我给「不支持推理的模型」造了一个全局兜底 `off/low/high/max`，于是不支持
推理的模型也显示选择器；选中后校验又判定不支持而丢弃，Paseo 便把选择器弹回 off。

**修法**：`configState()` 只报**当前模型自己声明**的档位，没有就整个不显示；
provider 级默认值改成**所有模型都支持的交集**而不是并集。

### 10. 不支持插话 steer

**症状**：界面上根本没有插话入口。

**根因**：`prompt.steer` 是 Paseo 的能力位，我压根没声明。

**修法**：声明它并通过 `negotiateProviderCapabilities` 协商；`delivery: "steer"` 走
`agent.steer()`（注入当前回合），而不是 `followup()`（排在下一个回合）。

> 同一类错误后来又犯了两次：漏声明 `prompt.image` 让图片根本发不出去（见第 16 条），
> 漏声明 `prompt.command` 让 `/` 菜单一个命令、一个技能都不显示。**能力位是开关，
> 不是"锦上添花"**——漏了它功能整个消失，且不报任何错。声明完还要真的把数据补上：
> 命令目录走 `session.commands` 事件，缺了它菜单照样是空的。

### 11. 终止后对话就废了

**症状**：终止一次之后，再发消息就"续不上"了。

**根因**：`interrupt()` 直接 `kill()` 掉了子进程——**杀进程 = 会话报废**。我当时还在
注释里自我辩解"桥接没有取消方法，结束进程是诚实的选择"。

**修法**：新增 bridge 的 `session/cancel` → `agent.cancel({ kind: "user" })`，
只取消当前回合，会话与历史保留。

> **教训**：注释里开始给自己找理由（"诚实的选项"、"暂时只能这样"）就是信号。
> 这类地方几乎总是可以在上游找到正确的接口。

---

## 第三轮：能力声明与模型配置

### 12. 模型明明能推理，DSH 说不行

**症状**：某条中转路由上的模型没有任何思考档位可选；显式传 `reasoningEffort` 直接报
`does not support reasoning effort "high"`。

**根因**：**DSH 内置目录里这条路由没有推理元数据**，不是模型能力缺失。实测该网关：

- 基线响应就带 `reasoning_content`，`usage` 里有 `reasoning_tokens`（本来就在推理）
- 接受 `reasoning_effort`，且各档会真实改变推理 token 预算
- 但拒绝 `reasoning_effort: "off"`（`unknown variant`）

**修法**：在 profile 里声明 `reasoningEfforts`。

### 13. 声明推理后每个回合 422

**症状**：加上 `reasoningEfforts` 后，每个回合都失败：
`422 messages[0].role: unknown variant 'developer'`。

**根因**：一旦声明了推理能力，pi-ai 会改用 OpenAI 推理模型的 `developer` 角色承载
系统提示，而 DeepSeek 网关只认 `system`。

**修法**：同时设 `compat.supportsDeveloperRole: false`。**这两处必须成对出现**。

### 14. 没有 max 档位

**症状**：加上了档位声明，但只有 low/medium/high，没有 max。

**根因**：DSH 对 `xhigh`/`max` 的处理和五个基础档位不同——**缺键即视为不支持**，
而不是取默认值。

**修法**：显式列出 `max: max`。这一条现在由 `npx paseo-dsh probe`（仓库里是
`tools/probe-provider.mjs`，同一实现）自动覆盖。

---

## 第四轮：专项审计发现的静默降级

这一轮针对"未完成实现"做了一次专项检查。标记类注释（TODO/FIXME）一个都没有，
但**结构性的漏**藏得很深——靠关键字找不到，必须做交叉核对。

### 15. `session.usage` 从未发出

**症状**：用量读数永远是空的。

**根因**：DSH 把 token 记账挂在 `assistant/message` 事件上（它没有独立的用量记录），
我从没转发过 `session.usage`。

**修法**：在会话事件处理里映射并转发。字段对应关系：
`inputTokens` → `inputTokens`，`cacheReadTokens` → `cachedInputTokens`，
`outputTokens` → `outputTokens`。

### 16. 非文本内容块被静默丢弃（图片：三层，修了三次才通）

**症状**：发图片时，图片凭空消失，模型还煞有介事地回答了一个纯文本问题。

**根因（第一层）**：bridge 和 `DshProcess` **都已经支持** content blocks（含 attachment
store），只有最上层把它们映射成空字符串并传了 `undefined`——典型的"管线铺好但没接线"。

**修法（第一层）**：原样透传；遇到没有对应类型的块**抛错**而不是跳过。

**但这一层修完图片仍然不通**——因为它其实断了三层，每层都不报错：

| 层 | 症状 | 根因 | 修法 |
|----|------|------|------|
| Paseo 插件 | 带图 prompt 被直接拒绝：`Provider does not support prompt.image` | `CAPABILITIES` 里漏了 `prompt.image`，`negotiateProviderCapabilities` 把它过滤掉了 | 在 `CAPABILITIES` 里声明 `prompt.image` |
| DSH 请求投影 | 图片到了 DSH，但模型收到的是 `[image omitted because this model accepts text only; ...]` 占位文本 | 路由没声明图片模态，默认按 `[text]` 投影，图片被换成文字 | profile 里 `defaultInput: [text, image]` 或模型条目 `input: [text, image]` |
| bridge 附件入库 | 报错 `Declared image type does not match its bytes.` | Paseo 按**文件名后缀**判定 `mimeType`；一张 JPEG 存成 `.png` 就会以 `image/png` 声明 JPEG 字节，DSH 校验声明与字节后拒绝 | bridge 按**魔数嗅探**真实类型，不信任声明的 `mimeType` |

**教训**：一条"数据丢失"路径往往横跨多个组件，**每个组件都认为自己的上游/下游会处理**。
第一层修好时模型能"看到"附件已存在的证据（占位文本），但真正的像素仍被下一层丢掉。
判断图片是否真的通了，不能看"有没有报错"，要看模型描述的内容是否只有图片里才有。
`harness/plugin-check.cjs` 现在会断言 `prompt.image` 被声明，正是为了钉住第二层。

### 17. `sessions` 处理器硬编码返回 `[]`

**症状**：无（因为 `session.list` 能力没声明，Paseo 不会问）。

**根因**：桩代码。真被调到就是在撒谎——明明有会话却报空列表。

**修法**：删除该死代码；未知输入类型统一走下面第 18 条的失败分支。

### 18. 未知请求被报成"成功"

**症状**：无（同上，静默）。

**根因**：`send()` 的 `switch` `default` 分支发的是 `request.completed`。任何没实现的
输入类型都会被当成正常完成。

**修法**：改发 `request.failed` 并点名类型。

> **教训**：`default:` 分支里"当作成功处理"是静默降级的经典形态。
> 它和第 11 条的 `kill()` 属于同一类错误——**看起来能用，实际在骗人**。

---

## 第五轮：重载后会话不可恢复

### 19. 插件重载 / daemon 重启后，正在跑的会话挂掉且无法恢复

**症状**：改了插件或重启 daemon 之后，原本在跑的 agent 报
`[System Error] Provider connection closed`；继续对话则报
`Invalid plugin provider persistence handle`，再也接不上。

根因有**两层**，缺一层都修不好：

| 层 | 症状 | 根因 | 修法 |
|----|------|------|------|
| Paseo ↔ 插件 | 重开时报 `Invalid plugin provider persistence handle` | 插件从没在 `session.opened` 里给 `persistence`，Paseo 的 `describePersistence()` 返回 null，退化成 `{provider, sessionId:<裸id>}`；重开时它自己的 `decodePersistenceId` 要求 `sessionId` 以 `plugin:` 开头，于是解码失败 | 声明 `session.persistence` 能力，并在 `session.opened` 里带 `persistence: {version, data}` |
| 插件内部（bridge） | 即便拿到合法 handle，resume 也会抛 `cannot get property "sessions" without inject` | resume 分支里用了 `this.ctx.sessions`——cordis 里**没 inject 的服务必须用 `ctx.get()` 访问**，直接取属性会抛 | 改成 `this.ctx.get('sessions')` / `this.ctx.get('sessionProjections')` |

**判定标准**：DSH 会持久化会话（jsonl），所以只要能重开、且 `sessionId` 一致，
`ctx.agents.resume` 就能把历史接回来。可以这样自测：起一个 dsh→让它记住一个词→杀掉
进程→再起一个→用同一个 `sessionId` 问它那个词。答得出，说明恢复链路是通的。

> **教训**：`Provider connection closed` 只是"重载杀进程"的表象，真正让人接不上的是
> **能力位没声明 + 一个 inject 违规**。两个都不会在正常使用中报错，只有"重载一个活着的
> 会话"这条路径才会把两者同时暴露出来——所以**重载测试要单独做**，别指望日常冒烟能覆盖。

### 20. 升到 DSH 0.2.1-rc 后每个回合都失败

**症状**：升级 DSH（`0.2.0-rc.2` → `0.2.1-rc.2`）后，所有回合直接失败；时间线上只有一条
空的 `[error]`，用量/重放都跟着空。界面看不出原因。

**根因**：`0.2.1` 收紧了 system-prompt 的模板变量——**只注册 `provider` 和 `model`**，
`{{cwd}}` 不再存在。而 bridge 的 `system-prompt.personaSuffix` 和 `preset-standard` 的人设里
都写了 `Your working directory is {{cwd}}.`，于是每个回合在提示词装配阶段就抛：
```
unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, model
```

**修法**：删掉人设里的 `{{cwd}}`（`dsh-bridge/cordis.patch.yml` 与 profile 的 `preset-standard`）。
模型的工作目录由运行时上下文/工具侧提供，不靠这个变量。删掉后对 `0.2.0` 也无害（只是少一句
cwd 提示）。

**同一版本还有第二个坑**：`0.2.1` 的模型目录是**异步物化**的。Paseo 的 catalog 探测**故意不
`initialize`**（避免钉住路由），于是启动瞬间读到的 `models` 恒为 0 —— 表现是 **provider 可用、
但模型选择器里一个模型都没有**。修法：catalog 里先用 profile 默认路由做一次
`resolveCallConfig` warm-up，再对空结果做**有界重试**（~3s），等适配器注册完。

> **教训**：**升级上游运行时属于"重载之外的第二条隐藏路径"**。它不会改你的代码，却会因为
> 提示词变量、插件 schema、服务名、异步就绪时机这类"软契约"让功能静默失效。升版后必须重跑
> `plugin-check`，而不是只看 `doctor`（`doctor` 只查安装完整性，查不出回合层失败和空目录）。

### 21. 往对话框拖一个文件，整个会话就"挂"了

**症状**：把任意非图片文件拖进 Paseo 输入框发送后，回合失败；再发消息报
`Provider session … is stale after its plugin reloaded`，重试变成
`has no pending run`。每次重试都会新开一个 `dsh` 进程，但会话立刻又被判死。

**根因**：Paseo 把文件作为 `uploaded_file` 内容块送进来，`toDshContent` 只认 text/image，
直接抛 `unsupported prompt content type "uploaded_file"`——而且抛在 `try` **外面**。异常一路
冒到 `provider.send()` 的兜底 catch，被当成 `session.runtime_failed` 上报；Paseo 于是把这个
provider 会话标记为 terminal。空闲会话再发消息就只会走"从 persistence 重开"，于是出现一串
新 session id 和连续的 stale。

**修法**：`uploaded_file`、forge/GitHub/review 附件都降级成文本引用（文件名、类型、大小、
绝对路径，或 title/url/body），模型可以直接 `read`/`read_image`；同时把内容块转换挪进 `try`，
以后单条消息失败不再升级成会话失败。

> **教训**：**单条 prompt 的校验错误绝不能用会话级错误上报**。`session.runtime_failed`
> 会让 Paseo 永久放弃这个会话，代价和"这条消息发不出去"完全不对等。

### 22. 上下文用量一直是"暂无上下文数据"

**症状**：Paseo 输入框旁的上下文环永远空着，`session.usage` 只有 `inputTokens` /
`cachedInputTokens` / `outputTokens`，没有 `contextWindowUsedTokens` 与
`contextWindowMaxTokens`。

**根因**：Paseo 用这两个字段画上下文条，而插件只转发了 DSH `assistant/message` 里的计费
用量。DSH 的"当前上下文占用"不在消息里，它由 `tokenMeter` 在需要时**重放会话日志**算出，
窗口容量要从 `llm.resolveModelInfo()` 取；两者都没人调。

**修法**：bridge 新增 `paseo/usage`，用 `sessionProjections` 的 `contextPressure`（有采样时）
或 `tokenMeter.measure()`（没有采样时）取占用，用当前路由的 `resolveModelInfo()` 取容量；
`session.usage` 改成**合并发布**（Paseo 每次整体替换 usage，分开发会把另一半擦掉）。在会话
打开/恢复、回合结束、切模型、压缩后刷新；同一时刻只允许最新一次查询落地。

> **注意**：`contextPressure` 在 DSH 0.2.1 里没有 `projectedTokens` 字段（只有
> `pressureTokens`/`surfaceTokens`），代码对两者都做了兜底。恢复会话时 `paseo/usage` 必须
> `getOrCreateSession`，否则 agent 还没建出来，占用永远是空的。

### 23. `paseo plugin add npm:paseo-dsh` 在 Paseo 0.11 及更早装不上

**症状**：安装直接失败：
```
Could not resolve type dependency "@getpaseo/protocol/agent-types"
imported by .../paseo-dsh/server/session.ts
```

**根因**：插件里有一句 `import type { JsonValue } from "@getpaseo/protocol/agent-types"`。
`@getpaseo/protocol` 只是 optional peer，永远不会被装进插件目录；而 Paseo **0.12.0 之前**的
插件编译器会解析所有 type-only import，解析不到就报错。0.12.0 才加了"跳过
`@getpaseo/protocol/` 类型导入"的豁免，所以 0.12+ 一直正常，0.9–0.11 全坏。

**修法**：`JsonValue` 是结构性类型，改成插件内本地声明（`server/json-value.ts`），并删掉这个
peer/dev 依赖。这样 `requirements.paseo: ">=0.9.2"` 才名副其实。

> **教训**：声明的最低兼容版本必须真的装得上。类型导入"反正会被擦除"的直觉只在编译器眼里
> 成立，安装器会把它当成需要解析的依赖。

### 24. 「逐字显示」第一版是事后回放，不是真流式

**症状**：回答看起来在逐字出现，但第一个字要等整段生成完才出现；长回答更像一段"快进动画"。

**根因**：第一版订阅的是 DSH 的 `data.stream`——它在一步结束时才随完整 `assistant/message`
一起到达，是"每个分片什么时候出现"的时间表。等整段到齐再按 `dt` 定时空放，UI 机制和真流式
一样（同一个 timeline id 连续更新），但帧是补出来的。

**修法**：改订阅 `agent/assistant-stream` 的瞬时帧（`start` / `text-delta` /
`reasoning-delta` / `end`）：bridge 原样转发，插件按 40ms 合并累积文本，用
`assistant:${turn}:${step}` / `reasoning:${turn}:${step}` 这两个最终 id 发快照；step 结束时
的持久消息作为权威快照原地覆盖。打断、退出、新回合时先 flush 或丢弃缓冲。推理帧也要一起
转发，否则思考行会在回答之后才出现，顺序颠倒。

> **教训**：**"看起来在流"不等于"边生成边到"**。判断标准只有一个：第一个字出现的时刻，
> 是不是模型吐出第一个字的时刻。

### 25. 不要在插件时间线行上猜宿主的间距

**症状**：统计行在原生皮肤下离页脚很远，在第三方主题下又贴得太近；改成自动测量后，收缩一次位置就变，
展开时还会盖住页脚。

**根因**：插件只能改自己 item 的外边距，而 Paseo 的回合页脚挂在消息内部还是作为兄弟节点、在统计行上方
还是下方，会随主题和回合状态变化。测量结果里又包含自己刚刚施加的位移，形成自激，越量越偏。

**结论**：不做自动贴靠。插件只负责内容，位置交还给宿主和主题；需要间距时由主题自己调。

> **2026-10-30 补记**：上面这条结论针对的是"写死常量"和"自激"（量到的位置里混进了自己刚施加的
> 位移，越量越偏）。把这两个前提拆掉之后，贴靠可以重新做，而且不必猜：
>
> - **不自激**：量之前先扣掉自己已经施加的边距，`row.top - appliedLift`；
> - **不猜对象**：只有服务端打了 `final` 的行才动，且上方块里必须找得到"以复制开头、是该块
>   最后一行文字"的那一行，量到的间距还要落在 0–4 个行高内；
> - **不猜数字**：间距、缩进、行高全部是页脚字号的分数（`gap = 0.46em`），没有魔数像素；
> - **不会停在错的位置**：新回合把上一轮顶下去时，盒子只移动不改变尺寸，所以同时监听
>   `ResizeObserver` 和 `childList` 的 `MutationObserver`，合并成一次延迟 60ms 的测量；
> - native 仍然不补偿（没有 DOM 可量），宁可多留白也不压字。
>
> 实测（桌面端，13px 页脚）：最新回合与"被顶下去"两种状态都收敛到 4.5px 的视觉间距，
> 顶下去的那一刻最多有约 100ms 的过渡。

### 26. 预设在建会话时丢失，会话头永远停在 standard

**症状**：新建会话前就选好了预设，聊天行为有时对有时不对；`meta.agentPreset` 却一直是 `standard`。

**根因**：Paseo 的预设选项是会话级的——`session.open` 时 `settings` 还是空的，选中值在 open 之后才通过
`setFeature` 发过来。插件此时已经在 `loadCommands()` 里创建了 agent，桥接层只能把预设放进队列；
如果 `createSession` 已经按默认值 resolve 完，这个队列就永远不会被消费。会话打开时那次 usage
探测（`getOrCreateSession`）还会让 agent 创建得更早，把窗口拉大。

**修法**：把预设随 open 传给 `DshProcess`，在 `initialize` **之前**用 `paseo/config/set` 排队；桥接层的
`createSession` 会 resolve 这个队列，agent 以该预设创建，会话头记录正确值。迟到的选择仍由
`select` 和"首条消息前补应用"兜底。

> **教训**：**只在创建时才知道的元数据，必须在创建动作之前送到**。事后再 select 只能改运行状态，
> 改不了会话头；而排队的值如果错过了消费点，就是静默丢失。

---

## 已知限制（未修，有意为之）

| 项 | 说明 |
|----|------|
| `assistant/attempt` 被丢弃 | 该事件承载失败/重试/取消的尝试，所以**重试在界面上不可见**。但 `AssistantStreamRecord` 没有错误变体，无法可靠区分"失败重试"和"用户主动取消"，乱加会在每次取消时刷噪音。 |
| 时间线只映射 13 种会话事件里的 4 种 | 其余多数是有意丢弃：`developer/message`、`system/message` 是系统提示，`request/header`、`request/context` 是内部记账。 |

## 关于"哪条路由能用"

这份记录里刻意不提任何具体的 provider、模型或端点——**你的路由和模型完全由你的
profile 决定**。同一个缺陷在不同人那里会表现成不一样的症状，所以照抄别人的路由表
没有意义，用 `npx paseo-dsh probe` 测自己的才是正路。
