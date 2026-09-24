# Third-party notices

This project (`video2x-webGUI`) is a Docker image and web front end that installs and
drives [Video2X](https://github.com/k4yt3x/video2x) — it does not bundle Video2X's
source itself, but downloads and includes an official prebuilt release (see the
`VIDEO2X_VERSION` build argument in the `Dockerfile` for the exact version used in a
given image) into the built image.

## Video2X

- **License:** GNU Affero General Public License v3.0 (AGPL-3.0)
- **Source:** https://github.com/k4yt3x/video2x
- **Copyright:** 2018–2024 K4YT3X and contributors

Because this image runs Video2X as a network-accessible service, the AGPL-3.0's
network-use clause (section 13) applies to it. Video2X's own complete corresponding
source for the version bundled in this image is publicly available, unmodified, at
the repository and release tag above.

## Components bundled inside Video2X itself

These are not modified or redistributed separately by this project — they ship inside
the official Video2X release binary this image installs. Listed per Video2X's own
[NOTICE](https://github.com/k4yt3x/video2x/blob/master/NOTICE) file:

| Component | License | Source |
|---|---|---|
| FFmpeg | GNU Lesser General Public License 2.1 | https://github.com/FFmpeg/FFmpeg |
| Anime4K | MIT License | https://github.com/bloc97/Anime4K |
| Real-ESRGAN ncnn Vulkan | MIT License | https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan |
| Real-CUGAN ncnn Vulkan | MIT License | https://github.com/nihui/realcugan-ncnn-vulkan |
| RIFE ncnn Vulkan | MIT License | https://github.com/nihui/rife-ncnn-vulkan |
| ncnn | BSD 3-Clause License | https://github.com/Tencent/ncnn |

## FFmpeg (Ubuntu package)

- **Used for:** preview clips and video info (`ffmpeg` / `ffprobe` in `/usr/bin`), run as
  separate programs — independent of the FFmpeg libraries bundled inside Video2X
- **Package:** `ffmpeg` from Ubuntu 24.04 "noble", installed with apt at image build time
- **License:** GNU General Public License v2.0 or later (Ubuntu's build enables GPL components)
- **Source:** Ubuntu keeps the source of every published package version available, e.g.
  `apt-get source ffmpeg` or https://launchpad.net/ubuntu/+source/ffmpeg

## Base image

- **Image:** `ghcr.io/linuxserver/baseimage-selkies`
- **Source:** https://github.com/linuxserver/docker-baseimage-selkies
- Provided by [LinuxServer.io](https://www.linuxserver.io/) (GPL-3.0); see that project's
  own repository for its licensing and third-party notices.

## Python packages (installed into the image at build time)

| Package | License | Source |
|---|---|---|
| FastAPI | MIT License | https://github.com/fastapi/fastapi |
| Uvicorn | BSD 3-Clause License | https://github.com/encode/uvicorn |
| python-multipart | Apache License 2.0 | https://github.com/Kludex/python-multipart |

## Logo

`app/frontend/favicon.png` is derived from the Video2X application icon
[`packaging/appimage/video2x.png`](https://github.com/k4yt3x/video2x/blob/master/packaging/appimage/video2x.png)
by K4YT3X, part of the Video2X repository and therefore under its AGPL-3.0 license:
the "V" and "2X" lettering, style and colors are from the original; the "webGUI"
lettering was added for this project. The modified logo is likewise AGPL-3.0. It is
used to identify this as a front end for Video2X — not to suggest it is an official
part of it.

## Distributing the built image

This repository contains only source code; the third-party binaries above are
downloaded or installed while the image is built. If you publish a built image, you
distribute those binaries too: keep this notice with it. The corresponding sources stay
available upstream — Video2X at its release tags on GitHub, FFmpeg and the other Ubuntu
packages in Ubuntu's archive — which is what the AGPL-3.0 / GPL require.
