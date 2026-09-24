# HTTP API

The web UI is a thin client over this API; everything it does can be scripted too.
There is no authentication (see the security note in the README).

- `GET /api/meta/processors` — processor + field definitions (including which model/scale/noise combos are valid)
- `GET /api/meta/options` — hwaccel / log-level / encoder-preset choices, plus the hwaccel warning text
- `GET /api/meta/devices` — Vulkan devices from `video2x --list-devices` (probed once and cached; `?refresh=true` probes again)
- `GET /api/queues` — `{devices, batches, summary}`: per device the running job, its own waiting jobs, recently finished jobs and an ETA; per batch the counts, progress and ETA; overall totals incl. the batch pool size
- `POST /api/devices/{i}/cancel` — cancel the running job and the waiting single jobs of one device
- `POST /api/batches/{id}/cancel` — cancel every unfinished job of one batch
- `GET /api/probe?root=videos|batch&path=` — ffprobe info for one file, or for every video file in a folder
- `POST /api/clips` — render a preview clip (`root`, `input_path`, `start`, `duration` + the usual processing options); `GET /api/clips/{job id}` serves the finished `.mp4`
- `GET /api/logs`, `GET/DELETE /api/logs/{name}`, `DELETE /api/logs` — list / read / delete job log files
- `GET/POST/DELETE /api/files?root=videos|batch` — browse/upload/delete under `/videos` or `/batch`
- `POST /api/jobs` — queue a single job onto its `device`'s queue, returns job id (409 if the output exists; resend with `overwrite: true`)
- `POST /api/batch/jobs` — queue a batch: every file directly inside `input_dir` (relative to `/batch`) gets the same processor/encoder settings, output goes to `/videos/output/<name>.<output_ext>`; `devices: [i, ...]` picks which Vulkan device(s) may pull files from the batch pool (empty/omitted = every detected non-CPU device); non-video files are skipped, 409 if outputs exist (resend with `overwrite: true`); outputs land in `/videos/output/<batch folder>/`, and `move_done` (default true) moves each successful input into `<input_dir>/done/`
- `GET /api/jobs`, `GET /api/jobs/{id}` — job list / detail incl. log (includes which `device` index a job is queued/running on)
- `POST /api/jobs/{id}/cancel` — works on running or still-queued jobs
- `WS /ws/jobs/{id}` — live progress

Job state is in-memory only (resets on container restart); output files on `/videos` persist regardless.
