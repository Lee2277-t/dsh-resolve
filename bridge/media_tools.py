"""Helpers used by dsh-resolve: probe media, render title/plate PNGs.

Invoked as:  python media_tools.py <command> <request.json>
Prints a single JSON object (UTF-8) on stdout.
"""
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def fail(message, **extra):
    out = {"ok": False, "error": message}
    out.update(extra)
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


def load_request():
    with open(sys.argv[2], "r", encoding="utf-8") as fh:
        return json.load(fh)


def probe_media(req):
    target = req["path"]
    if not os.path.exists(target):
        return {"ok": False, "error": "file not found", "path": target}

    ext = os.path.splitext(target)[1].lower()
    image_ext = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".gif", ".exr", ".dpx"}

    if ext in image_ext:
        try:
            from PIL import Image

            with Image.open(target) as img:
                width, height = img.size
                mode = img.mode
            return {
                "ok": True,
                "kind": "image",
                "path": target,
                "width": width,
                "height": height,
                "hasAlpha": mode in ("RGBA", "LA") or "transparency" in mode,
                "frames": int(req.get("frames") or 0),
            }
        except Exception as exc:  # pragma: no cover - defensive
            return {"ok": False, "error": f"image probe failed: {exc}", "path": target}

    try:
        import cv2
    except Exception as exc:
        return {"ok": False, "error": f"opencv not available: {exc}", "path": target}

    cap = cv2.VideoCapture(target)
    if not cap.isOpened():
        return {"ok": False, "error": "could not open media (unsupported codec or path)", "path": target}
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    finally:
        cap.release()

    if fps <= 0:
        fps = float(req.get("assumedFps") or 25.0)
    duration = frames / fps if fps else 0.0
    return {
        "ok": True,
        "kind": "video",
        "path": target,
        "width": width,
        "height": height,
        "fps": round(fps, 6),
        "frames": frames,
        "duration": round(duration, 6),
        "hasAudio": True,
    }


FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/Arial.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def pick_font(explicit=None, size=64):
    from PIL import ImageFont

    if explicit and os.path.exists(explicit):
        return ImageFont.truetype(explicit, size)
    for candidate in FONT_CANDIDATES:
        if os.path.exists(candidate):
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def wrap(draw, text, font, max_width):
    words = text.split(" ")
    lines, current = [], ""
    for word in words:
        probe = (current + " " + word).strip()
        if draw.textlength(probe, font=font) <= max_width or not current:
            current = probe
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)

    # CJK has no spaces: hard-wrap any line that is still too wide.
    out = []
    for line in lines:
        if draw.textlength(line, font=font) <= max_width:
            out.append(line)
            continue
        buf = ""
        for ch in line:
            if draw.textlength(buf + ch, font=font) <= max_width:
                buf += ch
            else:
                out.append(buf)
                buf = ch
        if buf:
            out.append(buf)
    return out


def render_text(req):
    from PIL import Image, ImageDraw

    width = int(req.get("width") or 1920)
    height = int(req.get("height") or 1080)
    text = (req.get("text") or "").strip()
    sub = (req.get("sub") or "").strip()
    style = req.get("style") or "center"
    color = tuple(req.get("color") or (255, 255, 255))
    accent = tuple(req.get("accent") or (255, 176, 32))
    opacity = int(req.get("opacity", 255))

    if not text:
        return {"ok": False, "error": "text is empty"}

    base = int(req.get("size") or max(20, round(height * (0.062 if style != "lower" else 0.050))))
    font = pick_font(req.get("font"), base)
    sub_font = pick_font(req.get("font"), int(base * 0.58))

    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    max_width = width * 0.84

    lines = wrap(draw, text, font, max_width)
    line_h = int(base * 1.28)
    block_h = line_h * len(lines)
    sub_lines = wrap(draw, sub, sub_font, max_width * 0.9) if sub else []
    sub_h = int(base * 0.58 * 1.35) * len(sub_lines)

    if style == "lower":
        # Lower third: accent bar + left-aligned stack, sitting above the lower edge.
        pad = int(width * 0.055)
        top = int(height * 0.70) - block_h
        if sub_lines:
            top -= sub_h
        bar_x = pad - int(width * 0.018)
        draw.rectangle([bar_x, top + 2, bar_x + max(4, int(width * 0.006)), top + block_h + (sub_h + 8 if sub_lines else 0)],
                       fill=accent + (opacity,))
        y = top
        for line in lines:
            draw.text((pad + 2, y + 3), line, font=font, fill=(0, 0, 0, min(150, opacity)))
            draw.text((pad, y), line, font=font, fill=color + (opacity,))
            y += line_h
        if sub_lines:
            y += 4
            for line in sub_lines:
                draw.text((pad + 2, y + 2), line, font=sub_font, fill=(0, 0, 0, min(130, opacity)))
                draw.text((pad, y), line, font=sub_font, fill=(236, 236, 236, opacity))
                y += int(base * 0.58 * 1.35)
    else:
        y = int((height - block_h - sub_h) / 2)
        for line in lines:
            w = draw.textlength(line, font=font)
            x = (width - w) / 2
            draw.text((x + 2, y + 3), line, font=font, fill=(0, 0, 0, min(160, opacity)))
            draw.text((x, y), line, font=font, fill=color + (opacity,))
            y += line_h
        if sub_lines:
            y += int(base * 0.18)
            for line in sub_lines:
                w = draw.textlength(line, font=sub_font)
                x = (width - w) / 2
                draw.text((x + 2, y + 2), line, font=sub_font, fill=(0, 0, 0, min(130, opacity)))
                draw.text((x, y), line, font=sub_font, fill=(232, 232, 232, opacity))
                y += int(base * 0.58 * 1.35)

    out_path = req["out"]
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    img.save(out_path)
    return {"ok": True, "path": out_path, "width": width, "height": height, "lines": len(lines)}


def render_solid(req):
    from PIL import Image

    width = int(req.get("width") or 1920)
    height = int(req.get("height") or 1080)
    color = tuple(req.get("color") or (0, 0, 0))
    out_path = req["out"]
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    Image.new("RGB", (width, height), color).save(out_path)
    return {"ok": True, "path": out_path, "width": width, "height": height}


COMMANDS = {"probe": probe_media, "title": render_text, "solid": render_solid}


def main():
    if len(sys.argv) < 3:
        fail("usage: media_tools.py <command> <request.json>")
    command = sys.argv[1]
    handler = COMMANDS.get(command)
    if not handler:
        fail(f"unknown command: {command}")
    try:
        req = load_request()
        result = handler(req)
    except Exception as exc:
        fail(f"{type(exc).__name__}: {exc}")
        return
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
