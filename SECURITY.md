# Security

## Scope

The web UI has **no authentication by design** — it is meant for a trusted home
network, or to sit behind a reverse proxy that handles login. "Anyone on the network
can start jobs" is therefore expected behavior, not a vulnerability.

Things that *are* worth reporting, for example:

- reading, writing or deleting files outside `/videos`, `/batch`, `/logs` and the
  temporary clip folder (path traversal);
- running arbitrary commands through job parameters (command injection);
- anything that lets a web page on another site act on the UI (CSRF/XSS).

Problems in Video2X itself, FFmpeg or the linuxserver.io base image should go to
those projects.

## Reporting

Please report vulnerabilities **privately** via GitHub's
[private vulnerability reporting](https://github.com/sognix/video2x-webgui/security/advisories/new)
rather than a public issue. Include what you found, how to reproduce it and which
image tag you used.

This is a hobby project, so there is no guaranteed response time. Fixed issues are
credited in the release notes unless you prefer otherwise.
