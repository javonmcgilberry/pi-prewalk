Use the prewalk_todo tool to maintain Prewalk's phased implementation and verification plan.

- `init` replaces the list with one or more named phases.
- `start` makes one task current.
- `done`, `drop`, `block`, and `unblock` update a task or phase.
- `append` adds tasks to a named phase.
- `rm` removes a task, a phase's tasks, or the entire list.
- `view` returns the current snapshot without changing it.

Refer to tasks by their exact content. Keep one task in progress, update the list when reality changes, and finish or explicitly abandon every remaining item before ending the task.
