# Copyright (C) 2026 sognix
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Runs the video2x CLI as a subprocess and tracks its live progress."""

import asyncio
import logging
import re
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import TextIO

PROGRESS_RE = re.compile(
    r"frame=(\d+)/(\d+)\s+\(([\d.]+)%\);\s+fps=([\w.]+);\s+elapsed=([\d:]+);\s+remaining=([\d:]+)"
)
LOG_LINE_RE = re.compile(r"^\[[\d:\- ]+\]\s+\[(\w+)\]\s+(.*)$")

logger = logging.getLogger("video2x-web")

MAX_LOG_LINES = 2000
FINISHED_STATUSES = ("done", "error", "cancelled")
RECENT_PER_DEVICE = 5  # finished jobs listed per device on the Status tab
BROADCAST_INTERVAL = 0.5  # seconds between progress pushes to WebSocket subscribers

# (pattern to look for in the failed job's log, hint to append) — first match wins
ERROR_HINTS = [
    (
        re.compile(r"not currently supported in container", re.I),
        "tip: the output container can't hold one of the input's streams (often a subtitle "
        "track like subrip in an .mp4). Try an .mkv output filename instead, or enable "
        "\"Don't copy audio/subtitle streams\".",
    ),
    (
        re.compile(r"shader file not found", re.I),
        "tip: the libplacebo shader name doesn't match a bundled shader — pick one from the dropdown.",
    ),
    (
        re.compile(r"no vulkan devices? found|invalid device|failed to.*vulkan device", re.I),
        "tip: no usable Vulkan device at that index — check the Vulkan device dropdown, and "
        "if you expect a GPU, confirm the container was started with --gpus all.",
    ),
    (
        re.compile(r"no such file or directory", re.I),
        "tip: an input or model file couldn't be found — check the input file still exists under /videos.",
    ),
    (
        re.compile(r"cuda is not supported as input pixel format|failed to convert avframe", re.I),
        "tip: hwaccel=cuda decodes frames into GPU memory that the ncnn/Vulkan filter step can't "
        "read here. Set hwaccel back to \"none\" — the upscaling itself still runs on the GPU via "
        "the selected Vulkan device regardless of hwaccel, which only affects decode.",
    ),
]


def parse_hms(value: str) -> float | None:
    """'01:02:03' / '02:03' -> seconds, None if empty or unparseable."""
    if not value:
        return None
    try:
        seconds = 0.0
        for part in value.split(":"):
            seconds = seconds * 60 + float(part)
        return seconds
    except ValueError:
        return None


@dataclass
class Job:
    id: str
    args: list[str]
    input_path: str
    output_path: str
    device: int | None = None  # Vulkan device index this job is pinned to, once dispatched
    batch_id: str | None = None  # shared by every job of one batch submission
    batch_name: str | None = None  # batch folder, for display
    allowed_devices: list[int] = field(default_factory=list)  # batch only: GPUs that may pick this job
    kind: str = "job"  # "job", or "clip" for a short preview render
    move_input_to: str | None = None  # on success, move the input file into this folder (batch "done/")
    temp_files: list[str] = field(default_factory=list)  # deleted when the job is removed from history
    log_path: str | None = None  # this job's file under /logs, once it has started
    status: str = "queued"  # queued, running, done, error, cancelled
    progress: float = 0.0
    frame: int = 0
    total_frames: int = 0
    fps: str = ""
    elapsed: str = ""
    remaining: str = ""
    returncode: int | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    log: list[str] = field(default_factory=list)
    process: asyncio.subprocess.Process | None = None
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    log_file: TextIO | None = field(default=None, repr=False, compare=False)
    log_dirty: bool = field(default=True, repr=False, compare=False)  # new log lines since last broadcast

    def summary(self) -> dict:
        return {
            "id": self.id,
            "input_path": self.input_path,
            "output_path": self.output_path,
            "device": self.device,
            "batch_id": self.batch_id,
            "batch_name": self.batch_name,
            "kind": self.kind,
            "status": self.status,
            "progress": self.progress,
            "frame": self.frame,
            "total_frames": self.total_frames,
            "fps": self.fps,
            "elapsed": self.elapsed,
            "remaining": self.remaining,
            "returncode": self.returncode,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }

    def detail(self) -> dict:
        d = self.summary()
        d["log"] = self.log[-500:]
        return d

    async def _broadcast(self):
        # Only ship the (up to 500 line) log tail when it actually changed — most
        # pushes are just a progress tick. The frontend keeps the last log it got.
        snapshot = self.detail() if self.log_dirty else self.summary()
        self.log_dirty = False
        for q in list(self.subscribers):
            q.put_nowait(snapshot)

    def add_subscriber(self, queue: asyncio.Queue):
        """Register a WebSocket queue; it gets the full detail (log included) right away."""
        self.subscribers.add(queue)
        return self.detail()

    def _append_log(self, line: str):
        self.log.append(line)
        self.log_dirty = True
        if len(self.log) > MAX_LOG_LINES:
            del self.log[: len(self.log) - MAX_LOG_LINES]
        if self.log_file:
            self.log_file.write(line + "\n")
            self.log_file.flush()


class JobManager:
    """One persistent worker per Vulkan device, each running one job at a time.

    Single jobs go straight into their device's own queue. Batch jobs don't get a
    device up front: they wait in a shared pool, and a device's worker pulls the
    next batch job from there only once its own queue is empty. A faster GPU thus
    simply takes more files of a batch, and a single job submitted mid-batch runs
    right after the batch file currently on that GPU instead of behind the rest
    of the batch.
    """

    def __init__(self, video2x_bin: str, log_root: Path | None = None):
        self.video2x_bin = video2x_bin
        self.log_root = log_root
        self.jobs: dict[str, Job] = {}
        self.device_wake: dict[int, asyncio.Event] = {}  # one per device that has a worker
        self.device_pending: dict[int, list[Job]] = {}  # single jobs pinned to a device, in order
        self.device_running: dict[int, Job | None] = {}
        self.batch_pool: list[Job] = []  # batch jobs not picked up yet, oldest batch first

    def _log_path(self, job: Job) -> Path | None:
        if not self.log_root:
            return None
        input_name = Path(job.input_path.split(" @ ")[0]).name[:30]  # clips: "<file> @ 60s (+10s)"
        safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", input_name)
        prefix = "clip." if job.kind == "clip" else ""
        return self.log_root / f"{job.id}.{prefix}{safe_name}.log"

    def active_outputs(self) -> set[str]:
        """Output paths of every queued/running job — a new job must not write to one of these."""
        return {j.output_path for j in self.jobs.values() if j.status in ("running", "queued")}

    def list_jobs(self) -> list[dict]:
        # newest first; stable sort keeps a batch (shared created_at) in file order
        return [j.summary() for j in sorted(self.jobs.values(), key=lambda j: -j.created_at)]

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def remove(self, job_id: str) -> bool:
        """Remove a finished job from history. Refuses to remove a running/queued one."""
        job = self.jobs.get(job_id)
        if not job or job.status in ("running", "queued"):
            return False
        self._forget(job)
        return True

    def clear_finished(self) -> int:
        """Remove every done/error/cancelled job from history. Returns how many were removed."""
        finished = [j for j in self.jobs.values() if j.status in FINISHED_STATUSES]
        for job in finished:
            self._forget(job)
        return len(finished)

    def _forget(self, job: Job):
        del self.jobs[job.id]
        for path in job.temp_files:
            Path(path).unlink(missing_ok=True)

    def active_log_paths(self) -> set[str]:
        """Log files still being written — the Logs tab must not delete those."""
        return {j.log_path for j in self.jobs.values() if j.log_path and j.status == "running"}

    def start(
        self,
        args: list[str],
        input_path: str,
        output_path: str,
        device: int,
        kind: str = "job",
        temp_files: list[str] | None = None,
    ) -> Job:
        """Queue a single job on one device, behind whatever that device already has."""
        job_id = uuid.uuid4().hex[:12]
        job = Job(
            id=job_id,
            args=args,
            input_path=input_path,
            output_path=output_path,
            kind=kind,
            temp_files=temp_files or [],
        )
        self.jobs[job_id] = job
        self._pin_device(job, device)
        self._ensure_worker(device)
        self.device_pending[device].append(job)
        self.device_wake[device].set()
        return job

    def start_batch(
        self,
        items: list[tuple[list[str], str, str, str | None]],
        device_indices: list[int],
        batch_name: str,
    ) -> list[Job]:
        """Put every file of a batch into the shared pool. Whichever of the given
        devices runs out of its own work first takes the next file from there.

        Each item is (args, input display path, output display path, folder to move
        the input into once it finished successfully — or None to leave it)."""
        jobs = []
        created_at = time.time()
        batch_id = uuid.uuid4().hex[:12]
        for args, input_path, output_path, move_input_to in items:
            job_id = uuid.uuid4().hex[:12]
            job = Job(
                id=job_id,
                args=args,
                input_path=input_path,
                output_path=output_path,
                created_at=created_at,
                batch_id=batch_id,
                batch_name=batch_name,
                allowed_devices=list(device_indices),
                move_input_to=move_input_to,
            )
            self.jobs[job_id] = job
            jobs.append(job)
            self.batch_pool.append(job)
        for device in device_indices:
            self._ensure_worker(device)
            self.device_wake[device].set()
        return jobs

    def _ensure_worker(self, device: int):
        if device not in self.device_wake:
            self.device_wake[device] = asyncio.Event()
            self.device_pending[device] = []
            self.device_running[device] = None
            asyncio.create_task(self._worker(device))

    def _next_job(self, device: int) -> Job | None:
        """The device's own queue first, then the oldest batch job this device may run."""
        pending = self.device_pending[device]
        while pending:
            job = pending.pop(0)
            if job.status == "queued":
                return job
        for job in self.batch_pool:
            if job.status == "queued" and device in job.allowed_devices:
                self.batch_pool.remove(job)
                self._pin_device(job, device)
                return job
        return None

    async def _worker(self, device: int):
        """One persistent worker per device — runs one job at a time, forever."""
        wake = self.device_wake[device]
        while True:
            job = self._next_job(device)
            if job is None:
                # no await between the empty check and clear(), so a wake-up can't slip through
                wake.clear()
                await wake.wait()
                continue
            self.device_running[device] = job
            try:
                await self._run(job)
            finally:
                self.device_running[device] = None

    def queue_status(self) -> dict[int, dict]:
        """Per device: the running job (if any), its own waiting jobs in order, the
        last few finished jobs, and a rough ETA (seconds) until the device is done —
        including the share of pooled batch jobs it is expected to pick up."""
        free_at, _ = self._estimate()
        result = {}
        for device in self.device_wake:
            running = self.device_running.get(device)
            recent = sorted(
                (j for j in self.jobs.values() if j.device == device and j.status in FINISHED_STATUSES),
                key=lambda j: j.finished_at or 0,
                reverse=True,
            )[:RECENT_PER_DEVICE]
            result[device] = {
                "running": running.summary() if running else None,
                "queued": [j.summary() for j in self._pending(device)],
                "recent": [j.summary() for j in recent],
                "eta_seconds": free_at.get(device),
            }
        return result

    def pool_size(self) -> int:
        return sum(1 for j in self.batch_pool if j.status == "queued")

    def _pending(self, device: int) -> list[Job]:
        return [j for j in self.device_pending.get(device, []) if j.status == "queued"]

    def _estimate(self) -> tuple[dict[int, float | None], dict[str, float | None]]:
        """Rough simulation of the queues: when each device runs dry, and when each
        batch's last file is done (seconds from now; None = no basis for a guess).

        A job's duration is guessed from finished jobs on the same device, else on
        any device, else the running job's own projected total. Pooled batch jobs
        are handed, one by one, to whichever allowed device would finish them first
        — the same thing the workers do for real. Files differ in length, so this is
        only ever a ballpark figure."""
        overall_avg = self._avg_duration(None)
        free_at: dict[int, float | None] = {}
        typical: dict[int, float | None] = {}
        batch_done: dict[str, float | None] = {}

        for device in self.device_wake:
            running = self.device_running.get(device)
            queued = self._pending(device)
            t = self._avg_duration(device) or overall_avg
            left = 0.0
            if running:
                left = parse_hms(running.remaining)
                elapsed = parse_hms(running.elapsed)
                if t is None and left is not None and elapsed is not None:
                    t = elapsed + left
                if left is None:
                    left = t  # just started, no progress line yet — assume a typical run
                if running.batch_id:
                    prev = batch_done.get(running.batch_id, 0.0)
                    batch_done[running.batch_id] = None if left is None or prev is None else max(prev, left)
            typical[device] = t
            if left is None or (queued and t is None):
                free_at[device] = None
            else:
                free_at[device] = left + len(queued) * (t or 0.0)

        for job in self.batch_pool:
            if job.status != "queued":
                continue
            candidates = [
                d for d in job.allowed_devices if free_at.get(d) is not None and typical.get(d) is not None
            ]
            if not candidates:
                batch_done[job.batch_id] = None
                for d in job.allowed_devices:
                    free_at[d] = None
                continue
            d = min(candidates, key=lambda d: free_at[d] + typical[d])
            free_at[d] += typical[d]
            prev = batch_done.get(job.batch_id, 0.0)
            batch_done[job.batch_id] = None if prev is None else max(prev, free_at[d])

        return free_at, batch_done

    def _avg_duration(self, device: int | None) -> float | None:
        durations = [
            j.finished_at - j.started_at
            for j in self.jobs.values()
            if j.status == "done" and j.started_at and j.finished_at and (device is None or j.device == device)
        ]
        return sum(durations) / len(durations) if durations else None

    def overall_eta(self) -> float | None:
        """Seconds until every device has run dry — devices work in parallel, so the slowest decides."""
        free_at, _ = self._estimate()
        busy = [free_at[d] for d in free_at if self.device_running.get(d) or self._pending(d)]
        if not busy and self.pool_size():
            return None  # pool waiting but no worker busy: only for an instant, or its devices are gone
        return None if None in busy else max(busy, default=0.0)

    def batch_status(self) -> list[dict]:
        """One entry per batch still in the job history, newest first."""
        _, batch_done = self._estimate()
        batches: dict[str, dict] = {}
        for job in self.jobs.values():
            if not job.batch_id:
                continue
            b = batches.setdefault(
                job.batch_id,
                {
                    "id": job.batch_id,
                    "name": job.batch_name,
                    "created_at": job.created_at,
                    "total": 0,
                    "progress_sum": 0.0,
                    "devices": sorted(job.allowed_devices),
                    **{s: 0 for s in ("queued", "running", "done", "error", "cancelled")},
                },
            )
            b["total"] += 1
            b[job.status] += 1
            # finished jobs count as a full 100% of their share, whatever the outcome
            b["progress_sum"] += 100.0 if job.status in FINISHED_STATUSES else job.progress
        waiting: dict[str, list[dict]] = {}
        for job in self.batch_pool:
            if job.status == "queued":
                waiting.setdefault(job.batch_id, []).append({"id": job.id, "input_path": job.input_path})
        result = []
        for b in sorted(batches.values(), key=lambda b: -b["created_at"]):
            b["progress"] = b.pop("progress_sum") / b["total"]
            b["waiting"] = waiting.get(b["id"], [])  # pool order = the order GPUs will take them
            active = b["queued"] + b["running"]
            b["eta_seconds"] = batch_done.get(b["id"]) if active else 0.0
            result.append(b)
        return result

    async def cancel_many(self, job_ids: list[str]) -> int:
        """Cancel every still-active job in the list. Returns how many were cancelled."""
        count = 0
        for job_id in job_ids:
            if await self.cancel(job_id):
                count += 1
        return count

    def active_job_ids(self, device: int | None = None, batch_id: str | None = None) -> list[str]:
        return [
            j.id
            for j in self.jobs.values()
            if j.status in ("running", "queued")
            and (device is None or j.device == device)
            and (batch_id is None or j.batch_id == batch_id)
        ]

    def _pin_device(self, job: Job, device_idx: int):
        job.device = device_idx
        if "-d" in job.args:
            job.args[job.args.index("-d") + 1] = str(device_idx)

    async def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job or job.status not in ("running", "queued"):
            return False
        job.status = "cancelled"
        if job.process:
            # _run() broadcasts the final state once the process has exited
            job.process.terminate()
        else:
            # still waiting in a queue — nothing else will ever announce the change
            job.finished_at = time.time()
            await job._broadcast()
        if job.device is not None:
            pending = self.device_pending.get(job.device)
            if pending and job in pending:
                pending.remove(job)
        if job in self.batch_pool:
            self.batch_pool.remove(job)
        return True

    async def _run(self, job: Job):
        job.status = "running"
        job.started_at = time.time()
        log_path = self._log_path(job)
        if log_path:
            try:
                job.log_file = open(log_path, "w")
                job.log_path = str(log_path)
                job.log_file.write(
                    f"job {job.id}\n"
                    f"input: {job.input_path}\n"
                    f"output: {job.output_path}\n"
                    f"device: {job.device}\n"
                    f"args: {' '.join(job.args)}\n"
                    f"{'-' * 60}\n"
                )
                job.log_file.flush()
            except OSError as exc:
                # don't fail the job over it, but make it visible instead of silently losing the log
                job.log_file = None
                logger.warning("cannot write job log %s: %s", log_path, exc)
                job._append_log(f"[warning] could not write the log file {log_path}: {exc}")
        try:
            process = await asyncio.create_subprocess_exec(
                self.video2x_bin,
                *job.args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except FileNotFoundError:
            job.status = "error"
            job.finished_at = time.time()
            job._append_log("error: video2x binary not found")
            await job._broadcast()
            if job.log_file:
                job.log_file.close()
                job.log_file = None
            return

        job.process = process
        if job.status == "cancelled":
            # cancelled while the process was being spawned (cancel() saw no process yet)
            process.terminate()
        await job._broadcast()  # announce "running" right away
        last_broadcast = time.monotonic()
        buf = b""
        assert process.stdout is not None
        while True:
            chunk = await process.stdout.read(4096)
            if not chunk:
                break
            buf += chunk
            # video2x writes progress updates using carriage returns; split on both \r and \n
            while True:
                idx_r = buf.find(b"\r")
                idx_n = buf.find(b"\n")
                candidates = [i for i in (idx_r, idx_n) if i != -1]
                if not candidates:
                    break
                idx = min(candidates)
                raw_line = buf[:idx]
                buf = buf[idx + 1 :]
                line = raw_line.decode("utf-8", errors="replace").replace("\x1b[K", "").strip()
                if not line:
                    continue
                self._handle_line(job, line)
            now = time.monotonic()
            if now - last_broadcast >= BROADCAST_INTERVAL:
                await job._broadcast()
                last_broadcast = now

        if buf:
            line = buf.decode("utf-8", errors="replace").replace("\x1b[K", "").strip()
            if line:
                self._handle_line(job, line)

        returncode = await process.wait()
        job.returncode = returncode
        job.finished_at = time.time()
        job.log_dirty = True  # final push always carries the full log tail
        if job.status == "cancelled":
            pass
        elif returncode == 0:
            job.status = "done"
            job.progress = 100.0
            if job.move_input_to:
                self._move_input(job)
        else:
            job.status = "error"
            self._append_hint(job)
        if job.log_file:
            job.log_file.write(f"{'-' * 60}\nfinal status: {job.status} (returncode {job.returncode})\n")
            job.log_file.close()
            job.log_file = None
        await job._broadcast()

    def _move_input(self, job: Job):
        """Move a finished batch input into its done/ folder (never overwriting)."""
        src = Path(job.args[job.args.index("-i") + 1])
        dest_dir = Path(job.move_input_to)
        try:
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / src.name
            n = 2
            while dest.exists():
                dest = dest_dir / f"{src.stem} ({n}){src.suffix}"
                n += 1
            shutil.move(src, dest)
            job._append_log(f"[info] moved input to {dest}")
        except OSError as exc:
            job._append_log(f"[warning] could not move input to {dest_dir}: {exc}")

    def _append_hint(self, job: Job):
        for pattern, tip in ERROR_HINTS:
            if any(pattern.search(line) for line in job.log):
                job._append_log(f"[hint] {tip}")
                return
        # fallback: unmatched failure with hwaccel set to something other than "none"
        if "-a" in job.args:
            hwaccel = job.args[job.args.index("-a") + 1]
            if hwaccel != "none":
                job._append_log(
                    f"[hint] tip: hwaccel={hwaccel} is unstable in video2x itself (upstream-confirmed, "
                    "not fixable from this image) and commonly fails outright — try setting hwaccel "
                    "back to \"none\"."
                )

    def _handle_line(self, job: Job, line: str):
        m = PROGRESS_RE.search(line)
        if m:
            job.frame = int(m.group(1))
            job.total_frames = int(m.group(2))
            job.progress = float(m.group(3))
            job.fps = m.group(4)
            job.elapsed = m.group(5)
            job.remaining = m.group(6)
            return
        job._append_log(line)
