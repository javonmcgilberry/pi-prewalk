#!/bin/sh
set -eu

segment=${AR_SEGMENT:-context}
case "$segment" in
  context)
    npm test -- --run test/executor/executor-context.test.ts
    ;;
  admission)
    npm test -- --run test/orchestration/admission.test.ts
    ;;
  composition)
    npm test -- --run test/integration/autoresearch-composition.test.ts
    ;;
  *)
    echo "unknown AR_SEGMENT: $segment" >&2
    exit 2
    ;;
esac
npm run typecheck
