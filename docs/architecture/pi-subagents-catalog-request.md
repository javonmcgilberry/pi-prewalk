# Proposed pi-subagents agent catalog seam

This is a future integration request, not a Prewalk runtime dependency. The
current Prewalk implementation deliberately keeps child names manual.

## The user problem

An extension such as Prewalk can observe that pi-subagents is loaded, but it
cannot currently ask pi-subagents which agents are actually available in the
current project and session. That leaves a user copying an exact `name` from
an agent file into another configuration screen. The result is easy to mistype
and can become stale when project settings, package agents, aliases, disabled
agents, or capability restrictions change.

Prewalk should not solve this by scanning pi-subagents files or importing its
private discovery modules. That would duplicate pi-subagents' precedence and
security rules.

## The small request

Add one read-only `agents` method to pi-subagents' existing versioned in-process
RPC. It would let another loaded extension ask for the effective, launchable
agent catalog for the active working directory:

```ts
{
  version: 1,
  requestId: "...",
  method: "agents",
  params: { agentScope: "both" }
}
```

The reply can stay intentionally small and omit prompts, file paths, models,
and internal IDs:

```ts
{
  version: 1,
  requestId: "...",
  method: "agents",
  success: true,
  data: {
    version: 1,
    scope: "both",
    agents: [
      {
        name: "worker",
        description: "Implementation work",
        source: "builtin",
        aliases: ["implementer"],
        executable: true
      }
    ],
    total: 1,
    omitted: 0
  }
}
```

`ping` could advertise `capabilities.agentCatalog: { version: 1 }`, and the
method list would include `agents`. The implementation can reuse the same
effective discovery, override, disabled-agent, and capability-ceiling logic
already used by the package's own list action. The result should be bounded
and display-safe.

## Why this benefits pi-subagents users

- **Less duplicated configuration:** compatible extensions can show the
  agents the user already configured instead of asking them to type names.
- **Correctness stays with pi-subagents:** aliases, package/project
  precedence, disabled agents, and capability ceilings continue to mean what
  they mean in pi-subagents.
- **No launcher change:** spawning, prompts, tools, models, and child safety
  remain entirely pi-subagents-owned.
- **Useful beyond Prewalk:** dashboards, status integrations, and other Pi
  extensions can present the same effective catalog without scraping output.
- **Safe read-only boundary:** asking for the catalog does not start a child,
  mutate settings, expose a system prompt, or reveal private run identifiers.

The request is deliberately narrower than a general provider framework. It
only exposes information pi-subagents already resolves for itself; it does not
ask pi-subagents to adopt Prewalk's policy or to coordinate another extension's
lifecycle.

## Prewalk's current behavior

Until this seam exists, Prewalk keeps `children.agents` as a manually
maintained, off-by-default policy map. The launcher owns the child name and
child loading; Prewalk only decides whether a matching child may run its own
Prewalk lifecycle and which executor it uses.

For convenience, Prewalk mirrors pi-subagents' six standard built-in names in
its manual menu (`scout`, `researcher`, `worker`, `reviewer`, `oracle`, and
`delegate`). That is a starter list, not a claim that those agents are
installed or executable; custom names remain supported.
