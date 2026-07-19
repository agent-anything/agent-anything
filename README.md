# AgentAnything

AgentAnything is a TypeScript workspace for building tool-using AI agent products.

The project is organized around a reusable platform foundation, product-level agent
composition, and host applications. Helarc is the primary product direction: an
agent workbench that starts with workspace-aware developer tasks, tool orchestration,
permission flows, change review, and durable run history, then grows beyond the
initial code-agent desktop stage.

## Current State

- The platform is split into fifteen focused workspaces with executable dependency,
  source, and public API checks.
- `agent-core` provides Agent, Controller, Run, Action, Observation, Context,
  Plan, Retry, event, and task semantics and protocols. Its root is a small
  type-only composition surface; detailed Contracts use focused subpaths.
- `action-execution` provides the trusted Action preparation, assessment,
  revalidation, and Sandbox dispatch path.
- `agent-runtime` provides the authoritative Runner, provider-backed Controller,
  and Retry execution implementations.
- `host` provides product-neutral active Run integration, safe projections,
  approval bridges, and Host authority stores.
- Helarc is the main active product and has a working Electron desktop host.
- Helarc supports workspace profiles, provider profiles, local credential storage,
  provider-backed Runs, durable Thread history, Run traces, permission-aware
  Actions, and reviewable changes.
- Helarc's agent behavior foundation includes prompt sections, a Controller action
  contract, a dynamic tool catalog, provider response recovery, protocol eval
  fixtures, and renderer-safe trace projection.

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
- Read-only code tools for listing, reading, and searching workspace files
- Permission-gated shell execution for enabled runs
- Patch proposal, review, and application flow
- Durable Thread, Conversation, Message, Run, and Artifact history
- Safe trace projection for renderer-visible Controller behavior
- Protocol fixtures for validating Controller action behavior

## Tech Stack

- TypeScript
- Node.js
- pnpm workspace
- Electron for desktop hosts
- Vite and React for Helarc renderer UI
- Vitest

## Repository Layout

```text
agent-anything/
  packages/
    shared/          Shared primitives and result helpers
    providers/       Provider contracts
    tools/           Declarative Tool catalog and result contracts
    evidence/        Evidence contracts and builders
    permission/      Permission profiles, approvals, and authority contracts
    governance/      Policy, workspace, and identity context
    observability/   Audit, telemetry, and redaction contracts
    storage/         Storage port contracts
    testing/         Lower-level test fakes
    extensions/      MCP, plugins, remote tools, and extension points
    agent-core/      Agent and Run semantics, Controller and Retry protocols
    action-execution/ Trusted Action preparation and Sandbox dispatch
    agent-runtime/   Runner, provider-backed Controller, Retry execution
    host/            Host runtime integration, safe projections, approval bridges
    code-agent/      Code-oriented tools and workflows
  products/
    helarc/          Helarc product composition
  apps/
    helarc-desktop/  Electron desktop app for Helarc
  scripts/
    architecture/       Workspace discovery, dependency policy, and fixtures
    check-boundaries.mjs
    check-built-public-apis.mjs
```

## Package Boundaries

Platform packages are designed to point inward:

- Lower-level packages such as `shared`, `providers`, `tools`, `permission`,
  `governance`, `observability`, and `storage` define focused contracts.
- `agent-core` owns Agent and Run semantics plus Controller, Retry, Plan, Context,
  and event protocols.
- `action-execution` owns canonical Action preparation, policy and authority
  assessment, revalidation, and the mandatory Sandbox execution gateway.
- `agent-runtime` owns authoritative Run advancement and concrete Controller and
  Retry execution, and depends on Action execution without reversing that edge.
- `host` adapts authoritative Runner execution to product-neutral application hosts.
- `extensions` contains optional integration surfaces such as MCP, plugins,
  remote tools, remote Actions, and enterprise storage behind focused subpaths.
- `code-agent` exposes focused workspace, filesystem, command, and patch
  capability subpaths while keeping external effects behind Action execution.
- Product packages compose platform contracts into product behavior.
- App packages own UI, local persistence, credentials, desktop concerns, and
  product hosting.

`pnpm-workspace.yaml` is the package-location authority. Boundary rules are checked
by `scripts/check-boundaries.mjs` using the reusable policy under
`scripts/architecture/` and run as part of the root test command. Platform packages
cannot depend on products or apps; products cannot depend on apps or another
product; apps cannot depend on another app. Platform production edges must also
match the exact reviewed dependency graph.

## Common Commands

Install dependencies:

```powershell
pnpm install
```

Typecheck all workspace packages:

```powershell
pnpm typecheck
```

Run boundary checks and tests:

```powershell
pnpm test
```

Run the authoritative cross-package conformance matrix for Runner, Host, Action
execution, approval, Retry, Sandbox attempts, Helarc projection, and atomic Thread
commits:

```powershell
pnpm run conformance:test
```

Build all workspace packages:

```powershell
pnpm build
```

Build and verify the exact Core, Action Execution, Runtime, Host, Code Agent,
and Extensions ESM entry points, including removed and private paths:

```powershell
pnpm run api:check
```

Run the Helarc desktop app after building:

```powershell
pnpm --filter @agent-anything/helarc-desktop build
pnpm --filter @agent-anything/helarc-desktop start
```

Run the Helarc desktop development flow:

```powershell
pnpm --filter @agent-anything/helarc-desktop dev:electron
```

Delete all local Helarc desktop user data before starting against the current
development Contracts. This removes provider profiles and credentials, workspace
profiles, Threads, Runs, and every other file in the Helarc Electron `userData`
directory:

```powershell
pnpm --filter @agent-anything/helarc-desktop clean:user-data
```

Check Helarc desktop packaging readiness:

```powershell
pnpm --filter @agent-anything/helarc-desktop run package:check
```

## Provider Configuration

Helarc desktop stores provider profiles locally and supports these provider kinds:

- `openai-compatible`: base URL is the API base path, such as
  `https://api.openai.com/v1` or a compatible provider endpoint. The adapter calls
  `/chat/completions`.
- `ollama`: base URL is the Ollama server origin, such as
  `http://localhost:11434`. The adapter calls `/api/generate`.

HTTP provider URLs are accepted only for loopback addresses.
Provider timeout values use positive whole-second increments expressed in milliseconds.

## Status

The repository is still pre-product-1.0. The platform now has separate ownership
for Agent semantics, trusted Action execution, authoritative Run advancement,
Host integration, capabilities, and lower Contracts. Helarc exercises that graph
through a working Desktop Run, review, cancellation, and durable Thread workflow.

Current validation commands:

```powershell
pnpm run boundaries
pnpm run architecture:test
pnpm run conformance:test
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run api:check
pnpm --filter @agent-anything/helarc-desktop run package:check
```
