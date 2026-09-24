# Copyright (C) 2026 sognix
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import traceback
import uuid
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

import catalog
from jobs import JobManager

logger = logging.getLogger("video2x-web")

VIDEO2X_BIN = os.environ.get("VIDEO2X_BIN", "video2x")
VIDEOS_ROOT = Path(os.environ.get("VIDEOS_ROOT", "/videos")).resolve()
BATCH_ROOT = Path(os.environ.get("BATCH_ROOT", "/batch")).resolve()
LOG_ROOT = Path(os.environ.get("LOG_ROOT", "/logs")).resolve()
# preview clips (source cut + rendered result) — scratch space, deleted with their job
CLIP_ROOT = Path(os.environ.get("CLIP_ROOT", "/tmp/video2x-clips")).resolve()
FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.environ.get("FFPROBE_BIN", "ffprobe")
# Linked in the page footer. AGPL-3.0 §13: whoever runs a modified version for others
# over a network must offer them its source — point this at your fork if you change the code.
SOURCE_URL = os.environ.get("SOURCE_URL", "")
(VIDEOS_ROOT / "input").mkdir(parents=True, exist_ok=True)
(VIDEOS_ROOT / "output").mkdir(parents=True, exist_ok=True)
BATCH_ROOT.mkdir(parents=True, exist_ok=True)
LOG_ROOT.mkdir(parents=True, exist_ok=True)
shutil.rmtree(CLIP_ROOT, ignore_errors=True)  # clips from before a restart belong to no job anymore
CLIP_ROOT.mkdir(parents=True, exist_ok=True)

ROOTS = {"videos": VIDEOS_ROOT, "batch": BATCH_ROOT}

app = FastAPI(title="Video2X webGUI")
manager = JobManager(VIDEO2X_BIN, log_root=LOG_ROOT)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """Any bug that isn't an explicit HTTPException still gets a real, readable
    error message to the client (plus the full traceback in the server log)
    instead of a bare "Internal Server Error" with no way to tell what broke."""
    logger.error("unhandled error on %s %s:\n%s", request.method, request.url.path, traceback.format_exc())
    return JSONResponse(
        status_code=500,
        content={"detail": f"internal error: {type(exc).__name__}: {exc}"},
    )


def safe_path(root_name: str, relative: str) -> Path:
    """Resolve a path relative to the given root (videos/batch), refusing to escape it."""
    root = ROOTS.get(root_name)
    if root is None:
        raise HTTPException(400, f"unknown root {root_name!r}")
    candidate = (root / relative.lstrip("/")).resolve()
    if candidate != root and root not in candidate.parents:
        raise HTTPException(400, f"path escapes /{root_name}")
    return candidate


# ---------------------------------------------------------------- metadata

@app.get("/api/meta/processors")
def get_processors():
    return catalog.PROCESSORS


@app.get("/api/meta/options")
def get_options():
    return {
        "hwaccel": catalog.HWACCEL_OPTIONS,
        "hwaccel_warning": catalog.HWACCEL_WARNING,
        "log_levels": catalog.LOG_LEVELS,
        "encoder_presets": catalog.ENCODER_PRESETS,
        "video_extensions": catalog.VIDEO_EXTENSIONS,
        "source_url": SOURCE_URL,
    }


_device_cache: list[dict] | None = None


def list_vulkan_devices(refresh: bool = False) -> list[dict]:
    """Detected Vulkan devices. Probed once and cached — `video2x --list-devices`
    spins up Vulkan on every GPU, far too heavy to repeat on every status poll."""
    global _device_cache
    if _device_cache is None or refresh:
        _device_cache = _probe_vulkan_devices()
    return _device_cache


