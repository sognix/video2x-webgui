# Changelog

All notable changes to this project. Versions follow [Semantic Versioning](https://semver.org/);
each release also names the Video2X version its image was built with.

## [Unreleased]

## [v1.0.0] — first public release

Built with Video2X 6.4.0.

- Web UI for every Video2X CLI option (Real-ESRGAN, Real-CUGAN, libplacebo/Anime4K, RIFE),
  offering only model/scale/noise combinations that work.
- Single files and batch folders; batch outputs mirror the input folder, finished inputs
  move to `done/`.
- One queue per GPU plus a shared batch pool: whichever selected GPU is free takes the
  next batch file.
- Status tab with per-GPU and per-batch progress, time estimates, cancel per job / GPU /
  batch, running/waiting counts in the page title and browser notifications.
- Preview clips rendered with the current settings and played in the browser.
- Video info (resolution, frame rate, duration, output size) via ffprobe.
- Logs tab to read and delete the per-job log files.
