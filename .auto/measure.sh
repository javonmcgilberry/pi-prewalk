#!/bin/sh
set -eu

segment=${AR_SEGMENT:-context}
case "$segment" in
  context)
    node --experimental-strip-types .auto/score-context.mjs --split=optimization
    node --experimental-strip-types .auto/score-context.mjs --split=holdout \
      | sed 's/^METRIC /METRIC holdout_/'
    ;;
  admission)
    node --experimental-strip-types .auto/score-admission.mjs --split=optimization
    node --experimental-strip-types .auto/score-admission.mjs --split=holdout \
      | sed 's/^METRIC /METRIC holdout_/'
    ;;
  composition)
    node .auto/score-composition.mjs
    ;;
  *)
    echo "unknown AR_SEGMENT: $segment" >&2
    exit 2
    ;;
esac
