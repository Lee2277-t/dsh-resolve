"""Offline frame reconstruction for dsh-resolve.

Rebuilds "what frame N of this edit should look like" without touching Resolve:
pull the source frame with ffmpeg, then composite the title overlays that are
alive at that frame. This is the free-edition stand-in for Studio's ExportFrame.

Invoked as:  python preview.py <request.json>
Prints one JSON object on stdout.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(0)


def load(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def find_ffmpeg(explicit, near):
    if explicit and os.path.exists(explicit):
        return explicit
    env = os.environ.get("FFMPEG_PATH") or os.environ.get("FFMPEG_EXE")
    if env and os.path.exists(env):
        return env
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, ".dsh", "bin", "ffmpeg.exe"),
        os.path.join(home, ".dsh", "bin", "ffmpeg"),
        "/usr/local/bin/ffmpeg",
        "/opt/homebrew/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ]
    if near:
        candidates.append(os.path.join(os.path.dirname(near), "ffmpeg.exe"))
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def fit_cover(img, width, height):
    from PIL import Image

    scale = max(width / img.width, height / img.height)
    size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    resized = img.resize(size, Image.LANCZOS)
    left = (size[0] - width) // 2
    top = (size[1] - height) // 2
    return resized.crop((left, top, left + width, top + height))


def grab_video_frame(ffmpeg, path, seconds, width, height, workdir):
    if ffmpeg is None:
        return None, "ffmpeg not found"
    out = os.path.join(workdir, "grab-%d.png" % abs(hash((path, round(seconds, 3)))))
    vf = "scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d" % (width, height, width, height)
    cmd = [
        ffmpeg, "-nostdin", "-v", "error", "-ss", "%.3f" % max(0.0, seconds),
        "-i", path, "-frames:v", "1", "-vf", vf, "-y", out,
    ]
    try:
        subprocess.run(cmd, check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as exc:
        message = (exc.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        return None, "ffmpeg failed: " + (message[-1] if message else "unknown")
    except Exception as exc:
        return None, "ffmpeg error: %s" % exc
    if not os.path.exists(out):
        return None, "ffmpeg produced no frame"
    return out, None


def render(request):
    from PIL import Image, ImageDraw, ImageFont

    width = int(request.get("width") or 1920)
    height = int(request.get("height") or 1080)
    fps = float(request.get("fps") or 25)
    out_dir = request["outDir"]
    os.makedirs(out_dir, exist_ok=True)

    clips = request.get("clips") or []
    overlays = request.get("overlays") or []
    frames = [int(f) for f in (request.get("frames") or [])]
    warnings = []

    ffmpeg = find_ffmpeg(request.get("ffmpeg"), clips[0]["file"] if clips and clips[0].get("file") else None)
    workdir = tempfile.mkdtemp(prefix="dsh-preview-")
    produced = []

    for index in frames:
        canvas = Image.new("RGBA", (width, height), (8, 9, 12, 255))
        clip = None
        for candidate in clips:
            start = int(candidate.get("startFrames", 0))
            if start <= index < start + int(candidate.get("durationFrames", 0)):
                clip = candidate
                break

        if clip is None:
            warnings.append("frame %d falls outside every clip" % index)
        else:
            path = clip["file"]
            if clip.get("kind") == "image":
                try:
                    with Image.open(path) as img:
                        canvas.alpha_composite(fit_cover(img.convert("RGBA"), width, height))
                except Exception as exc:
                    warnings.append("frame %d: image read failed (%s)" % (index, exc))
            else:
                offset = index - int(clip.get("startFrames", 0))
                seconds = (int(clip.get("sourceStartFrames", 0)) + offset) / fps
                grabbed, error = grab_video_frame(ffmpeg, path, seconds, width, height, workdir)
                if grabbed:
                    with Image.open(grabbed) as img:
                        canvas.alpha_composite(img.convert("RGBA"))
                else:
                    warnings.append("frame %d: %s" % (index, error))

        for layer in overlays:
            start = int(layer.get("startFrames", 0))
            if start <= index < start + int(layer.get("durationFrames", 0)):
                try:
                    with Image.open(layer["file"]) as img:
                        canvas.alpha_composite(img.convert("RGBA"))
                except Exception as exc:
                    warnings.append("frame %d: overlay %s failed (%s)" % (index, os.path.basename(layer["file"]), exc))

        out_path = os.path.join(out_dir, "frame-%05d.png" % index)
        canvas.convert("RGB").save(out_path)
        produced.append({"index": index, "path": out_path, "seconds": round(index / fps, 3)})

    sheet_path = None
    if request.get("sheet", True) and produced:
        sheet_path = build_sheet(produced, width, height, fps, out_dir, request.get("sheetColumns", 2))

    return {"ok": True, "frames": produced, "sheet": sheet_path, "warnings": warnings, "ffmpeg": ffmpeg}


def build_sheet(produced, width, height, fps, out_dir, columns):
    from PIL import Image, ImageDraw, ImageFont

    columns = max(1, min(int(columns or 2), 4))
    rows = (len(produced) + columns - 1) // columns
    cell_w = min(width, 960)
    cell_h = round(cell_w * height / width)
    label_h = 34
    gap = 10
    sheet_w = columns * cell_w + (columns + 1) * gap
    sheet_h = rows * (cell_h + label_h) + (rows + 1) * gap
    sheet = Image.new("RGB", (sheet_w, sheet_h), (18, 19, 23))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype(FONT_CANDIDATES[0], 20)
    except Exception:
        font = ImageFont.load_default()

    for position, item in enumerate(produced):
        col = position % columns
        row = position // columns
        x = gap + col * (cell_w + gap)
        y = gap + row * (cell_h + label_h + gap)
        with Image.open(item["path"]) as img:
            sheet.paste(img.convert("RGB").resize((cell_w, cell_h), Image.LANCZOS), (x, y))
        total = int(item["index"])
        rounded = round(fps)
        tc = "%02d:%02d:%02d:%02d" % (total // (rounded * 3600), (total // (rounded * 60)) % 60, (total // rounded) % 60, total % rounded)
        draw.text((x + 6, y + cell_h + 6), "frame %d  ·  %s" % (item["index"], tc), font=font, fill=(210, 214, 222))

    path = os.path.join(out_dir, "contact-sheet.png")
    sheet.save(path)
    return path


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "usage: preview.py <request.json>"})
    try:
        request = load(sys.argv[1])
        emit(render(request))
    except Exception as exc:
        import traceback

        emit({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc), "traceback": traceback.format_exc(limit=3)})


if __name__ == "__main__":
    main()
