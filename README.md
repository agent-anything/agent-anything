# AgentAnything

AgentAnything is a TypeScript workspace for building tool-using AI agent products.

The project is organized around a reusable Agent Harness, product-level agent
composition, and host applications. Helarc is the primary product direction: an
agent workbench that starts with workspace-aware developer tasks, tool orchestration,
permission flows, change review, and durable run history, then grows beyond the
initial code-agent desktop stage.

## Current State

- The repository is split into focused workspaces with executable dependency,
  source, and public API checks.
- `agent-core/contracts` provides the dependency-safe Agent Core surface for
  Agent, Task, Run input, Run relationships, Action, Workspace, Identity, and
  Artifact references.
- `agent-core/runtime` owns the authoritative Runner, Agent Loop, Controller,
  Run state and result, planning, cancellation, Retry coordination, limits,
  and terminalization.
- `model-interaction` owns Provider-neutral request, response, capability,
  interruption, and Retry-scheduler ownership Contracts.
- `context` owns active Context transitions, Observations, Evidence, and
  owner-defined Evidence persistence.
- `action-execution` provides the trusted Action preparation, assessment,
  revalidation, and Sandbox dispatch path.
- `host` retains and reconnects live `RunHandle` operations, provides safe
  projections, and owns approval transport and Host authority stores without
  becoming a second Run lifecycle owner.
- Helarc is the main active product and has a working Electron desktop host.
- Helarc supports workspace profiles, provider profiles, local credential storage,
  provider-backed Runs, durable Thread history, Run traces, permission-aware
  Actions, and reviewable changes.
- Helarc's agent behavior foundation includes prompt sections, a Controller action
  contract, a dynamic tool catalog, provider response recovery, deterministic system evaluation
  fixtures, and renderer-safe trace projection.
- Native model Tool calling preserves complete Model Turns and exact call/result
  correlation. Scheduling, explicit Composite prerequisites and descendant Run
  progression remain separate responsibilities.
- Independent Inspection records owner facts, protected content and local OTel
  traces/logs in SQLite. Agent Inspector provides linked historical views without
  becoming part of the execution path.
- Normal Run termination is `completed`; it does not assert Task success.
  Provider Retry waits, explicit suspension/resume, failure and cancellation
  retain separate, attributable lifecycle facts.
- Inspector's Execution Flow view follows captured Core Loop, supporting and
  Product paths, including repeated steps, actual checks and cross-owner calls.
  Recording is continuous; the UI reads a committed snapshot on manual refresh.

## Products

### Helarc

Helarc is the main product direction for AgentAnything.

Its first stage is a developer-focused agent workbench that combines a desktop
host, Provider configuration, workspace, Task, Thread, and Run concepts,
traceable Agent execution, permission-aware Actions, and reviewable changes. The
longer-term product direction is broader than this first code-agent workflow. The desktop app currently
supports OpenAI-compatible providers and Ollama through editable provider profiles.

Current Helarc capabilities include:

- Electron desktop host with a React renderer
- Workspace and task setup for local development work
- Provider profile management for OpenAI-compatible APIs and Ollama
- Local credential storage for provider API keys
- Provider-backed Controller and unified Runner execution
- Complete Read, Glob, Grep, Edit and Write Tools
- Permission-gated Bash/PowerShell execution and background task control
- Model-requested Agent delegation, concurrent descendants and explicit resume
- Multiple pending user questions, approvals and Run cancellation
- Patch proposal, review, and application flow
- Durable Thread, Conversation, Message, Run, and Artifact history
- Safe trace projection for renderer-visible Controller behavior
- Protocol fixtures for validating Controller action behavior
- Editable Agent, Protocol and Stop Instructions with independent enable flags
- Optional diagnostic capture settings for the standalone Inspector

## Tech Stack

- TypeScript
- Node.js
- pnpm workspace
- Electron for desktop hosts
- Vite and React for Helarc renderer UI
- Vitest
- SQLite and OpenTelemetry for local Inspection
- Ant Design, React Flow/ELK, vis-timeline and Monaco for Agent Inspector

## Repository Layout

