"""Persistent Resolve scripting bridge (Studio only).

Spawned by the dsh-resolve plugin with Resolve's own interpreter:
    ResolvePython.exe bridge.py
Speaks JSON lines on stdin/stdout:  {"id":1,"op":"status","args":{}} -> {"id":1,"ok":true,"result":{...}}

The plugin imports a generated .fcpxml through this bridge, so the same edit spec
works whether you build to a file or drive Resolve directly.
"""
import json
import os
import sys
import traceback

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
except Exception:
    pass

API = os.environ.get("RESOLVE_SCRIPT_API") or r"C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting"
LIB = os.environ.get("RESOLVE_SCRIPT_LIB") or r"C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll"
if API and os.path.isdir(os.path.join(API, "Modules")) and os.path.join(API, "Modules") not in sys.path:
    sys.path.append(os.path.join(API, "Modules"))

import DaVinciResolveScript as dvr  # noqa: E402


def get_resolve():
    resolve = dvr.scriptapp("Resolve")
    if resolve is None:
        raise RuntimeError(
            "scriptapp('Resolve') returned None. Is DaVinci Resolve Studio running with "
            "Preferences > System > General > External scripting using: Local?"
        )
    return resolve


def op_status(_args):
    resolve = get_resolve()
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    timeline = project.GetCurrentTimeline() if project else None
    info = {
        "version": resolve.GetVersionString(),
        "product": resolve.GetProductName(),
        "page": resolve.GetCurrentPage(),
        "project": project.GetName() if project else None,
        "timeline": timeline.GetName() if timeline else None,
        "timelineCount": pm.GetTimelineCount(),
    }
    return info


def op_import_fcpxml(args):
    resolve = get_resolve()
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    if project is None:
        project_name = args.get("projectName") or "DSH Edit"
        project = pm.CreateProject(project_name) or pm.GetCurrentProject()
        if project is None:
            raise RuntimeError(f"could not create project {project_name!r}")
    media_pool = project.GetMediaPool()
    path = args["path"]
    if not os.path.exists(path):
        raise RuntimeError(f"timeline file not found: {path}")
    options = {"timelineName": args.get("timelineName") or os.path.splitext(os.path.basename(path))[0]}
    if args.get("importSourceClips", True):
        options["importSourceClips"] = True
    timeline = media_pool.ImportTimelineFromFile(path, options)
    if timeline is None:
        raise RuntimeError(
            "ImportTimelineFromFile returned None. Check that the .fcpxml media paths still resolve "
            "and that Resolve can read the file."
        )
    project.SetCurrentTimeline(timeline)
    return {
        "project": project.GetName(),
        "timeline": timeline.GetName(),
        "startFrame": timeline.GetStartFrame(),
        "endFrame": timeline.GetEndFrame(),
        "trackCount": timeline.GetTrackCount("video"),
    }


def op_timeline(_args):
    resolve = get_resolve()
    project = resolve.GetProjectManager().GetCurrentProject()
    timeline = project.GetCurrentTimeline() if project else None
    if timeline is None:
        raise RuntimeError("no current timeline")
    tracks = []
    for kind in ("video", "audio"):
        count = timeline.GetTrackCount(kind)
        for index in range(1, count + 1):
            items = timeline.GetItemListInTrack(kind, index) or []
            tracks.append(
                {
                    "type": kind,
                    "index": index,
                    "items": [
                        {
                            "name": item.GetName(),
                            "start": item.GetStart(True),
                            "duration": item.GetDuration(True),
                        }
                        for item in items
                    ],
                }
            )
    return {
        "name": timeline.GetName(),
        "startFrame": timeline.GetStartFrame(),
        "endFrame": timeline.GetEndFrame(),
        "tracks": tracks,
    }


def op_export_frame(args):
    resolve = get_resolve()
    project = resolve.GetProjectManager().GetCurrentProject()
    timeline = project.GetCurrentTimeline() if project else None
    if timeline is None:
        raise RuntimeError("no current timeline")
    offset = int(args.get("offset", 0))
    out = args["path"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    result = timeline.ExportFrame(offset, {"outputType": "file", "filePath": out, "maxDimension": int(args.get("maxDimension", 0) or 0)})
    if not result or not result.get("success"):
        raise RuntimeError(f"ExportFrame failed: {(result or {}).get('error')}")
    return {"path": out, "width": result.get("width"), "height": result.get("height")}


def op_render(args):
    resolve = get_resolve()
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
        raise RuntimeError("SetRenderSettings failed")
    job_id = project.AddRenderJob()
    if not job_id:
        raise RuntimeError("AddRenderJob failed")
    if not project.StartRendering([job_id]):
        raise RuntimeError("StartRendering failed")
    return {"jobId": job_id, "targetDir": args["targetDir"]}


def op_render_status(args):
    resolve = get_resolve()
    project = resolve.GetProjectManager().GetCurrentProject()
    return {
        "job": project.GetRenderJobStatus(args["jobId"]),
        "all": project.GetRenderJobList(),
    }


def op_py(args):
    """Escape hatch: run arbitrary Python with `resolve`, `project`, `timeline` in scope."""
    resolve = get_resolve()
    project = resolve.GetProjectManager().GetCurrentProject()
    timeline = project.GetCurrentTimeline() if project else None
    scope = {"resolve": resolve, "project": project, "timeline": timeline, "mediapool": project.GetMediaPool() if project else None}
    code = args["code"]
    try:
        value = eval(code, scope)  # noqa: S307 - explicit escape hatch requested by the user
    except SyntaxError:
        exec(code, scope)  # noqa: S102
        value = scope.get("result")
    return {"value": value if isinstance(value, (dict, list, str, int, float, bool, type(None))) else repr(value)}


OPS = {
    "status": op_status,
    "import_fcpxml": op_import_fcpxml,
    "timeline": op_timeline,
    "export_frame": op_export_frame,
    "render": op_render,
    "render_status": op_render_status,
    "py": op_py,
}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            op = request.get("op")
            handler = OPS.get(op)
            if handler is None:
                raise RuntimeError(f"unknown op: {op}")
            result = handler(request.get("args") or {})
            payload = {"id": request_id, "ok": True, "result": result}
        except Exception as exc:
            payload = {
                "id": request_id,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc(limit=4),
            }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
