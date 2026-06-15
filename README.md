# AgentAnything

AgentAnything is a TypeScript platform for building tool-using AI agent products with structured tasks, permissions, evidence, and runtime output.

The platform is designed to support multiple product agents. NetDoctor is the first product built on top of AgentAnything.

## What This Project Is

AgentAnything provides a shared foundation for AI agent products:

- Structured task execution
- Tool definitions and tool registry
- Permission checks before risky actions
- Tool results separated from evidence
- Structured runtime output
- Storage boundaries for task artifacts
- Scenario-based testing
- Extension points for providers, plugins, MCP, remote tools, and governance

## Products

### NetDoctor

NetDoctor is the first AgentAnything product.

It is a network diagnostic agent that helps users inspect DNS, TCP, HTTP, proxy, and related network issues through structured tools and reports.

## Repository Status

This project is in early development.

The initial focus is building the platform foundation and the first usable product workflow.

## Tech Stack

- TypeScript
- Node.js
- pnpm workspace
- Vitest

## Repository Layout

```text
agent-anything/
  packages/
    shared/
    tools/
    evidence/
    permission/
    governance/
    observability/
    providers/
    storage/
    agent-core/
    extensions/
    testing/
  apps/
    net-doctor-cli/
    net-doctor-desktop/
  products/
    net-doctor/
  scripts/
```
