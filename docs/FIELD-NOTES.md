# 实战缺陷记录

这份文件是开发过程中**真实发生过**的问题清单，按发现顺序排列。每一条都写清了
症状、根因和修法。

它比 [ADOPTION.md](./ADOPTION.md) 更啰嗦——ADOPTION 把教训按主题归纳，这里保留
时间顺序和当时的错误判断。**如果你正在接自己的运行时，这份清单可以当检查表用。**

前 11 条来自界面反馈驱动的迭代，最后 4 条来自一次针对"未完成实现"的专项审计。

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

**修法**：显式列出 `max: max`。这一条现在由 `tools/probe-provider.mjs` 自动覆盖。

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

## 已知限制（未修，有意为之）

| 项 | 说明 |
|----|------|
| `assistant/attempt` 被丢弃 | 该事件承载失败/重试/取消的尝试，所以**重试在界面上不可见**。但 `AssistantStreamRecord` 没有错误变体，无法可靠区分"失败重试"和"用户主动取消"，乱加会在每次取消时刷噪音。 |
| 时间线只映射 13 种会话事件里的 4 种 | 其余多数是有意丢弃：`developer/message`、`system/message` 是系统提示，`request/header`、`request/context` 是内部记账。 |

## 关于"哪条路由能用"

这份记录里刻意不提任何具体的 provider、模型或端点——**你的路由和模型完全由你的
profile 决定**。同一个缺陷在不同人那里会表现成不一样的症状，所以照抄别人的路由表
没有意义，用 `tools/probe-provider.mjs` 测自己的才是正路。
