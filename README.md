# dsh-resolve — 达芬奇直接成片

让 agent 用**一份声明式 spec** 直接把片子做出来，而不是在 DaVinci Resolve 界面里一点点点。

[English](#english) · [DSH 插件](https://github.com/deepseek-ai/deepseek-harness) · AGPL-3.0

## 为什么需要它

Resolve 有官方脚本 API，但它只在 **Studio** 版可用：

- 免费版偏好设置里没有 `External scripting using`，1144 端口不监听，`scriptapp()` 返回 `None`。
- GitHub 上那些 Resolve MCP（`davinci-resolve-mcp` 等）全部依赖同一个端口，所以免费版一律跑不起来。

结果就是：过去想让 agent 做片子，只能靠 computer-use 点界面，又慢又脆。

本插件把这件事拆成两条后端，**同一份 spec** 通用：

| 后端 | 何时启用 | 做什么 |
| --- | --- | --- |
| `file` | 免费版（默认） | 生成 Resolve 可直接导入的 `.fcpxml` + 字幕 PNG + 清单 |
| `api` | Resolve Studio + 外部脚本=本地 | 同一个 spec 直接在建好的工程里建时间线，还能导帧、渲染 |

`resolve_doctor` 自动判断当前是哪一种，装 Studio 之后**不用改工具调用**。

免费版还有第三条路：`resolve_live` 把命令排进队列，由跑在 Resolve 内部的脚本面板执行，绕开脚本端口。

## 工具

| 工具 | 后端 | 作用 |
| --- | --- | --- |
| `resolve_doctor` | 全部 | 版本/版本类型/端口/后端，以及要修什么 |
| `resolve_help` | 全部 | spec 字段手册（先读一次） |
| `resolve_build` | 全部 | **核心**：spec → 成片包（file）或直接建时间线（api） |
| `resolve_preview` | 全部 | **离线出联系表**：ffmpeg 抽帧 + 叠加标题，不用 Resolve 也能看到画面 |
| `resolve_import` | api | 把已有 `.fcpxml` 导入当前工程 |
| `resolve_state` | api | 读当前工程/时间线/每条轨上的片段 |
| `resolve_frame` | api | 导一帧 PNG，让 agent 真的看见结果 |
| `resolve_render` | api | 出片到指定目录 |
| `resolve_py` | api | 逃生口：直接跑 Resolve Python API |
| `resolve_live` | 免费版 | 队列一条操作给 Resolve 内的桥脚本并等结果 |
| `resolve_live_status` | 免费版 | 桥脚本装没装、活没活、最后看到什么 |

## 安装

作为 DSH bundle 安装（路径换成你自己的）：

```bash
dsh plugin --profile web add /path/to/dsh-resolve
# 或者：dsh plugin add /path/to/dsh-resolve
```

装的是哪个 profile，就换哪个 `--profile`。Desktop 应用管自己的 profile，
那边请用应用内的 **Settings → Plugins** 安装，命令行装到 `web` profile 的不会出现在 Desktop 里。

也可以在 DSH 里让 agent 调 `plugin_manager` + `install_bundle`，`target` 指向本目录。

也可以完全不用 DSH：`src/build.mjs` 不依赖 DSH 的运行时，是普通 Node 模块，
`node -e "import('./src/build.mjs').then(m => m.buildEdit(spec, { outputDir }))"` 就能生成 `.fcpxml`。

### 依赖

| 依赖 | 用途 | 必须 |
| --- | --- | --- |
| Node.js 20+ | 插件本体 | 是 |
| Python 3.10+ 且 `pip install pillow` | 探测素材、渲染字幕 PNG | 是 |
| OpenCV（`pip install opencv-python`） | 探测视频时长/分辨率/fps | 否，没有就按 spec 里写的时长走 |
| ffmpeg | `resolve_preview` 抽帧 | 否，没有就只出图片素材的预览 |
| DaVinci Resolve Studio | `api` 后端 | 否 |

Python 和 ffmpeg 的查找顺序：`config.pythonPath` / `DSH_RESOLVE_PYTHON` / `PYTHON` 环境变量 →
`%LOCALAPPDATA%\Programs\Python\Python3xx` → `C:\Python3xx` → PATH。
ffmpeg：`FFMPEG_PATH` / `FFMPEG_EXE` → `~/.dsh/bin/ffmpeg.exe` → 常见路径 → PATH。

### 配置

`cordis.patch.yml` 里给该行可选的 `config`：

```yaml
- id: dsh-resolve
  name: dsh-resolve
  config:
    resolveExe: 'D:\Apps\DaVinci Resolve\Resolve.exe'  # 非默认安装目录时才需要
    pythonPath: 'C:\Python312\python.exe'             # 装了多个 Python 时才需要
    installBridgeScript: true                          # 关闭则不往 Resolve 脚本目录放桥脚本
```

Resolve 的安装位置默认按 `RESOLVE_EXE` 环境变量 → 常见安装路径 → 正在运行的 `Resolve.exe` → 卸载注册表 依次查找。

## spec 速览

```json
{
  "name": "成片名",
  "width": 1920, "height": 1080, "fps": 25,
  "clips": [{ "file": "D:/素材/a.mp4", "in": 0, "duration": 75, "name": "开场" }],
  "titles": [{ "text": "标题", "sub": "副标题", "at": 15, "duration": 60, "style": "center" }],
  "transitions": [{ "after": 0, "type": "Cross Dissolve", "duration": 12 }]
}
```

时间单位默认是**帧**，也接受 `"3s"`。完整字段见 `resolve_help`。

## 文件后端怎么用

1. `resolve_build` 产出 `<输出目录>/<名字>.fcpxml` 和 `assets/`
2. Resolve 里：**文件 › 导入 › 时间线…** 选那个 `.fcpxml`
3. 时间线出现在媒体池，双击即可继续改

不想导入也能先看：`resolve_preview` 用 ffmpeg 抽帧、把标题叠上去，出一张带帧号/时间码的联系表。

## 自测

```bash
npm test
```

不需要 Resolve，也不需要显示器：临时目录里画三块色板、渲染两个字幕、生成一条带交叉溶解的时间线，
再按 Resolve 的读法检查 `.fcpxml`（悬空引用、重复 id、空 spine、被百分号编码的 `src`、带数字的标题文件名）。
跑完自动删掉临时文件。

## 已验证 / 未验证

- 已验证：素材探测、字幕渲染（含中文）、时间线排版、FCPXML 生成与自检、11 个工具注册与调用、免费版/Studio 判定。
- 已验证：`resolve_preview` 的画面复现——图片素材与真实 mp4 两条分支都测过，入点偏移、标题时间窗、片段切换帧都对得上。
- 已验证：**生成的 `.fcpxml` 在 DaVinci Resolve 21.2（免费版）里导入成功**——素材在线、V1 两段带交叉溶解、V2/V3 标题图层正常渲染，与离线预览一致。
- 未验证：Resolve Studio 的 `api` 后端只在开发机上用 Studio 的脚本端口验证过接口形状，没有跑过完整的 `resolve_render` 长片渲染。
- 未验证：macOS / Linux 上的 Resolve。`file` 后端理论上跨平台，`detect()` 的版本探测目前只实现 Windows。

## 导入时踩过的坑（改代码前先看这里）

两个坑都只有真机导入才暴露，单元测试测不出来：

1. **`src` 不能做百分号编码。** 写成 `file:///C:/Users/%E6%9D%8E%E5%9B%9B/...` 时 Resolve 不解码，
   所有素材显示“离线媒体”。必须写 UTF-8 原文：`file:///C:/Users/李四/...`。
   中文用户名、带空格的目录都会踩到，所以 `src/util.mjs` 的 `fileUrl()` 故意不做 `encodeURI`。
2. **标题 PNG 的文件名不能带数字。** `title-01.png` + `title-02.png` 会被 Resolve 当成图片序列
   （媒体池里显示成 `title-[01-45].png`），然后去找不存在的第 3…45 帧，结果整条离线。
   现在统一用 `title-a.png` / `title-b.png`（`letterSuffix()`，52 个之后是 `aa`、`ab`）。

## 隐私

插件本身不含任何账号、令牌或个人路径，也不发任何网络请求。运行时只会写这几处：

- `outputDir`（默认 `<会话目录>/resolve-edits`）：`.fcpxml`、`assets/`、`manifest.json`
- `%LOCALAPPDATA%\dsh-resolve\`：`resolve_live` 的任务队列与心跳
- `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\dsh_resolve_bridge.py`：
  免费版的内置桥脚本，`installBridgeScript: false` 可关闭

## v1 边界

独立音乐轨、标题入场动画、调色节点、变速、关键帧都不做——这些在 Resolve 里手动改更快，或需要 Studio 的直连后端。

---

## English

**dsh-resolve** turns one declarative edit spec into a finished DaVinci Resolve timeline. No ribbon clicking, no computer-use.

Two backends share the same spec:

- **`file`** (default, works on the free edition): writes an importable `.fcpxml` plus rendered title PNGs and a manifest. Import with *File › Import › Timeline…*.
- **`api`** (Resolve Studio, *External scripting = Local*): builds the timeline inside the running project, exports frames and starts renders.

Eleven tools: `resolve_doctor` (which backend works here), `resolve_help` (spec reference), `resolve_build`, `resolve_preview` (offline contact sheet via ffmpeg), `resolve_import`, `resolve_state`, `resolve_frame`, `resolve_render`, `resolve_py`, and `resolve_live` / `resolve_live_status` for driving the free edition through a script panel that runs inside Resolve.

**Requirements:** Node.js 20+, Python 3.10+ with Pillow, and — for the `api` backend — DaVinci Resolve Studio on Windows. ffmpeg is optional (only for `resolve_preview`).

**Install:**

```bash
dsh plugin add /path/to/dsh-resolve
```

**Test:** `npm test` — builds a timeline in a temp folder and checks the FCPXML the way Resolve reads it. No Resolve required.

**Privacy:** no telemetry, no network calls, no credentials. It writes only to the output directory, `%LOCALAPPDATA%\dsh-resolve\` (the free-edition queue) and, for the in-app bridge, Resolve's own Scripts folder (disable with `installBridgeScript: false`).

AGPL-3.0-only licensed.
