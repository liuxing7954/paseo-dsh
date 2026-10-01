# DeepSeek Harness × Paseo（原生接入）

把 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) 作为 Paseo 的**一等公民 provider**
接进来。不 fork Paseo、不 fork DSH，全部走公开扩展点：Paseo 侧是 direct provider 插件，
DSH 侧是一个 profile bundle。

> 这不是 ACP 接入。ACP 缺三样东西，而 Paseo 的原生 provider 协议恰好都有。

| 能力 | ACP 接入 | 本项目 |
| --- | --- | --- |
| `ask_user_question` 提问卡片 | ❌ 模型看不到该工具，也没有应答方 | ✅ Paseo 原生卡片，步进式选项，一次提交 |
| 计划模式 | ❌ ACP 不承载 modes/plans | ✅ 编辑器里的 Build / Plan 开关，计划先展示再审批 |
| 思考强度 | ⚠️ 取决于模型 | ✅ 按每个模型**真实声明**的档位渲染 |
| 插话（steer） | — | ✅ 注入当前回合，而不是排到下一个 |
| 终止后续聊 | — | ✅ 只取消当前回合，会话保留 |

## 快速开始

```bash
git clone <this repo> && cd paseo-dsh
./install.sh --check     # 先看前提条件，不做改动
./install.sh             # 安装 profile + 插件，并启用
```

安装脚本不会覆盖你已有的模型配置，动到的每个文件都会先备份。

装完之后**只有一件事需要你填**：profile 里的模型路由。不确定你的端点支持什么，
先探测：

```bash
node tools/probe-provider.mjs \
  --base-url https://your-gateway/v1 \
  --api-key-env YOUR_KEY_ENV_VAR \
  --model your-model-id
```

它会直接打你的端点，告诉你该不该开 `supportsDeveloperRole: false`、哪些推理档位
真的可用，并吐出一段可直接粘贴的配置。

**完整走查与踩坑清单见 [docs/ADOPTION.md](docs/ADOPTION.md)。**

## 组成

```
paseo-dsh/
├── dsh-bridge/          # DSH 侧：stdio 桥接 bundle
│   ├── lib/index.js     #   插件入口：命令行、stdin 生命周期、提问桥接
│   ├── lib/transport.js #   自带 JSON-RPC 行传输（支持 server→client 请求）
│   ├── lib/server.js    #   会话/计划/思考档位/catalog 的实现
│   └── cordis.patch.yml #   bundle 补丁：往 dsh-base 上挂桥接与提问工具
├── paseo-plugin/        # Paseo 侧：provider 插件（direct provider 实现）
│   ├── index.server.ts  #   registerProvider()
│   └── server/
│       ├── provider.ts  #   连接、catalog、会话生命周期、权限卡片
│       ├── session.ts   #   单会话：提问→卡片、计划、思考档位、用量
│       ├── dsh-process.ts # 一个会话一个 dsh 子进程
│       └── timeline.ts  #   DSH 会话事件 → Paseo 时间线
├── tools/               # 能力探测：帮你填自己的模型配置
├── templates/           # profile 配置模板（含两处必踩的坑的注释）
├── harness/             # 独立探针，不依赖 Paseo 即可验证桥接
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

## 本地验证（不需要 Paseo）

```bash
node harness/catalog.mjs      # 列出 provider / 模型 / 每个模型真实支持的思考档位
node harness/probe.mjs        # 端到端跑一轮提问往返
node harness/route-test.mjs   # 逐个路由测试可用性
```

验证方法本身也值得一读——界面会乐观显示、会缓存、会骗你，所以断言要打在协议层。
[ADOPTION.md 第 5 节](docs/ADOPTION.md) 讲了具体做法，包括一些反直觉的坑
（比如 `waitFor` 会匹配到陈旧事件，导致误判）。

## 环境要求

- Paseo ≥ 0.9.2（需要 direct provider 插件 API）
- DSH 已安装且 `dsh` 在 PATH 上
- Node ≥ 18（探测工具用了内建 `fetch`）

## 相关文档

- [docs/ADOPTION.md](docs/ADOPTION.md) — 改造指南：改动点、配置方法、踩坑清单
- [docs/FIELD-NOTES.md](docs/FIELD-NOTES.md) — 18 个真实缺陷的症状 → 根因 → 修法

## 联系

用的时候卡住了、发现文档写错了、或者你用它接上了别的运行时——都欢迎直接发邮件：

**jixy · [467677527@qq.com](mailto:467677527@qq.com)**

提 issue 也行，但邮件我回得更快。

## 许可

MIT，见 [LICENSE](LICENSE)。
