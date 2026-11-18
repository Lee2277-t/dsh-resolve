"""dsh-resolve 应用内桥 —— 放在 Resolve 的脚本目录里，从 Workspace > 脚本 菜单运行。

免费版没有外部脚本端口，但仍可在应用内跑脚本。这个脚本读一个命令队列，
批量执行后把结果写回磁盘，dsh-resolve 插件再取结果。

队列目录: %LOCALAPPDATA%\\dsh-resolve
  jobs/<id>.json     待执行（插件写入）
  results/<id>.json  执行结果（本脚本写入）
  state.json         心跳与能力证明
"""
import glob
import json
import os
import time
import traceback

try:
    import sys

    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

LOCAL = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
ROOT = os.path.join(LOCAL, "dsh-resolve")
JOBS = os.path.join(ROOT, "jobs")
RESULTS = os.path.join(ROOT, "results")


def ensure_dirs():
    for d in (ROOT, JOBS, RESULTS):
        if not os.path.isdir(d):
            os.makedirs(d)


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, default=str, indent=2)
    os.replace(tmp, path)


def get_resolve():
    ctx = globals().get("resolve")
    if ctx is not None:
        return ctx
    try:
        return bmd.scriptapp("Resolve")  # noqa: F821 - provided by Resolve
    except Exception:
        return None


# ---------------------------------------------------------------- operations


def op_status(resolve, args):
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    timeline = project.GetCurrentTimeline() if project else None
    return {
        "version": resolve.GetVersionString(),
        "product": resolve.GetProductName(),
        "page": resolve.GetCurrentPage(),
        "project": project.GetName() if project else None,
        "timeline": timeline.GetName() if timeline else None,
        "timelineCount": pm.GetTimelineCount(),
    }


def op_import_fcpxml(resolve, args):
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    if project is None:
        project = pm.CreateProject(args.get("projectName") or "DSH Edit") or pm.GetCurrentProject()
    if project is None:
        raise RuntimeError("没有当前工程，且创建失败")
    path = args["path"]
    if not os.path.exists(path):
        raise RuntimeError("时间线文件不存在: " + path)
    options = {"timelineName": args.get("timelineName") or os.path.splitext(os.path.basename(path))[0]}
    timeline = project.GetMediaPool().ImportTimelineFromFile(path, options)
    if timeline is None:
        raise RuntimeError("ImportTimelineFromFile 返回 None（文件格式或素材路径有问题）")
    project.SetCurrentTimeline(timeline)
    return {
        "project": project.GetName(),
        "timeline": timeline.GetName(),
        "startFrame": timeline.GetStartFrame(),
        "endFrame": timeline.GetEndFrame(),
    }


def op_timeline(resolve, _args):
    project = resolve.GetProjectManager().GetCurrentProject()
    timeline = project.GetCurrentTimeline() if project else None
    if timeline is None:
        raise RuntimeError("没有当前时间线")
    tracks = []
    for kind in ("video", "audio"):
        for index in range(1, (timeline.GetTrackCount(kind) or 0) + 1):
            items = timeline.GetItemListInTrack(kind, index) or []
            tracks.append(
                {
                    "type": kind,
                    "index": index,
                    "items": [
                        {"name": i.GetName(), "start": i.GetStart(True), "duration": i.GetDuration(True)}
                        for i in items
                    ],
                }
            )
    return {"name": timeline.GetName(), "startFrame": timeline.GetStartFrame(), "endFrame": timeline.GetEndFrame(), "tracks": tracks}


def op_export_frame(resolve, args):
    project = resolve.GetProjectManager().GetCurrentProject()
    timeline = project.GetCurrentTimeline() if project else None
    if timeline is None:
        raise RuntimeError("没有当前时间线")
    out = args["path"]
    if not os.path.isdir(os.path.dirname(out)):
        os.makedirs(os.path.dirname(out))
    result = timeline.ExportFrame(int(args.get("offset", 0)), {"outputType": "file", "filePath": out})
    if not result or not result.get("success"):
        raise RuntimeError("ExportFrame 失败: %s" % (result or {}).get("error"))
    return {"path": out, "width": result.get("width"), "height": result.get("height")}


def op_render(resolve, args):
    project = resolve.GetProjectManager().GetCurrentProject()
    settings = {
        "TargetDir": args["targetDir"],
        "SelectAllFrames": True,
        "ExportVideo": True,
        "ExportAudio": bool(args.get("exportAudio", True)),
    }
    if args.get("customName"):
        settings["CustomName"] = args["customName"]
    if not project.SetRenderSettings(settings):
        raise RuntimeError("SetRenderSettings 失败")
    job = project.AddRenderJob()
    if not job or not project.StartRendering([job]):
        raise RuntimeError("启动渲染失败")
    return {"jobId": job, "targetDir": args["targetDir"]}


