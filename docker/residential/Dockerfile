# Deployment layer over the already-built release image. No application code changes.
# Pin BASE_IMAGE to the verified commit-tagged image before building from the idle slot.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
# Private CLI storage permits only root/current-UID ancestry. The standalone
# application tree is read-only at runtime; its top-level owner must not be a
# foreign image-build UID when the residential launcher selects UID 10001.
RUN --network=none chown 0:0 /app
USER 10001:10001
RUN --network=none node /opt/omniroute-docker-build/verify-docker-clis.mjs
