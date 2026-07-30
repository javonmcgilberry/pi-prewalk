# Prewalk directional benchmark

This benchmark is an opt-in efficacy study, not a routine test or a release
gate. The analysis policy,
tool slate, model settings, Pi and conversion versions, sandbox limits, prompt
digests, and comparison targets in `corpus.json` are frozen. The corpus remains
unfrozen and empty until at least 20 public coding tasks independently pass
prompt review, baseline review, gold-patch tests, and environment reproduction.
The runner refuses provider work until that curation is complete.

The first study follows OMP's practical experiment shape: one attempt for each
of Sol-only, Luna-only, and Prewalk on every task. With 20 tasks, that is 60
provider runs. It is directional evidence. One changed task moves an arm's pass
rate by 5 percentage points, so this study cannot establish a precise quality
gap or run-to-run reliability.

Each accepted task records a public repository, immutable base revision, prompt,
source-tree digest, fixed test command, timeout, validation evidence, and
distinct digest-pinned worker and evaluator images. The task-specific worker
image contains only the public base
snapshot, toolchain, dependencies, and worker bridge. The evaluator image is
separate and may contain the hidden test oracle, but neither image contains a
gold patch or solution object.

`task-image.Dockerfile` is the reviewed image template. Build it with a
digest-pinned `BASE_IMAGE` that already contains Node, Git, certificates, and
the task toolchain, plus a curated task source directory inside the Docker build
context. Record the resulting immutable image digest in the task entry. Worker
and evaluator images must be built and audited separately.

## Isolation contract

The trusted host controller owns the OpenAI Codex credential and Pi provider
calls. It creates a disposable worker with no network, no host mounts, a
read-only root filesystem, empty capabilities, a non-root user, bounded CPU,
memory, process count, wall time, and tmpfs storage. The worker copies its baked
snapshot into `/workspace`, removes any prior Git state, and creates exactly one
root commit with no remotes, reflogs, alternates, credential helpers, or
unreachable objects.

The benchmark extension registers `exec_command`, `write_stdin`, and
`apply_patch` before conversion loads, so Pi's supported first-registration rule
keeps all repository work inside the worker. A final extension freezes the
active slate to those three tools plus Prewalk's `todo` and verifies ownership
before every Agent turn.

After Pi settles or times out, the controller seals a binary candidate patch and
destroys the worker. Only then does it create the separate evaluator, forward
the patch through bounded JSON, and run the frozen test command. The evaluator
receives no provider credential, transcript, model identity, arm map, host
mount, or task-process network.

## Running the frozen study

After task curation, set `corpusFrozen` to `true` without changing the frozen
protocol or targets. Use an empty owner-only results directory and a
separate owner-only control directory. The control directory contains the
private arm map and must never be published with blinded evidence.

```sh
npm run benchmark -- \
  --manifest benchmark/corpus.json \
  --repetitions 1 \
  --confirm-provider-cost I_UNDERSTAND_AT_LEAST_60_PROVIDER_RUNS \
  --auth-file "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json" \
  --pi "$(command -v pi)" \
  --output-dir "$(pwd)/benchmark/results/study-v1" \
  --control-dir "/private/tmp/prewalk-study-v1-control"
```

The controller randomizes the three arms inside every task,
runs at least 60 provider attempts, retains failures and timeouts, seals raw
JSONL with a SHA-256 lock, and freezes task-clustered paired bootstrap metrics.
Raw results and frozen metrics contain opaque arm names only.

Unblind only after the raw lock and blinded metrics exist:

```sh
npm run benchmark:report -- \
  --manifest benchmark/corpus.json \
  --schedule benchmark/results/study-v1/blinded-schedule.json \
  --raw-results benchmark/results/study-v1/raw-results.jsonl \
  --lock benchmark/results/study-v1/raw-results.lock.json \
  --metrics benchmark/results/study-v1/blinded-metrics.json \
  --unblinding /private/tmp/prewalk-study-v1-control/unblinding.json \
  --output benchmark/results/study-v1/final-report.json
```

Exercise the real Docker worker bridge before the study with a digest-pinned
base image that already exists locally:

```sh
PREWALK_RUN_DOCKER_INTEGRATION=1 \
PREWALK_DOCKER_BASE_IMAGE="public.ecr.aws/docker/library/node@sha256:..." \
npx vitest run test/benchmark-docker.integration.test.ts
```

The report compares these frozen targets:

- Prewalk is within 5 percentage points of Sol's pass rate.
- Prewalk improves median provider cost or elapsed duration by at least 15%.
- Prewalk exceeds Luna's pass rate by at least 10 percentage points.
- The other cost or time metric regresses by no more than 5%.
- Prewalk's prohibited-lookup rate does not exceed Sol's.

These targets make the first result easy to compare with the product hypothesis,
but the report remains directional even when every target is met. Prohibited
lookups are an offline-sandbox diagnostic and must not be presented as
Stencil's web-search or cheating metric.

Escalate to three attempts per task and arm when Prewalk and Sol are within 10
percentage points, results are otherwise close or noisy, more than one run is
invalid or times out, or a public numeric claim will rely on the result. Use
five attempts only when three remain inconclusive. Repetition escalation should
use a separately frozen manifest and fresh output directories rather than
changing a completed study. The current runner accepts only the one-attempt
initial study, so a repeated follow-up also requires a reviewed protocol change
instead of a command-line override.

No benchmark result has been generated by installation or routine tests. The
current empty corpus blocks efficacy claims, but it does not block sharing the
verified extension as experimental.
