# Architecture

How the image and the app are put together — for the curious and for contributors.

## Why a custom web UI instead of streaming the Qt6 desktop GUI

Video2X's Qt6 GUI (`k4yt3x/video2x-qt6`) has no prebuilt Linux binary — no AppImage, no `.deb`, no Flatpak, only a Windows installer. Building it from source (C++/CMake/Qt6/clang) inside the image was rejected in favor of a lightweight web front end that talks to the (fully prebuilt, AppImage-distributed) `video2x` CLI directly. This also means the container doesn't need to run a desktop session (Xorg/Selkies/PulseAudio/dbus) at all — those services are present in the base image but disabled at build time, so the running container is just nginx + a small FastAPI backend + the video2x binary.

## What's in the image

- Base: `ghcr.io/linuxserver/baseimage-selkies:ubuntunoble` (linuxserver migrated their GUI/webtop images from `baseimage-kasmvnc` to `baseimage-selkies`; this project follows that, not the older base)
- `video2x` CLI installed from the official `Video2X-x86_64.AppImage` release asset, merged into `/usr` (not run as a mounted AppImage)
- A FastAPI backend (`app/backend`) that shells out to `video2x`, parses its progress output, and exposes a REST + WebSocket API
- A small vanilla HTML/JS frontend (`app/frontend`, no build step) covering every CLI option: processor (`libplacebo`, `realesrgan`, `realcugan`, `rife`) with their model/shader choices (only the combinations that actually work — see below), Vulkan device selection, hwaccel (off by default, with a warning — see below), encoder (codec/CRF/preset/bitrate/extra `-e key=value` options), benchmark mode, log level, live per-frame progress, job history, cancel, plus a batch mode that processes every file in a `/batch` folder
- nginx (from the base image) serves the frontend and reverse-proxies `/api/` and `/ws/` to the backend on `127.0.0.1:8000`
- Desktop-streaming services from the base image (Selkies, Xorg, PulseAudio, dbus, Docker-in-Docker) are removed from the s6 service bundle at build time — they never start

## Queueing

Every Vulkan device has one persistent worker and only ever runs one job at a time.

- **Single jobs** go into their device's own queue. Firing several at the same device
  queues the later ones instead of running them concurrently (they'd just fight over
  the same VRAM/compute).
- **Batch jobs** aren't assigned to a device up front. They wait in a shared pool, and
  a device takes the next file from there only once its own queue is empty — and only
  from batches it was selected for. A faster GPU therefore simply gets through more of
  a batch, and a single job started mid-batch runs right after the batch file currently
  on that GPU, not behind the rest of the batch.

The **Status** tab shows an overview with a rough time estimate, every batch's progress
(with "Cancel batch"), and per device what's running, what's waiting and what finished
recently (cards are collapsible; "Cancel all" per device). The page title shows how many jobs are
running and waiting, and when opened over HTTPS (or localhost) the browser can notify you when a
single job or a whole batch finishes. Batch mode only picks up video files (see
`VIDEO_EXTENSIONS` in `app/backend/catalog.py`) and refuses to overwrite existing
outputs without asking. Its outputs go into a folder named like the batch folder
(`/batch/Show/x.mkv` → `/videos/output/Show/x.mkv`), and each input that finished
successfully is moved into `/batch/Show/done/` (can be switched off per batch) — so
re-running the same folder after an interruption simply continues with what's left.

## Preview clips and video info

The image ships Ubuntu's `ffmpeg`/`ffprobe` package (in `/usr/bin`). It uses Ubuntu's own
FFmpeg libraries; `video2x` keeps loading the ones bundled with it (its RPATH points at
`/usr/lib`), so the two never mix. The UI uses them to:

- show resolution / frame rate / duration / codec of the selected input (per file and
  in total for a batch folder), plus what the current processor settings turn it into;
- render a **preview clip**: a few seconds (default 10 s, starting at 60 s) cut from the
  input and run through video2x with the current settings on the chosen GPU, queued like
  a single job, always as H.264 `.mp4` without audio so it plays inline in its job card.
  Clips live in `/tmp/video2x-clips` and are deleted when the job is cleared (or on restart).

## Logs tab

Lists the per-job log files in `/logs` (newest first) to read or delete, one by one or
all at once — logs of jobs still running are kept. It also warns when `/logs` isn't
writable for the app; a job whose log file can't be created says so in its own log.