```text
agent-anything/
  harness/
    agent-core/
      contracts/        Dependency-safe Agent Core semantic contracts
      runtime/          Runner, Agent Loop, Run lifecycle, Controller, Plan, Retry
    context/            Context, Observation, Evidence, and persistence contracts
    model-interaction/  Provider-neutral model invocation contracts
    tools/              Declarative Tool registration, catalogs, and results
    operation-catalog/  Operation registration and result protocols
    operation-composition/ Explicit composite workflows and prerequisites
    interaction/        User interaction protocols and coordination
    agent-hooks/        Optional Agent lifecycle handlers
    evaluation/         Deterministic evaluation definitions and results
    safety/
      governance/       Policy and managed constraint contracts
      permission/       Permission, approval, and authority contracts
      action-execution/ Canonical Action enforcement and Sandbox dispatch
      canonical-action/ Action subjects, lifecycle and settlement contracts
    integrations/
      mcp/              MCP lifecycle and primitive adaptation
      plugins/          Plugin trust admission and contribution activation
      remote/           Protocol-neutral remote Tool and Action adaptation
      enterprise-storage/ Enterprise persistence adapters
      providers/        Ollama and OpenAI-compatible HTTP adapters
    observability/      Events, Audit, Telemetry, execution flows and tracing
    inspection/         Optional recording, SQLite, local OTel and read queries
    host/               Product-neutral Host composition and Run control
  products/
    helarc/
      core/             Helarc Agent composition and workflows
      code-agent/       File and patch capabilities
      local-environment/ Shell and local process capabilities
      desktop/          Electron delivery, persistence, IPC, and renderer
  tooling/
    test-support/       Development-only reusable fakes and fixtures
    inspector/          Independent local inspection server and browser UI
  scripts/
    architecture/       Workspace discovery, dependency policy, and fixtures
    check-architecture.mjs
    check-built-public-apis.mjs
```

## Architecture Ownership

Reusable Harness packages are designed to point inward:

- Agent Core is one semantic owner implemented through a dependency-safe
  Contracts package and a Runtime package; the physical split remains one
  architectural domain.
- `agent-core/contracts` has no production dependencies and exposes only
  focused semantic subpaths.
- `agent-core/runtime` owns authoritative Run advancement and coordinates peer
  component Contracts without re-exporting them.
- `model-interaction` owns Provider-neutral invocation semantics.
- `context` owns Context, Observation, Evidence, and narrow Evidence
  persistence semantics without becoming a general storage facade.
- `action-execution` owns canonical Action preparation, policy and authority
  assessment, revalidation, and the mandatory Sandbox execution gateway.
- `host` adapts execution-native `RunHandle` operations to product-neutral
  application hosts and retains a bounded set of live and terminal handles.
- focused Integration packages own MCP, Plugin, remote capability, and
  enterprise storage adapters without a generic extension owner.
- Helarc capability components expose focused workspace, filesystem, command, and patch
  capability subpaths while keeping external effects behind Action execution.
- Product packages compose Harness contracts into product behavior.
- Helarc Desktop owns UI, local persistence, credentials, IPC, and concrete
  Product hosting.
- Test Support is a development-only dependency and defines no production
  Contracts.
- Inspection consumes public owner observations. Producers do not import
  Inspection or an OTel SDK to execute; source composition wires the adapters.
  Inspector consumes read-only Inspection queries without importing Helarc.

`pnpm-workspace.yaml` is the package-location authority.
`scripts/check-architecture.mjs` validates exact package metadata, repository
paths, production dependency policies, development-only Test Support use,
exports, ownership rules, and prohibited legacy topology. Harness cannot depend
on Products; Product components may collaborate only inside the same Product;
all production edges must match the exact reviewed dependency graph.

## Common Commands

The repository requires the exact Node and pnpm versions declared by
`.node-version` and `packageManager`. In an interactive shell, run `fnm use`
from the repository root before pnpm commands. Automation and non-interactive
PowerShell sessions can use the repository-owned entry point, which initializes
fnm, verifies both versions, and refuses fallback runtimes:

```powershell
.\scripts\run-repository-pnpm.ps1 typecheck
```

Install dependencies:

```powershell
pnpm install
```

Typecheck all workspace packages:

```powershell
pnpm typecheck
```

Run architecture checks and all tests:

```powershell
pnpm test
```

Run the authoritative cross-package conformance matrix for Runner, Host, Action
execution, approval, Retry, Sandbox attempts, Helarc projection, and atomic Thread
commits:

