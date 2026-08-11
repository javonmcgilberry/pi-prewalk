# Prewalk stats dashboard UX research

## Decision

`/prewalk stats` should be an operational terminal dashboard first, with
historical analysis below it. The current session is the first question: what
is happening now, how much has it cost, and can the result be compared? Week,
month, and all-time history are secondary analysis.

The dashboard should use session titles as the primary identity. Stable IDs stay
available in the details view for debugging and exact lookup.

## What the current report gets wrong

- `Save $X` does not say that the value is an estimate rather than measured
  savings.
- `1 / 7` does not say that one of seven successful runs had enough evidence.
- `Prewalk primary` is an implementation label, not a user-facing description.
- `Not comparable` hides distinct causes such as missing pricing, incomplete
  usage, and unsuccessful runs.
- A flat all-time-first report mixes live monitoring with historical analysis.
- Full IDs make the user remember an identifier instead of recognizing a
  session title.

## Source-backed findings

### Current state belongs first

Nielsen Norman Group distinguishes operational dashboards, which support rapid
monitoring and action, from analytical dashboards, which support later
investigation. Its dashboard guidance says dashboards should communicate
important information quickly and with little cognitive processing.

- https://www.nngroup.com/articles/dashboards-preattentive/

Microsoft Power BI's first-party dashboard guidance recommends putting the
highest-priority information at the top and left, then adding detail in reading
order. It also recommends context around headline numbers rather than isolated
values.

- https://learn.microsoft.com/en-us/power-bi/create-reports/service-dashboards-design-tips

### User language beats implementation language

Nielsen Norman Group's heuristics call for language familiar to users rather
than internal jargon, visibility of system status, recognition rather than
recall, and minimalist presentation that protects relevant information from
being drowned out.

- https://www.nngroup.com/articles/ten-usability-heuristics/

### Overview first, details on demand

Shneiderman's information-seeking mantra is "overview first, zoom and filter,
then details-on-demand." IBM Carbon's data-table guidance describes expandable
rows as a way to keep the overview compact while revealing more detail when
requested.

- https://www.cs.umd.edu/~ben/papers/Shneiderman1996eyes.pdf
- https://carbondesignsystem.com/components/data-table/usage/

### Color reinforces meaning; it does not replace words

NN/g recommends using color as a categorical reinforcement rather than the main
encoding for quantitative magnitude. WCAG requires that color not be the only
way information is communicated. The dashboard therefore uses words such as
`Active`, `Estimated lower`, `Estimated higher`, and `Estimate unavailable`
alongside theme colors.

- https://www.nngroup.com/articles/dashboards-preattentive/
- https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
- https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html

## Applied design

The redesigned TUI follows this order:

1. Current session: title, freshness, total paid, active/finished runs, and
   an explicit comparison state.
2. History: this week, this month, then all time.
3. Recent sessions: four title-first rows with status, total paid, and the
   estimated cost change.
4. `See N more sessions`: a selectable route into the complete newest-first
   history, with eight rows per page and stable selection.
5. Details/help: the visible formula, missing-evidence explanation, stable IDs,
   and estimate-only warning.

The comparison is stated as an estimated difference versus running the same
primary work without Prewalk. It is calculated as:

```text
planner-only estimate
  = recorded planner primary-call cost
  + executor token usage repriced at planner rates

estimated difference
  = planner-only estimate
  - recorded planner + executor primary-call cost
```

Recorded spend still includes auxiliary model calls. The comparison is not an
observed control run and does not claim benchmark efficacy.

The interaction is one visible state machine owned by one custom component:

- overview → session details or full history;
- full history → session details, with Arrow and Page Up/Page Down navigation;
- details → the screen that opened it;
- help → the screen that opened it;
- Escape → one level back, then close at the root.

Pi's semantic selection keybindings own navigation and activation. Printable
letters are not hidden exit shortcuts. Refresh preserves a selected session by
identity where it remains visible, every close path resolves once, and all
screens render within narrow and normal widths.

## Local implementation evidence

Pi's extension TUI supports themed custom components, keyboard input, width-aware
rendering, overlays, and injected theme/keybinding objects:

- `~/Developer/pi/packages/coding-agent/docs/tui.md`

The implementation uses those facilities rather than formatting a long
notification as if it were a dashboard.