def op_py(resolve, args):
    project = resolve.GetProjectManager().GetCurrentProject()
    scope = {
        "resolve": resolve,
        "project": project,
        "timeline": project.GetCurrentTimeline() if project else None,
        "mediapool": project.GetMediaPool() if project else None,
        "os": os,
    }
    code = args["code"]
    try:
        value = eval(code, scope)  # noqa: S307
    except SyntaxError:
        exec(code, scope)  # noqa: S102
        value = scope.get("result")
    if not isinstance(value, (dict, list, str, int, float, bool, type(None))):
        value = repr(value)
    return {"value": value}


OPS = {
    "status": op_status,
    "import_fcpxml": op_import_fcpxml,
    "timeline": op_timeline,
    "export_frame": op_export_frame,
    "render": op_render,
    "py": op_py,
}


# ---------------------------------------------------------------- queue drain


def drain_once(resolve):
    """Execute every pending job, newest last. Returns the number processed."""
    processed = 0
    for job_path in sorted(glob.glob(os.path.join(JOBS, "*.json"))):
        job_id = os.path.splitext(os.path.basename(job_path))[0]
        result_path = os.path.join(RESULTS, job_id + ".json")
        try:
            with open(job_path, "r", encoding="utf-8") as fh:
                job = json.load(fh)
        except Exception as exc:
            write_json(result_path, {"ok": False, "error": "读取任务失败: %s" % exc})
            _move_done(job_path)
            continue

        handler = OPS.get(job.get("op"))
        try:
            if handler is None:
                raise RuntimeError("未知操作: %s" % job.get("op"))
            if resolve is None:
                raise RuntimeError("脚本里拿不到 resolve 对象")
            write_json(result_path, {"ok": True, "result": handler(resolve, job.get("args") or {})})
        except Exception as exc:
            write_json(
                result_path,
                {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc), "traceback": traceback.format_exc(limit=4)},
            )
        _move_done(job_path)
        processed += 1
    return processed


def _move_done(job_path):
    done = os.path.join(ROOT, "done")
    if not os.path.isdir(done):
        os.makedirs(done)
    try:
        os.replace(job_path, os.path.join(done, os.path.basename(job_path)))
    except Exception:
        try:
            os.remove(job_path)
        except Exception:
            pass


def write_state(resolve, mode, extra=None):
    info = {"mode": mode, "time": time.strftime("%Y-%m-%d %H:%M:%S"), "queue": ROOT}
    try:
        if resolve is not None:
            info.update(op_status(resolve, {}))
    except Exception as exc:
        info["statusError"] = "%s: %s" % (type(exc).__name__, exc)
    if extra:
        info.update(extra)
    write_json(os.path.join(ROOT, "state.json"), info)
    return info


# ---------------------------------------------------------------- panel mode


def try_panel(resolve):
    """Best effort: keep a small panel open and poll the queue without freezing Resolve.

    Returns True if the panel ran, False if the Fusion UI layer is unavailable here
    (the caller then falls back to a single drain).
    """
    try:
        ui = fu.UIManager  # noqa: F821
        dispatcher = bmd.UIDispatcher(ui)  # noqa: F821
    except Exception:
        return False

    window = dispatcher.AddWindow(
        {"ID": "DSHBridge", "WindowTitle": "dsh-resolve 桥", "Geometry": [200, 200, 460, 150]},
        [
            ui.VGroup(
                [
                    ui.Label({"ID": "Info", "Text": "等待任务…", "WordWrap": True}),
                    ui.HGroup([ui.Button({"ID": "Close", "Text": "关闭"})]),
                ]
            )
        ],
    )
    timer = window.AddTimer({"ID": "Poll", "Interval": 900})
    label = window.Find("Info")

    def render_info(count):
        try:
            project = resolve.GetProjectManager().GetCurrentProject() if resolve else None
            where = project.GetName() if project else "(无工程)"
            label.SetText("工程: %s\n本次已处理: %d 个任务\n队列: %s" % (where, count, ROOT))
        except Exception:
            pass

    def on_timer(_event):
        try:
            on_timer.count += drain_once(resolve)
        except Exception:
            pass
        render_info(on_timer.count)

    on_timer.count = 0

    def on_close(_event):
        dispatcher.ExitLoop()

    window.On.Poll = on_timer
    window.On.Close = on_close
    window.On.DSHBridge.Close = on_close

    window.Show()
    render_info(0)
    dispatcher.RunLoop()
    window.Hide()
    return True


def main():
    ensure_dirs()
    resolve = get_resolve()
    write_state(resolve, "started")

    if resolve is None:
        write_state(resolve, "no-resolve")
        return

    drained = 0
    try:
        drained += drain_once(resolve)
    except Exception:
        pass

    if try_panel(resolve):
        write_state(resolve, "panel-closed", {"processed": drained + getattr(main, "count", 0)})
    else:
        write_state(resolve, "drained", {"processed": drained})


if __name__ == "__main__":
    main()
