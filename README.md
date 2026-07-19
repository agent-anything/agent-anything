# AgentAnything

AgentAnything is a TypeScript workspace for building tool-using AI agent products.

The project is organized around a reusable platform foundation, product-level agent
composition, and host applications. Helarc is the primary product direction: an
agent workbench that starts with workspace-aware developer tasks, tool orchestration,
permission flows, change review, and durable run history, then grows beyond the
initial code-agent desktop stage.

## Current State

- Platform packages have been split into focused workspaces with boundary checks.
- `agent-core` provides Agent, Controller, Runner, Run, Action, Observation,
  Context, Plan, event, and task contracts.
- `host` provides product-neutral active Run integration, safe projections,
  approval bridges, and Host authority stores.
- Helarc is the main active product and has a working Electron desktop host.
- Helarc supports workspace profiles, provider profiles, local credential storage,
  provider-backed runs, session history, run traces, permission-aware tools, and
  reviewable changes.
- Helarc's agent behavior foundation includes prompt sections, a Controller action
  contract, a dynamic tool catalog, provider response recovery, protocol eval
  fixtures, and renderer-safe trace projection.

## Products

### Helarc

Helarc is the main product direction for AgentAnything.

Its first stage is a developer-focused agent workbench that combines a desktop
host, provider configuration, workspace/task/session concepts, traceable agent
runs, permission-aware tool use, and reviewable changes. The longer-term product
direction is broader than this first code-agent workflow. The desktop app currently
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
- Durable session history and run timeline data
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
    tools/           Tool definitions, registry, and adapters
    evidence/        Evidence contracts and builders
    permission/      Permission modes, requests, and services
    governance/      Policy, workspace, and identity context
    observability/   Audit, telemetry, and redaction contracts
    storage/         Storage port contracts
    testing/         Test fakes and scenario support
    extensions/      MCP, plugins, remote tools, and extension points
    agent-core/      Agent, Controller, Runner, Context, Plan, events
    host/            Host runtime integration, safe projections, approval bridges
    code-agent/      Code-oriented tools and workflows
  products/
    helarc/          Helarc product composition
  apps/
    helarc-desktop/      Electron desktop app for Helarc
  scripts/
    check-boundaries.mjs
```

## Package Boundaries

Platform packages are designed to point inward:

- Lower-level packages such as `shared`, `providers`, `tools`, `permission`,
  `governance`, `observability`, and `storage` define focused contracts.
- `agent-core` composes Agent, Controller, unified Runner, dynamic Plan, Context,
  and events.
- `host` adapts authoritative Runner execution to product-neutral application hosts.
- `extensions` contains optional integration surfaces such as MCP, plugins,
  remote tools, and enterprise storage.
- Product packages compose platform contracts into product behavior.
- App packages own UI, local persistence, credentials, desktop concerns, and
  product hosting.

Boundary rules are checked by `scripts/check-boundaries.mjs` and run as part of
the root test command. Product and app packages should depend on platform packages,
but platform packages should not depend on products or apps.

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

Build all workspace packages:

```powershell
pnpm build
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

The repository is still pre-product-1.0, but the platform package structure and
the Helarc agent behavior foundation are in place. Current validation passes
through boundary checks, root typecheck, tests, build, and Helarc desktop package
readiness checks.

Current validation commands:

```powershell
pnpm run boundaries
pnpm run typecheck
pnpm run test
pnpm run build
pnpm --filter @agent-anything/helarc-desktop run package:check
```
