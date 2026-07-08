# AgentAnything

AgentAnything is a TypeScript workspace for building tool-using AI agent products.

The project is organized around a reusable platform foundation, product-level agent
composition, and host applications. Helarc is the primary product direction: an
agent workbench that starts with workspace-aware developer tasks, tool orchestration,
permission flows, change review, and durable run history, then grows beyond the
initial code-agent desktop stage. NetDoctor remains in the repository as the first
vertical product built on the platform.

## Current State

- Platform packages have been split into focused workspaces with boundary checks.
- `agent-core` provides runtime, task, context, planner, loop, event, and
  host-facing contracts.
- Helarc is the main active product and has a working Electron desktop host.
- Helarc supports workspace profiles, provider profiles, local credential storage,
  provider-backed runs, session history, run traces, permission-aware tools, and
  reviewable changes.
- Helarc's agent behavior foundation includes prompt sections, an action contract,
  a dynamic tool catalog, planner response recovery, protocol eval fixtures, and
  renderer-safe trace projection.
- NetDoctor remains as the first vertical product and a useful regression surface
  for platform contracts.

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
- Provider-backed agent loop execution
- Read-only code tools for listing, reading, and searching workspace files
- Permission-gated shell execution for enabled runs
- Patch proposal, review, and application flow
- Durable session history and run timeline data
- Safe trace projection for renderer-visible planner behavior
- Protocol fixtures for validating planner action behavior

### NetDoctor

NetDoctor is the first product built on AgentAnything.

It is a network diagnostic agent that inspects DNS, TCP, HTTP, proxy, and related
network issues through structured tools and product-specific reports.

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
    agent-core/      Runtime, loop, planner, context, task, events, host contracts
    code-agent/      Code-oriented tools and workflows
  products/
    helarc/          Helarc product composition
    net-doctor/      NetDoctor product composition
  apps/
    helarc-desktop/      Electron desktop app for Helarc
    net-doctor-cli/      CLI host for NetDoctor
    net-doctor-desktop/  Legacy Electron host for NetDoctor
  scripts/
    check-boundaries.mjs
```

## Package Boundaries

Platform packages are designed to point inward:

- Lower-level packages such as `shared`, `providers`, `tools`, `permission`,
  `governance`, `observability`, and `storage` define focused contracts.
- `agent-core` composes runtime-facing concepts such as task execution, planning,
  context, events, and host integration.
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
