# DeepSeek Harness × Paseo（原生接入）

[中文](README.md) · [English](README.en.md)

把 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) 作为 Paseo 的**一等公民 provider**
接进来。不 fork Paseo、不 fork DSH，全部走公开扩展点：Paseo 侧是 direct provider 插件，
DSH 侧是一个 profile bundle。

> 这不是 ACP 接入。ACP 缺三样东西，而 Paseo 的原生 provider 协议恰好都有。

**一行安装：** `paseo plugin add npm:paseo-dsh` · npm 包
[npmjs.com/package/paseo-dsh](https://www.npmjs.com/package/paseo-dsh) · 装完只差
[填模型路由](#安装推荐一行)，详见下方。

| 能力 | ACP 接入 | 本项目 |
| --- | --- | --- |
| `ask_user_question` 提问卡片 | ❌ 模型看不到该工具，也没有应答方 | ✅ Paseo 原生卡片，步进式选项，一次提交 |
| 计划模式 | ❌ ACP 不承载 modes/plans | ✅ 编辑器里的 Build / Plan 开关，计划先展示再审批 |
| 思考强度 | ⚠️ 取决于模型 | ✅ 按每个模型**真实声明**的档位渲染 |
| 插话（steer） | — | ✅ 注入当前回合，而不是排到下一个 |
| 图片（多模态） | ⚠️ 多数不承载 | ✅ 附件入库后按路由模态投递（需在 profile 声明图片模态） |
| 斜杠命令 / 技能 | ⚠️ 多为命令子集 | ✅ `/` 菜单列出 DSH 命令与 user-invocable 技能；命令在运行时执行，技能按 `/name` 注入 |
| 权限模式（沙箱） | ❌ 无统一开关 | ✅ composer 里的 **Permissions** 下拉，切换 DSH 的沙箱 + 审批预设 |
| 人设预设（Preset） | ❌ | ✅ profile 挂了 agent-preset registry 时，composer 出现 **Preset** 下拉（建会话时选、首回合后锁定） |
| 会话恢复 / 导入 | ❌ 无历史、无法导入 | ✅ 重开按 Paseo 的 `history: replay` 回放历史；**导入** DSH 原生会话（`session.list`，从 `~/.dsh/sessions` 列举） |
| 对话 rewind | ❌ | ✅ 在用户消息上回退对话；DSH 用 fork 保留该消息之前的事件，不改动工作区文件 |
| 终止后续聊 | — | ✅ 只取消当前回合，会话保留 |

## 🤖 复制这段给你的 AI Agent（推荐）

把下面整段复制进 Claude Code / Codex / Cursor / 任何能执行命令的 Agent。它会读文档、
探测你的模型、装好一切，**你只需要最后重启一次 Paseo**。

> 它需要读写 `~/.dsh/` 和 `~/.paseo/`、执行 shell 命令。给它这些权限，但**先自己扫一眼
> 下面的内容**——它做的事和你想让它做的事应该是一致的。

````text
你是一个部署助手，帮我把这台机器上的 Paseo 接上 DeepSeek Harness（DSH）。

仓库：https://github.com/liuxing7954/paseo-dsh
先完整读一遍 docs/ADOPTION.md 再动手。不要凭猜测改任何文件。

■ 第一步：检查前提
确认 dsh、paseo、node 都在 PATH 上，且 paseo 版本 >= 0.9.2。
缺任何一样就停下来告诉我，不要替我安装它们。

■ 第二步：确定用哪个模型
先看我已经有没有 DSH profile：ls ~/.dsh/profiles/
如果已有，读它的 cordis.patch.yml，【复用我已经配好的 provider】
（baseURL、apiKeyEnv、模型 id），不要让我重新输一遍。
如果确实没有，再问我这三件事：
  1. LLM 端点 baseURL 是什么
  2. API key 放在哪个环境变量里（或者我直接给你 key）
  3. 要用哪些模型 id
拿到 key 后写进 ~/.dsh/.credentials.yaml 的 refs 段。
不要把 key 写进任何会被提交的文件，也不要在终端回显它。

■ 第三步：探测模型能力（关键，不许跳过）
  npx paseo-dsh probe --base-url <端点> --api-key-env <变量名> --model <模型id>
它输出的 YAML 片段【原样采用】。它会顺便告诉你两个必须处理的坑：
  - 如果 developer 角色被拒 -> 配置里必须有 compat.supportsDeveloperRole: false
  - reasoningEfforts 里的 off 必须留空（不写值）
  - 如果探测出 max，必须显式写进配置
如果探测工具报错，把完整错误贴给我，不要自己编一个配置。

■ 第四步：安装
把 Paseo 会打印的那段「Plugins are trusted, unsandboxed code...」安全提示
【原文转述给我】，并明确问我是否继续。得到我同意之后再装：
  paseo plugin add npm:paseo-dsh
（插件首次加载会自己准备好 DSH profile，不需要跑任何脚本。）
装完重启 Paseo daemon。

■ 第五步：写配置
把第三步探测出的片段填进 ~/.dsh/profiles/paseo/cordis.patch.yml，
并补一段 agent-default-model 指向我选的主模型。
如果那个文件里已经有内容，只做补充，不要覆盖。

■ 第六步：验证（不许跳）
  npx paseo-dsh doctor
确认全绿（dsh/paseo 版本、profile、bridge、路由、key）。有问题就修，修完再跑一次。
然后重启 Paseo daemon。

■ 第七步：汇报
告诉我：
  - 需要重启什么（Paseo daemon）
  - 重启后我在 Paseo 里该选哪个 provider
  - 任何你没做到、或者不确定的地方

全程卡住就停下来问我。不要猜，不要跳过验证，不要为了让流程走完而伪造成功。
````

## 安装（推荐，一行）

用 Paseo 自己的插件安装器：

```bash
paseo plugin add npm:paseo-dsh
paseo plugin ls          # 确认 dsh-paseo 已装
```

插件**首次加载会自己准备好 DSH profile**（`~/.dsh/profiles/paseo`）和内嵌的 stdio
bridge——不用 clone、不用跑脚本。更新同样只走 Paseo 这一条链路：npm 源用
`paseo plugin update`，Git 源用 `git pull`，然后重启 daemon，profile 会随插件一起更新。

装完之后还差**一步：填模型路由**（这一步因人而异，没法自动）。分两小步：

### a) 告诉 DSH 去哪个端点、用哪些模型

编辑 `~/.dsh/profiles/paseo/cordis.patch.yml`。插件已生成一份带注释的模板，
**文件已存在时绝不覆盖**。一个完整例子（把 `my-gateway` / 端点 / 模型 id 换成你自己的）：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      my-gateway:                       # 路由名，随便取，下面要一致
        displayName: My Gateway
        apiKeyEnv: MY_GATEWAY_API_KEY   # 指向 .credentials.yaml 里的键名（见 b）
        api: openai-completions
        baseURL: https://your-gateway/v1
        # 网关只认 system 角色、拒绝 developer 角色时必须加，否则每个回合 422
        compat:
          supportsDeveloperRole: false
        # 网关支持视觉才写；不写默认 [text]，图片会被换成占位文本
        defaultInput: [text, image]
        models:
          - id: your-model-id           # 端点上的模型 id
            name: your-model-id
            reasoningEfforts:           # 支持推理才写；不支持写 false
              off:                      # 留空 = 不发参数（多数网关拒绝字面量 "off"）
              low: low
              medium: medium
              high: high
              max: max                  # max/xhigh 必须显式列出，缺键=不支持
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: my-gateway
    model: your-model-id
```

### b) 放 API key

写进 `~/.dsh/.credentials.yaml`（**不要**写进任何会被提交的文件）：

```yaml
version: 1
refs:
  MY_GATEWAY_API_KEY: sk-xxxxxxxx
```

### c) 自检 + 重启

```bash
npx paseo-dsh doctor
```

它会检查 `dsh`/`paseo` 版本、profile 是否就绪、bridge 是否落地、路由是否填好、
`apiKeyEnv` 对应的 key 是否存在——缺什么直接告诉你（只读，不改任何东西）。全绿后
**重启 Paseo daemon**（`paseo daemon restart`），在 Paseo 里新建会话时选
**DeepSeek Harness (native)** 这个 provider。

> **不确定端点支不支持推理 / thinking 档位 / vision？** 用同一个 CLI 探测你的端点，
> 它会直接打过去、把上面 a) 那段填好吐给你（同样不需要 clone）：
>
> ```bash
> npx paseo-dsh probe \
>   --base-url https://your-gateway/v1 \
>   --api-key-env MY_GATEWAY_API_KEY \
>   --model your-model-id
> ```
>
> 两个最容易卡住的点它会替你确认：网关拒绝 `developer` 角色 → 要加
> `compat.supportsDeveloperRole: false`；`off` 档位必须留空。

**完整走查与踩坑清单见 [docs/ADOPTION.md](docs/ADOPTION.md)。**

相关地址：npm 包 <https://www.npmjs.com/package/paseo-dsh> · Paseo 社区目录
<https://paseo.cafe/plugins/dsh-paseo> · 讨论帖
<https://github.com/getpaseo/paseo/discussions/6375>

## 本地开发 / 离线安装

改本仓库代码时，用 `install.sh` 把 checkout 作为**目录源**接入：它会建好 profile、
把 `dsh-bridge` 链进 profile，并替你注册插件。之后 `git pull` + 重启 daemon 即生效。

```bash
git clone https://github.com/liuxing7954/paseo-dsh && cd paseo-dsh
./install.sh --check     # 先看前提条件，不做改动
./install.sh             # 创建 profile + 链接 bridge + 注册插件
```

> 开发时改了 `dsh-bridge/`，记得跑 `node paseo-plugin/scripts/generate-bridge-assets.mjs`
> 重新内嵌 bridge（`npm publish` 也会自动跑），否则插件自举用的还是旧桥。

安装脚本不会覆盖你已有的模型配置，动到的每个文件都会先备份。

## 组成

```
paseo-dsh/
├── dsh-bridge/          # DSH 侧：stdio 桥接 bundle
│   ├── lib/index.js     #   插件入口：命令行、stdin 生命周期、提问桥接
│   ├── lib/transport.js #   自带 JSON-RPC 行传输（支持 server→client 请求）
│   ├── lib/server.js    #   会话/计划/思考档位/catalog 的实现
│   └── cordis.patch.yml #   bundle 补丁：往 dsh-base 上挂桥接与提问工具
├── paseo-plugin/        # Paseo 侧：provider 插件（direct provider 实现；npm 包 paseo-dsh）
│   ├── index.server.ts  #   registerProvider() + 首次加载时自举 DSH profile
│   ├── server/
│   │   ├── provider.ts  #   连接、catalog、会话生命周期、权限卡片
│   │   ├── session.ts   #   单会话：提问→卡片、计划、思考档位、用量
│   │   ├── dsh-process.ts # 一个会话一个 dsh 子进程
│   │   ├── timeline.ts  #   DSH 会话事件 → Paseo 时间线
│   │   ├── bootstrap.ts #   自举：写 profile 文件 + 把内嵌 bridge 落盘
│   │   └── bridge-assets.ts # 生成物：bridge 的 base64 内嵌副本
│   ├── lib/             #   doctor（自检）/ probe（能力探测）
│   └── bin/paseo-dsh.mjs#   npx paseo-dsh {doctor|probe}
├── tools/               # 探测工具的瘦启动器（实现在 paseo-plugin/lib 里）
├── templates/           # profile 配置模板（含必踩的坑的注释）
├── harness/             # 独立探针，不依赖 Paseo 即可验证桥接与插件
└── docs/                # 改造指南 + 实战缺陷记录
```

## 工作原理

```
模型调用 ask_user_question
   └─ dsh-tool-ask-user → ctx.userQuestions.ask()
        └─ dsh-bridge: ctx.on('user-questions/request')
             └─ transport.request('paseo/question')   ← server→client 请求
                  └─ paseo-plugin: session.permission (kind: 'question', input.questions[])
                       └─ Paseo 渲染一张卡片，步进式选完所有问题，一次提交
                  ← 返回 { behavior:'allow', updatedInput:{ answers: { <header>: "B" } } }
             ← 返回 { answers:[{id, selected:['canary']}] }
        ← 工具返回，模型继续
```

关键点：**DSH 官方两个自动化协议都没有「服务端主动问客户端」这条通道**——ACP 明确不
承载 elicitation，SDK 协议里传输层支持但服务端从不发送。所以桥接自带了传输层，
把这个能力补上。

每个 Paseo 会话对应一个独立的 `dsh --profile <name>` 子进程，通过 stdio 上的换行分隔
JSON-RPC 通信。会话之间进程隔离，一个崩了不会拖垮 daemon。

## 自测 / 本地验证（不需要 Paseo）

**先跑随包 CLI 自检**（只读，不改任何东西）：

```bash
npx paseo-dsh doctor          # 安装完整性：CLI/版本/profile/bridge/路由/key
npx paseo-dsh probe --base-url <端点> --api-key-env <变量名> --model <模型id>   # 端点能力
```

**再对协议层做断言**（界面不可信，事件流才可信）：

```bash
node harness/catalog.mjs      # 列出 provider / 模型 / 每个模型真实支持的思考档位
node harness/probe.mjs        # 端到端跑一轮提问往返
node harness/route-test.mjs   # 逐个路由测试可用性

# 插件层检查（断言事件形状，不看界面）
cd paseo-plugin
npx tsc --noEmit false --outDir .dbg --declaration false \
  --module commonjs --moduleResolution node
echo '{"type":"commonjs"}' > .dbg/package.json
cp ../harness/plugin-check.cjs .dbg/ && cd .dbg && node plugin-check.cjs
rm -rf ../.dbg
```

`plugin-check.cjs` 覆盖三件**曾经静默出错**的事：用量事件有没有真数字、非文本内容块
有没有被悄悄丢掉、未知输入是报失败还是谎报成功。这三类 bug 在界面上看不出来——
不报错，只是悄悄不对。

验证方法本身也值得一读——界面会乐观显示、会缓存、会骗你，所以断言要打在协议层。
[ADOPTION.md 第 5 节](docs/ADOPTION.md) 讲了具体做法，包括一些反直觉的坑
（比如 `waitFor` 会匹配到陈旧事件，导致误判）。

## 环境要求

- Paseo ≥ 0.9.2（需要 direct provider 插件 API）
- DSH 已安装且 `dsh` 在 PATH 上
- Node ≥ 18（探测工具用了内建 `fetch`）

## 权限模式（放开沙箱）

DSH 默认是 **`workspace-write`**：只能改会话工作目录内的文件，越界操作要审批。会话建好后，
Paseo composer 里有一个 **Permissions** 下拉，可随时切换预设（等价于 `/permission <preset>`）：

- `read-only` —— 只读，任何改动都问
- `workspace-write` —— 可改工作区（默认）
- `danger-full-access` —— 不限目录、不审批（**完全放权**，谨慎）

想让**所有新会话默认就完全访问**，在你的 profile `~/.dsh/profiles/paseo/cordis.patch.yml`
里加这两段（与模型路由并存）：

```yaml
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: never
```

改回默认就把 `mode` 设回 `workspace-write`、`policy` 设回 `ask`。改完重启 daemon。

## 人设预设（Preset，可选）

DSH 的 agent preset 能把"人设 + 一套能力"打包成一个选项。插件**不强制**它——只有你的 profile
挂了 `@deepseek-ai/dsh-agent-preset-registry` 并声明了 preset，composer 里才会出现 **Preset** 下拉。

语义和 DSH 一致：**建会话时选，首个回合后锁定**（之后再改会被拒绝并弹回）。

启用示例（profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: standard
        selectedDefault: standard
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are a helpful assistant.
              # 注意：DSH 0.2.1 起只注册 provider/model 变量，{{cwd}} 会导致每回合失败
```

> 想让某个人设自带额外工具（例如挂一个领域工具插件），把它加进对应 preset 的 `plugins:` 即可——
> 插件对 preset 是"加法"：host 层的工具照常可用，preset 只负责人设与增量能力。
> 建议把 host `system-prompt` 的人设清空（`personaPrefix: ''`），改由各 preset 自带，避免重复。

## 版本策略

插件的 `major.minor` **跟随它所适配的 DSH 线**：`0.2.x` 的插件对应 DSH `0.2.x`，
patch 位是插件自己的发布计数。装的时候挑与 daemon 上 `dsh` 同一条线的版本即可。

## 更新日志

按 npm 发布顺序记录每个 patch 的**用户可见变化**。`0.2.x` 的 minor 跟随它所适配的 DSH 线，
patch 是本插件自己的发布计数；完整提交记录见
[commits](https://github.com/liuxing7954/paseo-dsh/commits/main)。

| 版本 | 日期 | 更新内容 |
| --- | --- | --- |
| [0.2.17](https://www.npmjs.com/package/paseo-dsh/v/0.2.17) | 2026-10-30 | **统计行重新贴合页脚**：按页脚实际绘制的位置测量并贴齐，原生皮肤下「最新回合」和「被新回合顶下去」两种状态都稳定在约 4.5px 间距；字号统一为页脚同款 13px。量不到、找不到页脚或间距超出合理范围时退回宿主间距，native 不补偿；第三方主题的位置仍由主题自己控制。 |
| [0.2.16](https://www.npmjs.com/package/paseo-dsh/v/0.2.16) | 2026-10-28 | **统计行回到默认位置**：移除 0.2.15 里的自动贴靠、DOM 测量与设置页，只保留内容显示（轮/步、首字、tok/s、上下文、缓存命中，点开展开明细）。位置交还给 Paseo 和主题，不再随展开/收起或换主题移动。`0.2.15` 已标记 deprecated。 |
| [0.2.15](https://www.npmjs.com/package/paseo-dsh/v/0.2.15) | 2026-10-28 | **统计行贴合回合页脚**：统计行与「复制 / 模型 / 时间 / 耗时」页脚的间距在默认主题和主题插件下保持一致；回合完成时给最后一行打 `final`，web 端实测页脚的实际位置再贴齐，native 用常量回退。<br>**可配置**：Settings → Plugins →「回答统计行」可调间距（0–24px，默认 6）与字号（10–16px，默认 13）；未保存设置时行为与之前完全一致。<br>**字号与数字**：默认对齐页脚的 13px，数字等宽不跳动。 |
| [0.2.14](https://www.npmjs.com/package/paseo-dsh/v/0.2.14) | 2026-10-28 | **统计行更直观**：收起行里的会话总 tokens 换成上下文占用百分比（如 `上下文 77%`），精确的 `已用 / 上限` 仍在展开详情里；其余计数与缓存命中口径不变。 |
| [0.2.13](https://www.npmjs.com/package/paseo-dsh/v/0.2.13) | 2026-10-28 | **统计行信息升级**：收起时常驻 `N 轮 N 步 · 首字 · tok/s · 总 tokens · 缓存命中`，口径与 DSH Web 一致（总量 = 未缓存输入 + 缓存读取 + 缓存写入 + 输出；命中 = 缓存读取 ÷ 输入侧总量）；恢复会话时会从历史日志重新累计轮/步/tokens。点开仍是上下文、Tokens、路由、工具详情。 |
| [0.2.12](https://www.npmjs.com/package/paseo-dsh/v/0.2.12) | 2026-10-28 | **回答真流式**：改订阅 DSH 的 `agent/assistant-stream` 瞬时帧（文本 + 推理），边生成边显示，不再等整段生成完再回放；首字出现的时刻就是模型吐出第一个字的时刻。<br>**回答统计行**：回答下方显示 `首字 xxx · xx tok/s`，点开可看上下文占用、输入/缓存/输出 tokens、路由与思考档位、工具次数与耗时；速度用 DSH 自己的 chunk 时间戳计算，整段突发的异常值直接丢弃。 |
| [0.2.11](https://www.npmjs.com/package/paseo-dsh/v/0.2.11) | 2026-10-28 | **上下文用量**：输入框旁显示 `已用 / 上限`。bridge 新增 `paseo/usage`，占用取 DSH 的 `contextPressure`（无采样时用 `tokenMeter.measure()`），容量取当前路由的 `resolveModelInfo()`；会话打开/恢复、回合结束、切模型、压缩后刷新，恢复旧会话不用新回合就有数。<br>**回答逐字出现**：按 DSH 的 `data.stream` 分片重放文本，不再整段蹦出；`turn/end` 等到重放结束，打断/新消息/进程退出立即落地。<br>**安装兼容 Paseo 0.9–0.11**：去掉 `@getpaseo/protocol` 的 type-only 导入（改成插件内 `JsonValue`），旧版安装器不再因解析不到类型而失败。 |
| [0.2.10](https://www.npmjs.com/package/paseo-dsh/v/0.2.10) | 2026-10-27 | **附件不再拖垮会话**：`uploaded_file`、review、GitHub/forge 附件降级成文本引用（文件名 / 类型 / 大小 / 路径，或 title / url / body），模型仍能读到；内容块转换移进 `try`，单条消息失败不再升级成 `session.runtime_failed`。<br>**目录概览**：补 `OVERVIEW.md` 与包描述，paseo.sh 的插件页能正确介绍能力与限制。 |
| [0.2.9](https://www.npmjs.com/package/paseo-dsh/v/0.2.9) | 2026-10-17 | **模型选择器不再为空**：DSH 0.2.1 的 catalog 异步物化，而 Paseo 的 catalog 探测不走 `initialize`；现在先预热默认路由，再短暂轮询（约 3s），等模型注册完再返回。 |
| [0.2.8](https://www.npmjs.com/package/paseo-dsh/v/0.2.8) | 2026-10-17 | **修复 DSH 0.2.1 每回合失败**：0.2.1-rc 只注册 `provider` / `model` 两个提示词变量，persona 里的 `{{cwd}}` 会让整个回合报 `unknown prompt variable`；移除它，cwd 改由运行时上下文提供。 |
| [0.2.7](https://www.npmjs.com/package/paseo-dsh/v/0.2.7) | 2026-10-14 | **导入列表可区分了**：每行显示会话标题和首条真实用户消息预览；并发读取日志前缀，40 个会话也能在 1 秒内列完。 |
| [0.2.6](https://www.npmjs.com/package/paseo-dsh/v/0.2.6) | 2026-10-14 | **中文说明**：npm 包页与 paseo.cafe 插件页同时展示中英文描述。 |
| [0.2.5](https://www.npmjs.com/package/paseo-dsh/v/0.2.5) | 2026-10-14 | **重开会话回放历史**：bridge 新增 `paseo/sessions` / `paseo/history`，按 DSH session id 读取日志并回放真实用户回合与工具项。<br>**导入 DSH 原生会话**：声明 `session.list`，从 `~/.dsh/sessions` 列举并导入。 |
| [0.2.4](https://www.npmjs.com/package/paseo-dsh/v/0.2.4) | 2026-10-09 | **插件重载 / daemon 重启后可恢复会话**：补上 `session.persistence` handle（`plugin:` 前缀），并用 `ctx.get()` 访问未注入的 `sessions` 服务，修掉重开时的两个连续报错。 |
| [0.2.3](https://www.npmjs.com/package/paseo-dsh/v/0.2.3) | 2026-10-09 | **Preset 下拉**：profile 挂了 `agent-preset-registry` 时，composer 里可选人设 + 能力包；建会话时选、首回合后锁定。<br>**profile 更耐升级**：`package.json` / `cordis.yml` / `pnpm-workspace.yaml` 已存在时不再覆盖。 |
| [0.2.2](https://www.npmjs.com/package/paseo-dsh/v/0.2.2) | 2026-10-09 | **Permissions 下拉**：在 composer 里直接切 DSH 的沙箱预设（`read-only` / `workspace-write` / `danger-full-access`），等价于 `/permission <preset>`；bridge 新增 `paseo/permission`。 |
| [0.2.1](https://www.npmjs.com/package/paseo-dsh/v/0.2.1) | 2026-10-09 | **自带 CLI**：`npx paseo-dsh doctor` 只读检查 CLI / profile / bridge / 路由 / key；`npx paseo-dsh probe` 探测端点真实能力。装完不用 clone 就能自检和探模型。<br>安装走查补上完整的模型路由示例。 |
| [0.2.0](https://www.npmjs.com/package/paseo-dsh/v/0.2.0) | 2026-10-09 | **首个公开版本**：DSH 作为 Paseo 原生 provider（不是 ACP）；`ask_user_question` 原生提问卡片、Build / Plan 模式、按模型真实声明的思考档位、插话、图片端到端、`/` 命令与技能菜单；插件首载自举 DSH profile，`paseo plugin add npm:paseo-dsh` 一行安装。 |

> `0.1.x` 只在本地开发，未发布 npm；`0.0.0-stage` 是首次发布前的占位版本。

## 相关文档

- [docs/ADOPTION.md](docs/ADOPTION.md) — 改造指南：改动点、配置方法、踩坑清单
- [docs/FIELD-NOTES.md](docs/FIELD-NOTES.md) — 25 个真实缺陷的症状 → 根因 → 修法
- [AGENTS.md](AGENTS.md) — 给 AI Agent 的说明（Codex 等会自动读取）。不管你是被叫来
  装它、还是被叫来改它，先看这个

## 联系

用的时候卡住了、发现文档写错了、或者你用它接上了别的运行时——都欢迎直接发邮件：

**jixy · [467677527@qq.com](mailto:467677527@qq.com)**

提 issue 也行，但邮件我回得更快。

## 许可

MIT，见 [LICENSE](LICENSE)。
