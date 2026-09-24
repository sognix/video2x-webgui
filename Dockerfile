# syntax=docker/dockerfile:1
# Copyright (C) 2026 sognix
# SPDX-License-Identifier: AGPL-3.0-or-later

FROM ghcr.io/linuxserver/baseimage-selkies:ubuntunoble

# set version label
ARG BUILD_DATE
ARG VERSION
ARG VIDEO2X_VERSION
LABEL build_version="Linuxserver.io-style version:- ${VERSION} Build-date:- ${BUILD_DATE}"
LABEL maintainer="sognix"
LABEL project="video2x-webGUI"
# Only meaningful when VIDEO2X_VERSION is passed explicitly (e.g. by CI, which always
# resolves it up front) — a plain local `docker build .` leaves this blank since the
# fallback-to-latest resolution below happens inside a RUN step, after LABEL is fixed.
LABEL video2x.version="${VIDEO2X_VERSION}"

RUN \
  echo "**** install ffmpeg/ffprobe (preview clips, video info) ****" && \
  apt-get update && \
  apt-get install -y --no-install-recommends ffmpeg && \
  echo "**** install video2x ****" && \
  if [ -z ${VIDEO2X_VERSION+x} ]; then \
    VIDEO2X_VERSION=$(curl -sX GET "https://api.github.com/repos/k4yt3x/video2x/releases/latest" \
      | awk '/tag_name/{print $4;exit}' FS='[""]'); \
  fi && \
  mkdir -p /tmp/video2x && \
  curl -o \
    /tmp/video2x/Video2X.AppImage -L \
    "https://github.com/k4yt3x/video2x/releases/download/${VIDEO2X_VERSION}/Video2X-x86_64.AppImage" && \
  chmod +x /tmp/video2x/Video2X.AppImage && \
  cd /tmp/video2x && \
  ./Video2X.AppImage --appimage-extract && \
  rm -rf squashfs-root/usr/share/doc squashfs-root/usr/share/man && \
  cp -a squashfs-root/usr/. /usr/ && \
  ldconfig && \
  echo "**** disable unused desktop-streaming services ****" && \
  rm -f \
    /etc/s6-overlay/s6-rc.d/user/contents.d/svc-selkies \
    /etc/s6-overlay/s6-rc.d/user/contents.d/svc-xorg \
    /etc/s6-overlay/s6-rc.d/user/contents.d/svc-de \
    /etc/s6-overlay/s6-rc.d/user/contents.d/svc-pulseaudio \
    /etc/s6-overlay/s6-rc.d/user/contents.d/svc-xsettingsd \
    /etc/s6-overlay/s6-rc.d/user/contents.d/svc-dbus \
    /etc/s6-overlay/s6-rc.d/user/contents.d/svc-docker && \
  echo "**** cleanup ****" && \
  rm -rf \
    /tmp/video2x \
    /var/lib/apt/lists/* \
    /tmp/*

# add web app and local files
COPY /app /app
RUN \
  echo "**** install web app dependencies ****" && \
  python3 -m venv /app/venv && \
  /app/venv/bin/pip install --no-cache-dir -r /app/backend/requirements.txt && \
  mkdir -p /videos/input /videos/output /batch /logs && \
  echo "**** stamp frontend asset URLs with a content hash (cache busting) ****" && \
  ASSET_VERSION="$(cat /app/frontend/app.js /app/frontend/style.css | sha256sum | cut -c1-12)" && \
  sed -i "s/__ASSET_VERSION__/${ASSET_VERSION}/g" /app/frontend/index.html && \
  chown -R abc:abc /app /videos /batch /logs

COPY /root /
RUN chmod +x \
  /etc/s6-overlay/s6-rc.d/init-nginx/run \
  /etc/s6-overlay/s6-rc.d/init-video2x-config/run \
  /etc/s6-overlay/s6-rc.d/svc-video2x-web/run

# linked in the page footer (AGPL-3.0 §13) — override with -e SOURCE_URL=... in a fork
ENV SOURCE_URL="https://github.com/sognix/video2x-webgui"

# ports and volumes
EXPOSE 3000 3001
VOLUME /config /videos /batch /logs
