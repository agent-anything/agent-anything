# Agent Inspector

An independent local application for inspecting recorded Agent definitions,
execution and data relationships. Helarc does not need to remain running.
Recording continues without this application or its browser being open.

## Start

From the repository root, after applying the pinned fnm runtime:

```powershell
pnpm inspector:build
pnpm inspector:start
```

Open the printed one-use URL within 60 seconds. It creates a local eight-hour
browser session. Restarting the service requires a new access URL. The service
chooses an available loopback port; specify one when necessary:

```powershell
pnpm inspector:start --port 4311
pnpm inspector:start --data-root D:/diagnostics/inspection
```

The normal service serves built assets, without Vite or Electron. After edits,
rebuild and restart it. This application has no control, approval, resume,
arbitrary-file or SQL endpoint. Stop the foreground service with Ctrl+C.

## Capture and Investigation

Build/restart Helarc Desktop to begin recording. Fresh Desktop settings enable
structural facts, definitions and rich Agent, Provider and execution content.
Use its Inspection settings to select capture classes before submitting a task;
saved settings are preserved. Nothing reconstructs earlier uncaptured content:
those entries show `not_captured`, not an access error. Retained content whose
class is currently disabled remains protected by read authorization.

Choose a source and recording in Inspector. Refresh is explicit: no polling,
SSE or automatic focus/reconnect refresh advances the selected snapshot.

| Expression | Presentation |
| --- | --- |
| Static definitions | Searchable directory, exact revisions, captured content and diff |
| Execution hierarchy | Foldable Run groups, exact Turn/Call/Attempt objects |
| Lifecycle | Recorded transition path, owner description and trigger records |
| Data transfer | Directed recorded relations, content stages and known locations |
| Scheduling | Admission/queue/rule tables and measured time lanes |
| Explicit dependencies | Condition-bearing prerequisites and establishing records |
| Inputs, outputs and events | Typed details, protected JSON/text, content comparison |

Selection, exact record and watermark survive view changes and browser history.
Graphs support pan, zoom, drag, folding and explicit auto layout. Cross-group
edges retain their actual endpoints. Time order does not become dependency;
unrecorded transformations or consumers remain unknown.

In Execution Flow, `Request typed decision` links Run input, decision preparation
state and settings. Open its `Controller and Context` subflow to follow
`Prepare Controller input` into `Invoke Controller`: both refer to the same
captured Controller input. Task, history, Tools, Plan, Permission and projected
Context are visible together; invocation controls are separate. These are owner
inputs, not the Provider request itself. Executable dependencies are explicitly
excluded, and missing capture is never reconstructed from later state.

Record details list the relations asserted by that record. Open relation detail
to inspect and follow Source and Target objects. Related objects open their paged facts and named content in
contextual detail without changing the current Run, selected record or watermark.
Inspecting a relation shows its condition, operation, establishing record and
exact content locations. Missing targets remain explicitly not observed. Object
history is a separate command; following a reference never substitutes a newer
definition revision or latest payload for an exact historical target.

Views are bounded: graph neighborhoods use at most 300 nodes/1,000 edges, layout
has a two-second budget, and timelines use at most 100 lanes/2,000 intervals.
Lists expose seek pages; timeline pages report incomplete interval coverage.
Content opens a 256 KiB range with explicit loading up to the retained 8 MiB.
Comparison uses exact records/scopes, not an inferred quality score.
The shared content viewer offers Format JSON and Original actions for text and
JSON, including comparisons. JSON content is formatted by default; other text
starts as recorded. Manual formatting preserves literal values, reports invalid
or incomplete JSON and display-limit failures, and never changes stored content
or copy/download results.

## Local Data and Maintenance

Windows data defaults to `%LOCALAPPDATA%/AgentAnything/inspection`, separate from
Helarc's user-data reset. History remains available after Product exit. A crash
can leave the dataset open with stale freshness and an unknown tail; that is not
proof that a Run failed or completed.

List closed datasets eligible for retirement, then explicitly apply:

```powershell
pnpm inspector:maintenance --source SOURCE_ID
pnpm inspector:maintenance --source SOURCE_ID --apply
```

`--dataset DATASET_ID`, `--before ISO_DATE`, and `--data-root PATH` scope the
operation. The default cutoff is seven days. Active reader leases defer removal.
The command refuses open/unconfirmed recordings; it never deletes workspace or
Product data. Successful retirement preserves a bounded receipt so old URLs can
report cleared rather than resolve to unrelated data.

## Components and Checks

React/Ant Design provide the workbench, React Flow plus ELK provide graph
interaction/layout, vis-timeline provides time lanes, and Monaco provides local
read-only text/JSON/diff workers. All required controls use their free releases.
SQLite/OTel/query Contracts are independent of these presentation libraries.

Vite emits `dist/renderer/THIRD-PARTY-NOTICES.txt` with bundled dependency notices.
ELK is used unmodified under EPL-2.0; its source is available from
[elkjs](https://github.com/kieler/elkjs). Retain these notices when distributing
the built application. Other package license choices remain in that artifact.

```powershell
pnpm --filter @agent-anything/inspector typecheck
pnpm --filter @agent-anything/inspector test
pnpm --filter @agent-anything/inspector test:ui
```

Browser checks use Playwright Chromium and deterministic diagnostic recordings,
not production fake data or paid model calls. They cover connected navigation,
manual refresh, graph layouts, local workers, basic narrow-screen rendering and
a bounded larger recording. Live tracing and external OTel export are not enabled.
