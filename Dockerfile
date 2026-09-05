# Sandbox image for the enyl-research agent: adds the Python and
# LibreOffice toolchain the SpreadsheetBench evaluator relies on
# (openpyxl, pandas, and a headless soffice for formula recalculation)
# on top of eve's own base image.
#
# Build: docker build -t enyl-sandbox:local .
#
# The tag pins the eve version this project uses (see package-lock.json).
# Bump it only when the pinned eve dependency changes.
FROM ghcr.io/vercel/eve:0.52.1

USER root

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-openpyxl \
        python3-pandas \
        libreoffice-calc \
        fonts-dejavu \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

USER vercel-sandbox