def _probe_vulkan_devices() -> list[dict]:
    try:
        proc = subprocess.run(
            [VIDEO2X_BIN, "--list-devices"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        result = proc.stdout + proc.stderr
    except Exception as exc:  # pragma: no cover
        raise HTTPException(500, str(exc))
    devices = []
    current = None
    for line in result.splitlines():
        m = re.match(r"^(\d+)\.\s+(.*)$", line.strip())
        if m:
            if current:
                devices.append(current)
            current = {"index": int(m.group(1)), "name": m.group(2), "type": None}
            continue
        m2 = re.match(r"^Type:\s+(.+)$", line.strip())
        if m2 and current:
            current["type"] = m2.group(1).strip()
    if current:
        devices.append(current)
    return devices


@app.get("/api/meta/devices")
def get_devices(refresh: bool = False):
    return list_vulkan_devices(refresh)


# ------------------------------------------------------------------- files

@app.get("/api/files")
def list_files(path: str = "", root: str = "videos"):
    root_path = ROOTS.get(root)
    if root_path is None:
        raise HTTPException(400, f"unknown root {root!r}")
    target = safe_path(root, path)
    if not target.exists():
        raise HTTPException(404, "not found")
    if target.is_file():
        raise HTTPException(400, "not a directory")
    entries = []
    for entry in sorted(target.iterdir()):
        entries.append(
            {
                "name": entry.name,
                "path": str(entry.relative_to(root_path)),
                "is_dir": entry.is_dir(),
                "size": entry.stat().st_size if entry.is_file() else None,
            }
        )
    return {"root": root, "path": str(target.relative_to(root_path)), "entries": entries}


# Plain `def` on purpose: FastAPI runs it in a worker thread, so copying a
# multi-GB upload to disk doesn't stall the event loop (and with it every
# running job's progress and WebSocket).
@app.post("/api/files/upload")
def upload_file(
    file: UploadFile = File(...), dest_dir: str = "input", root: str = "videos", overwrite: bool = False
):
    target_dir = safe_path(root, dest_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = os.path.basename(file.filename or "upload.bin")
    target = target_dir / filename
    if target.exists() and not overwrite:
        raise HTTPException(409, f"{filename} already exists in /{root}/{dest_dir}")
    with target.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    return {"path": str(target.relative_to(ROOTS[root]))}


@app.delete("/api/files")
def delete_file(path: str, root: str = "videos"):
    target = safe_path(root, path)
    if not target.exists():
        raise HTTPException(404, "not found")
    if target.is_dir():
        raise HTTPException(400, "refusing to delete a directory")
    target.unlink()
    return {"ok": True}


@app.get("/api/files/download")
def download_file(path: str, root: str = "videos"):
    target = safe_path(root, path)
    if not target.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(target, filename=target.name)


# -------------------------------------------------------------------- jobs

class EncoderOption(BaseModel):
    key: str
    value: str


class ProcessingOptions(BaseModel):
    processor: Literal["libplacebo", "realesrgan", "realcugan", "rife"]
    options: dict = Field(default_factory=dict)
    device: int = 0
    hwaccel: str = "none"
    log_level: str = "info"
    benchmark: bool = False
    no_copy_streams: bool = False
    codec: str = "libx264"
    crf: Optional[int] = None
    preset: Optional[str] = None
    bit_rate: Optional[int] = None
    extra_encoder_options: list[EncoderOption] = Field(default_factory=list)


class JobRequest(ProcessingOptions):
    input_path: str
    output_name: str
    overwrite: bool = False  # replace an existing file in /videos/output


class BatchRequest(ProcessingOptions):
    input_dir: str
    output_ext: str = "mkv"
    devices: list[int] = Field(default_factory=list)  # empty = auto (every detected non-CPU device)
    overwrite: bool = False  # replace existing files in /videos/output
    move_done: bool = True  # move each successfully processed input into <input_dir>/done/


class ClipRequest(ProcessingOptions):
    root: Literal["videos", "batch"] = "videos"
    input_path: str
    start: float = Field(60, ge=0)  # seconds into the file — past intros/logos by default
    duration: float = Field(10, gt=0, le=120)


def check_outputs(outputs: list[Path], overwrite: bool):
    """Refuse outputs another queued/running job already writes to (always), or
    that already exist on disk (unless overwrite). 409 so the UI can ask first."""
    active = manager.active_outputs()
    busy = [p.name for p in outputs if str(p.relative_to(VIDEOS_ROOT)) in active]
    if busy:
        raise HTTPException(
            400, f"a queued/running job already writes to: {', '.join(busy)} — pick another output name"
        )
    if overwrite:
        return
    existing = [p.name for p in outputs if p.exists()]
    if existing:
        shown = ", ".join(existing[:5]) + (f" (+{len(existing) - 5} more)" if len(existing) > 5 else "")
        folder = "/videos/" + str(outputs[0].parent.relative_to(VIDEOS_ROOT))
        raise HTTPException(409, f"{len(existing)} output file(s) already exist in {folder}: {shown}")


def safe_int(value, field_name: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        raise HTTPException(400, f"Insert Number for {field_name}")


def build_args(req: ProcessingOptions, input_abs: Path, output_abs: Path) -> list[str]:
    spec = catalog.PROCESSORS.get(req.processor)
    if not spec:
        raise HTTPException(400, f"unknown processor {req.processor}")

    error = catalog.validate_processor_options(req.processor, req.options)
    if error:
        raise HTTPException(400, error)

    args = [
        "--log-level", req.log_level,
        "-i", str(input_abs),
        "-o", str(output_abs),
        "-p", req.processor,
        "-a", req.hwaccel,
        "-d", str(req.device),
        "-c", req.codec,
    ]
    if req.no_copy_streams:
        args.append("--no-copy-streams")
    if req.benchmark:
        args.append("--benchmark")
    if req.bit_rate is not None:
        args += ["--bit-rate", str(req.bit_rate)]
    if req.crf is not None:
        args += ["-e", f"crf={req.crf}"]
    if req.preset is not None:
        args += ["-e", f"preset={req.preset}"]
    for opt in req.extra_encoder_options:
        if not re.match(r"^[A-Za-z0-9_.-]+$", opt.key):
            raise HTTPException(400, f"invalid encoder option key: {opt.key}")
        args += ["-e", f"{opt.key}={opt.value}"]

    opts = req.options
    if req.processor == "libplacebo":
        if "width" not in opts or "height" not in opts:
            raise HTTPException(400, "libplacebo requires width and height")
        args += ["-w", str(safe_int(opts["width"], "width")), "-h", str(safe_int(opts["height"], "height"))]
        args += ["--libplacebo-shader", str(opts.get("shader", "anime4k-v4-a"))]
    elif req.processor == "realesrgan":
        args += ["-s", str(opts.get("scaling_factor", "4"))]
        args += ["--realesrgan-model", str(opts.get("model", "realesr-animevideov3"))]
    elif req.processor == "realcugan":
        args += ["-s", str(opts.get("scaling_factor", "2"))]
        args += ["-n", str(opts.get("noise_level", "0"))]
        args += ["--realcugan-model", str(opts.get("model", "models-se"))]
        args += ["--realcugan-threads", str(opts.get("threads", 1))]
        args += ["--realcugan-syncgap", str(opts.get("syncgap", "3"))]
    elif req.processor == "rife":
        if "frame_rate_mul" not in opts:
            raise HTTPException(400, "rife requires frame_rate_mul")
        args += ["-m", str(safe_int(opts["frame_rate_mul"], "frame_rate_mul"))]
        args += ["--rife-model", str(opts.get("model", "rife-v4.6"))]
        if opts.get("uhd"):
            args.append("--rife-uhd")

    return args


@app.post("/api/jobs")
async def create_job(req: JobRequest):
    input_abs = safe_path("videos", req.input_path)
    if not input_abs.is_file():
        raise HTTPException(404, "input file not found")

    output_name = os.path.basename(req.output_name)
    if not output_name:
        raise HTTPException(400, "output_name required")
    output_abs = safe_path("videos", f"output/{output_name}")
    output_abs.parent.mkdir(parents=True, exist_ok=True)
    check_outputs([output_abs], req.overwrite)

    args = build_args(req, input_abs, output_abs)
    job = manager.start(
        args,
        str(input_abs.relative_to(VIDEOS_ROOT)),
        str(output_abs.relative_to(VIDEOS_ROOT)),
        device=req.device,
    )
    return job.summary()


@app.post("/api/batch/jobs")
async def create_batch(req: BatchRequest):
    input_dir_abs = safe_path("batch", req.input_dir)
    if not input_dir_abs.is_dir():
        raise HTTPException(404, "input_dir not found under /batch")

    ext = req.output_ext.lstrip(".") or "mkv"
    video_exts = set(catalog.VIDEO_EXTENSIONS)
    files = sorted(
        p for p in input_dir_abs.iterdir() if p.is_file() and p.suffix.lstrip(".").lower() in video_exts
    )
    if not files:
        raise HTTPException(400, "no video files in input_dir")

    # Two inputs sharing a stem (a.mp4 + a.avi) would both become a.<ext> —
    # give those the original extension in the name so neither clobbers the other.
    stem_counts: dict[str, int] = {}
    for f in files:
        stem_counts[f.stem] = stem_counts.get(f.stem, 0) + 1
    # outputs mirror the batch folder: /batch/Show/x.mkv -> /videos/output/Show/x.<ext>
    rel_dir = input_dir_abs.relative_to(BATCH_ROOT)
    out_dir = "output" if str(rel_dir) == "." else f"output/{rel_dir}"
    outputs = []
    for f in files:
        name = f.stem if stem_counts[f.stem] == 1 else f"{f.stem}_{f.suffix.lstrip('.')}"
        outputs.append(safe_path("videos", f"{out_dir}/{name}.{ext}"))
    check_outputs(outputs, req.overwrite)

    move_to = str(input_dir_abs / "done") if req.move_done else None
    items = []
    for f, output_abs in zip(files, outputs):
        output_abs.parent.mkdir(parents=True, exist_ok=True)
        args = build_args(req, f, output_abs)
        input_display = f"/batch/{f.relative_to(BATCH_ROOT)}"
        output_display = str(output_abs.relative_to(VIDEOS_ROOT))
        items.append((args, input_display, output_display, move_to))

    if req.devices:
        device_indices = req.devices
    else:
        devices = list_vulkan_devices()
        gpu_devices = [d for d in devices if d.get("type") != "CPU"]
        device_indices = [d["index"] for d in (gpu_devices or devices)]
    if not device_indices:
        raise HTTPException(400, "no Vulkan devices available to run the batch on")

    batch_name = "/batch" if str(rel_dir) == "." else f"/batch/{rel_dir}"
    jobs = manager.start_batch(items, device_indices, batch_name)
    return {"jobs": [j.summary() for j in jobs], "devices_used": device_indices}


# --------------------------------------------------------------- clips

@app.post("/api/clips")
async def create_clip(req: ClipRequest):
    """Render a short piece of a file with the given settings, as a preview.

    ffmpeg cuts the piece (video only, re-encoded losslessly so the cut is
    frame-accurate — a stream copy would snap to the previous keyframe, which in
    broadcast rips can be several seconds early), then it's queued like a single
    job on req.device. The result is always H.264 in .mp4, so the browser can play
    it inline."""
    source = safe_path(req.root, req.input_path)
    if not source.is_file():
        raise HTTPException(404, "input file not found")

    clip_id = uuid.uuid4().hex[:12]
    cut = CLIP_ROOT / f"{clip_id}.source.mkv"
    rendered = CLIP_ROOT / f"{clip_id}.preview.mp4"
    try:
        proc = await asyncio.create_subprocess_exec(
            FFMPEG_BIN, "-hide_banner", "-loglevel", "error", "-y",
            "-ss", str(req.start), "-i", str(source), "-t", str(req.duration),
            "-map", "0:v:0", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", str(cut),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        raise HTTPException(500, "ffmpeg is not installed in this image")
    _, stderr = await proc.communicate()
    if proc.returncode != 0 or not cut.is_file() or cut.stat().st_size == 0:
        cut.unlink(missing_ok=True)
        detail = stderr.decode(errors="replace").strip().splitlines()[-1:] or ["empty result"]
        raise HTTPException(400, f"could not cut the clip (is the file shorter than {req.start:g} s?): {detail[0]}")

    clip_req = req.model_copy(update={"codec": "libx264", "no_copy_streams": True, "benchmark": False})
    args = build_args(clip_req, cut, rendered)
    display = f"{req.root}/{req.input_path}".removeprefix("videos/")
    job = manager.start(
        args,
        f"{display} @ {req.start:g}s (+{req.duration:g}s)",
        "preview clip",
        device=req.device,
        kind="clip",
        temp_files=[str(cut), str(rendered)],
    )
    return job.summary()


@app.get("/api/clips/{job_id}")
def get_clip(job_id: str):
    job = manager.get(job_id)
    if not job or job.kind != "clip" or job.status != "done":
        raise HTTPException(404, "no finished preview clip with that id")
    return FileResponse(job.temp_files[1], media_type="video/mp4")


# --------------------------------------------------------------- probe

_probe_cache: dict[tuple[str, float, int], dict] = {}
_probe_limit = asyncio.Semaphore(8)


async def probe_file(path: Path) -> dict:
    """Resolution / frame rate / duration / codec of a video's first video stream (cached)."""
    stat = path.stat()
    key = (str(path), stat.st_mtime, stat.st_size)
    if key in _probe_cache:
        return _probe_cache[key]
    async with _probe_limit:
        try:
            proc = await asyncio.create_subprocess_exec(
                FFPROBE_BIN, "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=codec_name,width,height,avg_frame_rate:format=duration",
                "-of", "json", str(path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except FileNotFoundError:
            return {"error": "ffprobe is not installed in this image"}
        out, _ = await proc.communicate()
    try:
        data = json.loads(out)
        stream = data["streams"][0]
        num, _, den = stream.get("avg_frame_rate", "0/1").partition("/")
        info = {
            "width": stream.get("width"),
            "height": stream.get("height"),
            "codec": stream.get("codec_name"),
            "fps": round(float(num) / float(den), 3) if float(den or 0) else None,
            "duration": float(data.get("format", {}).get("duration", 0)) or None,
        }
    except (ValueError, KeyError, IndexError):
        info = {"error": "not a readable video"}
    _probe_cache[key] = info
    return info


@app.get("/api/probe")
async def probe(path: str, root: str = "videos"):
    """Video info for one file, or for every video file directly inside a folder."""
    target = safe_path(root, path)
    if target.is_file():
        return await probe_file(target)
    if not target.is_dir():
        raise HTTPException(404, "not found")
    video_exts = set(catalog.VIDEO_EXTENSIONS)
    files = sorted(p for p in target.iterdir() if p.is_file() and p.suffix.lstrip(".").lower() in video_exts)
    infos = await asyncio.gather(*(probe_file(f) for f in files))
    return {"files": [{"name": f.name, **info} for f, info in zip(files, infos)]}


# ---------------------------------------------------------------- logs

LOG_VIEW_LIMIT = 2 * 1024 * 1024  # bytes shown in the Logs tab; bigger logs show their tail


def log_file_path(name: str) -> Path:
    if name != os.path.basename(name) or not name.endswith(".log"):
        raise HTTPException(400, "invalid log name")
    path = LOG_ROOT / name
    if not path.is_file():
        raise HTTPException(404, "log not found")
    return path


@app.get("/api/logs")
def list_logs():
    active = manager.active_log_paths()
    files = []
    for p in LOG_ROOT.glob("*.log"):
        stat = p.stat()
        files.append({"name": p.name, "size": stat.st_size, "mtime": stat.st_mtime, "active": str(p) in active})
    files.sort(key=lambda f: f["mtime"], reverse=True)
    return {"dir": str(LOG_ROOT), "writable": os.access(LOG_ROOT, os.W_OK), "files": files}


@app.get("/api/logs/{name}")
def read_log(name: str):
    path = log_file_path(name)
    with path.open("rb") as f:
        size = f.seek(0, os.SEEK_END)
        f.seek(max(0, size - LOG_VIEW_LIMIT))
        text = f.read().decode("utf-8", errors="replace")
    if size > LOG_VIEW_LIMIT:
        text = f"[… first {size - LOG_VIEW_LIMIT} bytes not shown …]\n" + text
    return PlainTextResponse(text)


@app.delete("/api/logs/{name}")
def delete_log(name: str):
    path = log_file_path(name)
    if str(path) in manager.active_log_paths():
        raise HTTPException(400, "this job is still running — its log is still being written")
    path.unlink()
    return {"ok": True}


@app.delete("/api/logs")
def clear_logs():
    """Delete every log except those of jobs still running."""
    active = manager.active_log_paths()
    removed = 0
    for p in LOG_ROOT.glob("*.log"):
        if str(p) not in active:
            p.unlink(missing_ok=True)
            removed += 1
    return {"removed": removed}


@app.get("/api/queues")
def get_queues():
    """Everything the Status tab shows: per-device queues (every detected device,
    plus any device index this session targeted that isn't detected anymore),
    batch progress, and totals with a rough overall ETA."""
    status = manager.queue_status()
    empty = {"running": None, "queued": [], "recent": [], "eta_seconds": 0.0}
    devices = []
    seen = set()
    for dev in list_vulkan_devices():
        idx = dev["index"]
        seen.add(idx)
        devices.append({"index": idx, "name": dev["name"], "type": dev.get("type"), **status.get(idx, empty)})
    for idx, entry in status.items():
        if idx not in seen:
            devices.append({"index": idx, "name": f"device {idx}", "type": None, **entry})

    pool = manager.pool_size()
    return {
        "devices": devices,
        "batches": manager.batch_status(),
        "summary": {
            "running": sum(1 for d in devices if d["running"]),
            "queued": sum(len(d["queued"]) for d in devices) + pool,
            "pool": pool,
            "eta_seconds": manager.overall_eta(),
        },
    }


@app.post("/api/devices/{device}/cancel")
async def cancel_device(device: int):
    """Cancel the running job and the single jobs waiting on one device. Pooled
    batch jobs aren't tied to a device yet — "Cancel batch" covers those."""
    return {"cancelled": await manager.cancel_many(manager.active_job_ids(device=device))}


@app.post("/api/batches/{batch_id}/cancel")
async def cancel_batch(batch_id: str):
    """Cancel every job of one batch that hasn't finished yet."""
    return {"cancelled": await manager.cancel_many(manager.active_job_ids(batch_id=batch_id))}


@app.get("/api/jobs")
def list_jobs():
    return manager.list_jobs()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return job.detail()


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    ok = await manager.cancel(job_id)
    if not ok:
        raise HTTPException(400, "job cannot be cancelled (already finished)")
    return {"ok": True}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    ok = manager.remove(job_id)
    if not ok:
        raise HTTPException(400, "job not found or still running/queued — cancel it first")
    return {"ok": True}


@app.delete("/api/jobs")
def clear_jobs():
    removed = manager.clear_finished()
    return {"removed": removed}


@app.websocket("/ws/jobs/{job_id}")
async def ws_job(websocket: WebSocket, job_id: str):
    job = manager.get(job_id)
    if not job:
        await websocket.close(code=4004)
        return
    await websocket.accept()
    queue: asyncio.Queue = asyncio.Queue()
    first = job.add_subscriber(queue)
    try:
        await websocket.send_json(first)
        if first["status"] in ("done", "error", "cancelled"):
            return
        while True:
            snapshot = await queue.get()
            await websocket.send_json(snapshot)
            if snapshot["status"] in ("done", "error", "cancelled"):
                break
    except WebSocketDisconnect:
        pass
    finally:
        job.subscribers.discard(queue)
