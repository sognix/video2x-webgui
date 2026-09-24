# Contributing

Thanks for wanting to help! Bug reports, fixes and small improvements are welcome.
For bigger changes, please open an issue first so we can agree on the approach before
you put work into it.

## How the project is laid out

- `app/backend/` — FastAPI backend: runs the `video2x` CLI, queues jobs per GPU,
  serves the API (`main.py`, `jobs.py`, `catalog.py`).
- `app/frontend/` — plain HTML/CSS/JavaScript, no build step, no frameworks.
- `root/` — s6-overlay services and the nginx config copied into the image.
- `Dockerfile` — the image; `.github/workflows/build.yml` builds and tests it.
- `docs/architecture.md` explains how queueing, preview clips and logs work.

## Building and running

The easiest way is the full image:

```bash
docker build -t video2x-webgui:dev .
docker run --rm --gpus all -p 3000:3000 -v "$PWD/test-media:/videos" video2x-webgui:dev
```

Without an NVIDIA GPU leave out `--gpus all`; Video2X then runs on the software
renderer (`llvmpipe`) — very slow, but good enough to test the UI with a short clip.

For quick backend/frontend iterations without rebuilding the image, run the backend
directly (Python 3.12+, `ffmpeg`/`ffprobe` and `video2x` on your `PATH`):

```bash
python3 -m venv .venv && .venv/bin/pip install -r app/backend/requirements.txt
cd app/backend
VIDEOS_ROOT=/tmp/v2x/videos BATCH_ROOT=/tmp/v2x/batch LOG_ROOT=/tmp/v2x/logs \
  ../../.venv/bin/uvicorn main:app --port 8000
```

In the image nginx serves `app/frontend` and proxies `/api/` and `/ws/` to the backend;
locally you can mount the frontend into the app instead, e.g. with a small wrapper that
adds `app.mount("/", StaticFiles(directory="../frontend", html=True))`.

## Code style

- Match the surrounding code: naming, comment density, no new dependencies unless
  there's a real need (the frontend deliberately has none).
- Keep the UI usable on a phone (≈ 390 px wide) and in light and dark mode.
- Every source file starts with the copyright/SPDX header — keep it in new files.

## Pull requests

- One topic per pull request, with a short description of what and why.
- The GitHub workflow builds the image and runs a smoke test on every pull request;
  it has to pass.
- If you changed something visible, a screenshot in the PR helps a lot.
- Say which GPU(s) you tested on — CI has none.

## License of contributions

This project is licensed under AGPL-3.0-or-later. By submitting a pull request you
agree that your contribution is licensed under the same terms.
