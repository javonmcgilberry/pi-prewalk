#!/bin/sh
set -eu

segment=${AR_SEGMENT:-context}
case "$segment" in
  context)
    if [ "${AR_CONTEXT_MODE:-}" = margin ]; then
      : "${AR_CONTEXT_SPLIT:?AR_CONTEXT_SPLIT is required for margin mode}"
      : "${AR_CONTEXT_MARGIN:?AR_CONTEXT_MARGIN is required for margin mode}"
      node --experimental-strip-types .auto/score-context-margin.mjs \
        --split="$AR_CONTEXT_SPLIT" --margin="$AR_CONTEXT_MARGIN"
    else
      node --experimental-strip-types .auto/score-context.mjs --split=optimization
      node --experimental-strip-types .auto/score-context.mjs --split=holdout \
        | sed 's/^METRIC /METRIC holdout_/'
    fi
    ;;
  admission)
    if [ "${AR_ADMISSION_MODE:-}" = robustness ]; then
      : "${AR_ADMISSION_SPLIT:?AR_ADMISSION_SPLIT is required for robustness mode}"
      node --experimental-strip-types .auto/score-admission-robustness.mjs \
        --split="$AR_ADMISSION_SPLIT"
    else
      node --experimental-strip-types .auto/score-admission.mjs --split=optimization
      node --experimental-strip-types .auto/score-admission.mjs --split=holdout \
        | sed 's/^METRIC /METRIC holdout_/'
    fi
    ;;
  composition)
    node .auto/score-composition.mjs
    ;;
  *)
    echo "unknown AR_SEGMENT: $segment" >&2
    exit 2
    ;;
esac
