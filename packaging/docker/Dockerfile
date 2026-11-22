# Panda's Docker image, from the Linux release build (scripts/package-linux.sh): the build
# context holds linux-amd64/panda and linux-arm64/panda (the unpacked tarballs). The release
# workflow builds it for both and pushes it to ghcr.io.
#
#   docker run -d --name panda --network host \
#     -v panda-config:/config -v panda-cache:/cache -v /path/to/media:/media:ro \
#     ghcr.io/<owner>/panda
#
# /config keeps the settings, database and artwork (kept across image upgrades); /cache can be
# thrown away. Host networking lets TVs find the server (mDNS); otherwise publish -p 8096:8096.
# Hardware encoding: add --device /dev/dri (Intel/AMD) or --gpus all (NVIDIA).
FROM debian:bookworm-slim
ARG TARGETARCH

# VA-API drivers for hardware encoding (Intel's only exists for amd64).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libva2 libva-drm2 mesa-va-drivers \
    $(if [ "$TARGETARCH" = amd64 ]; then echo intel-media-va-driver; fi) \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --user-group --home-dir /config --no-create-home panda \
 && install -d -o panda -g panda /config /cache

COPY linux-${TARGETARCH}/panda/panda /usr/bin/panda
COPY linux-${TARGETARCH}/panda/ffmpeg/ /usr/lib/panda/ffmpeg/
COPY linux-${TARGETARCH}/panda/LICENSE linux-${TARGETARCH}/panda/NOTICE linux-${TARGETARCH}/panda/LEGAL.md /usr/share/doc/panda/

ENV PANDA_DATA_DIR=/config \
    PANDA_CACHE_DIR=/cache \
    PANDA_FFMPEG=/usr/lib/panda/ffmpeg/ffmpeg \
    PANDA_BIND=0.0.0.0:8096
USER panda
WORKDIR /config
VOLUME ["/config", "/cache"]
EXPOSE 8096
ENTRYPOINT ["/usr/bin/panda"]
