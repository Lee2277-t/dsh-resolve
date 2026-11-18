# Changelog

## 0.2.0 — 2026-11-18

- Public release. No personal paths, no machine-specific assumptions.
- Resolve is located through `RESOLVE_EXE`, the usual install folders, the running
  process, then the uninstall registry — no hard-coded drive letters.
- Python and ffmpeg lookup honour `DSH_RESOLVE_PYTHON` / `PYTHON` and
  `FFMPEG_PATH` / `FFMPEG_EXE`, then PATH.
- The in-app bridge is only copied into Resolve's Scripts folder when Resolve is
  installed here, and `installBridgeScript: false` turns it off.
- `resolve_preview` works without ffmpeg for image-only timelines.
- FCPXML format names use the exact `FFVideoFormat<height>p<rate>` form Resolve
  expects, including 2160p.
- Title overlay file names are collision-free past 52 titles.
- Added `npm test` (9 checks) and GitHub Actions CI on Windows and Linux.
- Added LICENSE, .gitignore and .gitattributes.

## 0.1.0

- First working version: `resolve_doctor`, `resolve_help`, `resolve_build`,
  `resolve_preview`, `resolve_import`, `resolve_state`, `resolve_frame`,
  `resolve_render`, `resolve_py`, `resolve_live`, `resolve_live_status`.
- Verified import into DaVinci Resolve 21.2 (free edition).
