Assess whether substantial implementation work remains for the current request.

You may perform only bounded read-only inspection. Do not mutate files, initialize
or use todos, run tests, launch subagents, install dependencies, change models,
or begin implementation. When you have enough evidence, call `prewalk_assess`
exactly once with `continue` only if substantial implementation remains, otherwise
call it with `bypass`. A completed approved plan and a small sufficient action
both require `bypass`.