```powershell
pnpm run test:conformance
```

Root commands own cross-package build orchestration. Each workspace package's
`build` compiles only that package; it assumes dependency artifacts are already
available. Root product build commands select the product and its complete
workspace dependency graph so pnpm builds dependencies before their consumers.
Typechecking against source exports does not produce the JavaScript artifacts
required by runtime imports.
Nested pnpm commands use `scripts/run-pnpm.mjs` to retain the active package
manager entry instead of resolving a potentially different pnpm from `PATH`.

Build all workspace packages from clean output:

```powershell
pnpm build
```

Build and verify the exact Agent Core Contracts, Agent Core Runtime, Host,
Integration, and Helarc ESM entry points, including removed and private paths:

```powershell
pnpm run api:check
```

Build Helarc Desktop and all its workspace dependencies, then start the app:

```powershell
pnpm helarc:build
pnpm helarc:start
```

`helarc:start` launches the existing build without rebuilding. Direct package
commands such as `pnpm --filter @agent-anything/helarc-desktop build` remain
package-local and require the dependencies to have been built already.

Build Helarc's workspace dependencies, compile the desktop main/preload code,
and start the Vite/Electron development flow:

```powershell
pnpm helarc:dev
```

Delete all local Helarc desktop user data before starting against the current
development Contracts. This removes provider profiles and credentials, workspace
profiles, Threads, Runs, and every other file in the Helarc Electron `userData`
directory:

```powershell
pnpm --filter @agent-anything/helarc-desktop clean:user-data
```

Build Helarc and its workspace dependencies, then check desktop packaging
readiness. The desktop package's `package:check` only validates existing output:

```powershell
pnpm helarc:package:check
```

## Provider Configuration

Helarc desktop stores provider profiles locally and supports these provider kinds:

- `openai-compatible`: base URL is the API base path, such as
  `https://api.openai.com/v1` or a compatible provider endpoint. The adapter calls
  `/chat/completions`.
- `ollama`: base URL is the Ollama server origin, such as
  `http://localhost:11434`. Native Tool turns use `/api/chat`; structured
  generation uses `/api/generate`.

HTTP provider URLs are accepted only for loopback addresses.
Provider timeout values use positive whole-second increments expressed in milliseconds.

## Agent Inspector

```powershell
pnpm inspector:build
pnpm inspector:start
```

Open the printed one-use local access URL. Inspector runs independently of
Helarc and presents definitions, execution hierarchy, lifecycle transitions,
data flow, scheduling, explicit dependencies and recorded inputs/outputs/events.
Recording is continuous; viewing uses committed snapshots and manual Refresh.
There is no live-update or execution-control API.

Execution Flow adds captured Core Loop, supporting-capability and Helarc
definitions, repeated step occurrences, checks, and exact call/return/Child
relationships. Select a Run to investigate its recorded path.

Helarc Settings controls capture. Fresh Desktop settings enable structural
facts, definitions, Agent content, Provider bodies and execution I/O. Each class
can be disabled independently; saved settings take precedence over defaults.
On Windows, recordings are under `%LOCALAPPDATA%/AgentAnything/inspection` and
survive Helarc's `clean:user-data`. Capture failures cannot change Run results.
Known sensitive fields are removed, but captured free text may still contain
secrets. Missing or uncaptured facts remain unknown.

The current source/dataset format is version 2. To reset an incompatible
prerelease source, stop its Helarc process and the Inspector, then remove only
that source's `inspection/sources/<sourceId>` directory and relaunch both.
This intentionally discards that source's old recordings; clearing Helarc
user data alone does not reset Inspection. There is no automatic migration.

See [Inspector](tooling/inspector/README.md) for views, access, limits and cleanup,
and [Inspection](harness/inspection/README.md) for recording/query ownership.

## Status

The repository is still pre-product-1.0. Agent Core now owns Agent semantics and
authoritative Run advancement as one domain. Runner exposes the same active Run
through `RunHandle` to foreground and in-process background callers, while Host
adds retention, reconnection, safe projection, approval transport, and Product
correlation without duplicating execution truth. Helarc exercises that graph
through a working Desktop Run, review, cancellation, and durable Thread workflow.

Current validation commands:

```powershell
pnpm run architecture:check
pnpm run test:conformance
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run api:check
pnpm helarc:package:check
```
