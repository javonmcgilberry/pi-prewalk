# syntax=docker/dockerfile:1.7

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

COPY scripts/benchmark-worker.mjs /opt/prewalk-worker/bridge.mjs
COPY scripts/benchmark-evaluator.mjs /opt/prewalk-worker/evaluator.mjs

ARG TASK_SOURCE
COPY ${TASK_SOURCE}/ /opt/task-base/

ARG TASK_ID
ARG TASK_REPOSITORY
ARG TASK_REVISION
ARG TASK_SOURCE_DIGEST
ARG IMAGE_ROLE
LABEL dev.prewalk.benchmark.task-id="${TASK_ID}" \
      dev.prewalk.benchmark.repository="${TASK_REPOSITORY}" \
      dev.prewalk.benchmark.revision="${TASK_REVISION}" \
      dev.prewalk.benchmark.source-digest="${TASK_SOURCE_DIGEST}" \
      dev.prewalk.benchmark.image-role="${IMAGE_ROLE}"

RUN chown -R 65532:65532 /opt/prewalk-worker /opt/task-base \
    && chmod -R u=rwX,go=rX /opt/prewalk-worker /opt/task-base

USER 65532:65532
WORKDIR /workspace
CMD ["node", "-e", "setInterval(() => {}, 2147483647)"]
