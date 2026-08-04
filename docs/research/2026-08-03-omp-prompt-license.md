# OMP prompt licensing check

> This is a technical licensing review, not legal advice.

## Conclusion

The official project is [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), licensed under the MIT License. Prewalk's three active handoff prompts are copied verbatim, not merely adapted or independently expressed, from OMP commit [`f559e7e9dc1e8818d5d8e15ace28da3d42f2457d`](https://github.com/can1357/oh-my-pi/commit/f559e7e9dc1e8818d5d8e15ace28da3d42f2457d):

- [`prompts/prewalk-plan.md`](../../prompts/prewalk-plan.md) matches [OMP `prewalk-plan.md`](https://github.com/can1357/oh-my-pi/blob/f559e7e9dc1e8818d5d8e15ace28da3d42f2457d/packages/coding-agent/src/prompts/system/prewalk-plan.md), SHA-256 `0a7442a41c2d8554f0683ac947323bc8a20d2cd6ebda049a9d9df323f2471a78`.
- [`prompts/prewalk-continue.md`](../../prompts/prewalk-continue.md) matches [OMP `prewalk-continue.md`](https://github.com/can1357/oh-my-pi/blob/f559e7e9dc1e8818d5d8e15ace28da3d42f2457d/packages/coding-agent/src/prompts/system/prewalk-continue.md), SHA-256 `9af48cebe3490c679a6670968b8d59ed418d4a9a374a8d99f9be1165c93478f0`.
- [`prompts/prewalk-checklist.md`](../../prompts/prewalk-checklist.md) matches [OMP `prewalk-checklist.md`](https://github.com/can1357/oh-my-pi/blob/f559e7e9dc1e8818d5d8e15ace28da3d42f2457d/packages/coding-agent/src/prompts/system/prewalk-checklist.md), SHA-256 `045383ef934fe8afc7b0c13ad647caf9ad0aed4d6f1af594657a968aabe660d1`.

The other local prompt assets, including `prewalk-assess.md` and `todo.md`, are not identified or hash-pinned as OMP copies. The coordinator is described in the README as a stock-Pi public-API adaptation rather than copied OMP source.

## MIT obligation and current state

[OMP's pinned MIT license](https://github.com/can1357/oh-my-pi/blob/f559e7e9dc1e8818d5d8e15ace28da3d42f2457d/LICENSE) permits copying, modification, publication, distribution, sublicensing, and sale. Its condition is that the copyright notice and permission notice be included in all copies or substantial portions of the software. Shipping these exact prompt copies should therefore carry that notice. Renaming Prewalk does not change this obligation.

The current repository already includes a [`LICENSE`](../../LICENSE) that is byte-for-byte identical to OMP's pinned MIT license, including:

- `Copyright (c) 2025 Mario Zechner`
- `Copyright (c) 2025-2026 Can Bölük`
- the complete MIT permission and warranty text

The package's `files` allowlist includes `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `prompts`, so the configured package artifact keeps the notice with the copied prompts. The public GitHub repository also contains that full license. On that evidence, repository and configured package distribution preserve the required upstream notice.

[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) records the exact source revision, paths, and prompt hashes, which is useful provenance. Its short `Copyright Oh My Pi contributors` line and license hyperlink do not reproduce OMP's exact copyright and permission notice, so it should not be the only notice shipped. If any installer, bundle, or copied prompt directory omits the root `LICENSE`, include OMP's full pinned MIT notice in that artifact instead of relying on a link.

## Practical recommendation

Keep the full OMP MIT text and the pinned provenance notice in every distributed form that contains the three prompts. If Prewalk needs a distinct copyright statement for its original code, add the local owner's notice without removing Mario Zechner's and Can Bölük's notices, or separate the project license from a complete OMP third-party license. The present root license contains only the upstream copyright holders, so clarifying local ownership would improve provenance even though it is separate from satisfying OMP's condition.

