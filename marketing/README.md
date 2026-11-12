# 宣传图生成器

一套可复现的「代码转图片」风格卡片：暖纸色底 + 黑墨 + 朱红 / 芥末黄，
硬边框、印刷网点和衬线大标题。不是蓝紫渐变那种 AI 产品风。
输出两种尺寸：

| 用途 | 尺寸 | 输出 |
| --- | --- | --- |
| 小红书 / 封面 / 轮播 | 1080 × 1440（3:4） | `docs/assets/social/01-cover.png` … `08-doctor.png` |
| GitHub README 头图 | 1600 × 900 | `docs/assets/hero.png` |

> 这些是按 Paseo 当前界面语言做的**设计渲染图**，不是从运行中的窗口截的原始截图。
> 原因是本机的 Paseo 装了自定义皮肤，且会话里有私人内容，直接截不适合公开发布。
> UI 里的模型名、路由名、会话标题都是示意值；要换成真实内容，改 `poster.html` 即可。

## 重新生成

只依赖本机 Chrome，没有 npm 依赖：

```bash
node marketing/render.mjs                  # 全部 9 张
node marketing/render.mjs --only cover     # 只重画某一张，可重复 --only
node marketing/render.mjs --list           # 看 scene id 和输出
CHROME_PATH=/path/to/chrome node marketing/render.mjs   # 非 macOS / 自定义 Chrome
```

渲染参数：`--headless=new`、`--force-device-scale-factor=1`、`--virtual-time-budget=1500`。
脚本会校验输出 PNG 的宽高，尺寸不对直接报错。

## 文件

```
marketing/
├── poster.html    # 8 个 3:4 scene + 1 个 1600x900 hero scene
├── poster.css     # 设计系统：背景、窗口、提问卡、菜单、终端
├── render.mjs     # 逐个 scene 调 headless Chrome 截图
└── README.md
```

`poster.html` 用 `?scene=cover|questions|plan|streaming|attachments|thinking|expert|doctor|hero`
切换画面，`render.mjs` 会自动拼这个 query。改文案直接搜 `poster.html` 里的中文；
改配色/间距看 `poster.css` 顶部的 `:root` 变量。

8 张卡依次是：封面、提问卡片、Plan、流式输出、附件 / 图片、思考档位、
standard 专家模式、doctor 自检。

## 换成真实截图

如果以后想要一组“真截图”，建议单独开一个 scene：把 `poster.html` 里某个 `.window`
的内部换成一个 `<img src="screens/xxx.png">`，外面保留现在的纸张底、标题和页脚。
这样真实截图也能统一成同一套封面风格，不会破坏版式。

## 发布

图片本身不带任何 API key、真实路径或私人会话内容。上传到任意图床/CDN 后，
README 里建议用仓库内相对路径（`docs/assets/...`），避免外链失效。
