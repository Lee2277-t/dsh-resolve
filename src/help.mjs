export const HELP = `# dsh-resolve — 达芬奇直接成片

一个声明式剪辑 spec 交给 resolve_build，得到一条可以立刻导入 DaVinci Resolve 的完整时间线。
不需要在 Resolve 里点来点去。

## 两种后端（自动选择）

- file（默认，免费版可用）：生成 .fcpxml + 素材，在 Resolve 里「文件 › 导入 › 时间线」一次导入。
- api（Resolve Studio + 外部脚本=本地）：同一个 spec，resolve_build 直接在你打开的 Resolve 里建好时间线。

resolve_doctor 会告诉你当前是哪一种。

## spec 结构

{
  "name": "成片名",
  "width": 1920, "height": 1080, "fps": 25,

  "clips": [
    { "file": "D:/素材/a.mp4", "in": 0, "duration": 75, "name": "开场" },
    { "file": "D:/素材/b.mp4", "duration": "3s" }
  ],

  "titles": [
    { "text": "一句话标题", "sub": "副标题", "at": 15, "duration": 60, "style": "center" },
    { "text": "嘉宾：张三", "style": "lower", "at": "2s", "duration": "4s" }
  ],

  "transitions": [
    { "after": 0, "type": "Cross Dissolve", "duration": 12 }
  ]
}

## 字段

顶层
- name        成片/时间线名（也是输出文件名）
- width/height 时间线分辨率，默认 1920x1080
- fps         默认 25；支持 23.976 / 24 / 25 / 29.97 / 30 / 50 / 59.94 / 60

clips[]（顺序拼接在主视频轨）
- file        绝对路径，或相对 resolve_build 的 outputDir
- in          源素材起始帧，默认 0
- duration    取多少帧；省略=整条素材。也接受 "3s"
- name        显示名，默认取文件名

titles[]（渲染成透明 PNG 叠在视频上）
- text        主文案（必填）
- sub         副标题，可省略
- at          出现在第几帧，默认 0；接受 "2s"
- duration    持续帧数，默认 75（约 3 秒）
- style       "center"（居中大字）或 "lower"（左下角字幕条），默认 center
- size        字号像素，默认按画面高度自动算
- color       [r,g,b] 文字色，默认白
- accent      [r,g,b] 字幕条强调色，默认琥珀色

transitions[]
- after       在第几个 clip 之后（0 起）
- type        "Cross Dissolve"（默认）
- duration    帧数，默认 fps/2，自动取偶数并保证不超相邻片段一半

## v1 边界（别浪费时间在这些上）

- 只有画面片段自带的声音会保留，暂不支持独立音乐轨 -> 需要的话用 resolve_py（Studio）。
- 标题是静态位图，没有入场动画；要动画用 Studio 的 Fusion 路径。
- 不做调色、不裁切、不变速；这些在 Resolve 里手动改更快。

## 典型流程

1. resolve_doctor       确认后端
2. resolve_build        传 spec，拿到 .fcpxml
3. resolve_preview      离线出一张联系表，先看画面对不对
4. 改 spec → 回到 2（不用碰 Resolve）
5. Resolve 里导入一次
6. （Studio）resolve_frame / resolve_render 做收尾

## 关于 resolve_preview

不经过 Resolve，直接用 ffmpeg 抽源帧 + 把标题叠上去，复现"第 N 帧长什么样"。
所以即使没有 Studio 的导帧 API，也能做到「生成 → 看 → 改」的闭环。

- 默认自动挑 4 帧（避开首尾，免得被黑场误导）
- 返回每帧 PNG + 一张带帧号/时间码的联系表
- 标题压边、字号过大、两段标题时间重叠这类问题，在导入前就能看见
`

export const SPEC_TOPIC = {
  spec: HELP,
  limits: `v1 不支持：独立音乐轨、标题动画、调色节点、变速、关键帧。\n这些需要 Resolve Studio 的直连后端（resolve_py / resolve_frame / resolve_render）。`,
}
