# AgentAnything

AgentAnything is a TypeScript workspace for building tool-using AI agent products.

The project is organized around a reusable platform foundation, product-level agent
composition, and host applications. Helarc is the primary product direction: a
desktop developer workbench in the same broad category as Codex, Claude Code,
Cline, and Cursor. NetDoctor remains in the repository as the first vertical
product built on the platform.

## Current Focus

- Build a strong platform foundation for agent products
- Keep platform packages independent from product and host application concerns
- Support structured tasks, runtime output, permissions, governance, tools,
  evidence, provider integration, and host-facing events
- Ship Helarc as an Electron desktop host backed by the shared platform
- Preserve NetDoctor as a concrete diagnostic product and regression surface

## Products

### Helarc

Helarc is the main product direction for AgentAnything.

It is a developer workbench that combines a desktop host, provider configuration,
workspace/task/session concepts, and agent runtime integration. The desktop app
currently supports OpenAI-compatible providers and Ollama through editable provider
profiles.

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
the root test command.

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

The project is still pre-1.0 as a product, but the platform structure, Helarc
desktop host, provider profile flow, and workspace-level validation are now in
place. Current validation passes through root typecheck, tests, build, boundary
checks, and Helarc desktop package readiness checks.
