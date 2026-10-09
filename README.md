# DeepSeek Harness × Paseo（原生接入）

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

## 版本策略

插件的 `major.minor` **跟随它所适配的 DSH 线**：`0.2.x` 的插件对应 DSH `0.2.x`，
patch 位是插件自己的发布计数。装的时候挑与 daemon 上 `dsh` 同一条线的版本即可。

## 相关文档

- [docs/ADOPTION.md](docs/ADOPTION.md) — 改造指南：改动点、配置方法、踩坑清单
- [docs/FIELD-NOTES.md](docs/FIELD-NOTES.md) — 18 个真实缺陷的症状 → 根因 → 修法
- [AGENTS.md](AGENTS.md) — 给 AI Agent 的说明（Codex 等会自动读取）。不管你是被叫来
  装它、还是被叫来改它，先看这个

## 联系

用的时候卡住了、发现文档写错了、或者你用它接上了别的运行时——都欢迎直接发邮件：

**jixy · [467677527@qq.com](mailto:467677527@qq.com)**

提 issue 也行，但邮件我回得更快。

## 许可

MIT，见 [LICENSE](LICENSE)。
