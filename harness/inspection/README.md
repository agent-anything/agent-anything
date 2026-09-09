# Inspection

Optional, bounded diagnostic recording and read-only historical queries for
Agent Harness. This component observes semantic owners; it does not own Run
progression, scheduling, permissions or Tool execution.

## Responsibilities

- `records`: browser-safe subjects, immutable records, links and validation.
- `sources`: source registration and separate per-producer datasets.
- `content`: opt-in capture classes and known sensitive-field redaction.
- `recording`: bounded copy/enqueue and a dedicated writer worker.
- `storage`: SQLite WAL, content publication, reader leases and retention.
- `telemetry`: private OpenTelemetry trace/log SDKs and local export.
- `query`: bounded, watermark-based read workers and component-neutral views.
- `adapters`: public Runtime, Tool, Model Interaction and execution observations.

Execution owners define their observer DTOs without importing this package.
Composition attaches the adapters. There is no global OTel instrumentation,
Collector or network exporter. Native facts remain visible before a span ends.
OTel is a correlated diagnostic projection, not another Run state model.

## Storage and Privacy

On Windows the default root is `%LOCALAPPDATA%/AgentAnything/inspection`.
Other environments use the local user data directory. Data is separate from
workspace files and Product settings. A source can have multiple producer-start
datasets, each with one recorder worker and its own SQLite database/content.

Structural recording and Tool definitions are enabled by the default capture
policy. Agent content, Provider bodies and execution I/O require explicit opt-in.
Known credential/authority fields are removed. Arbitrary natural-language or
source-code content can still contain secrets; opt-in is not a secret-free
guarantee. Current capture-class authorization also controls historical reads.
Disabling a class does not silently delete its previously retained bytes.

Offers are bounded to 4,096 pending records, 16 MiB structural and 32 MiB content
ingress. Individual records/content are limited to 64 KiB/8 MiB. Dataset/source
operational thresholds are 512 MiB/2 GiB, with health headroom; these are not OS
hard quotas. Concurrent source-size observations and SQLite overhead can cause
bounded overshoot. Closed datasets are retained for seven days subject to
capacity. Open or unconfirmed recordings are never automatically deleted.

Capture errors and dropped records affect diagnostic coverage only. The shutdown
flush budget is two seconds; queued or dropped data is not crash-durable.
Content files publish before their metadata transaction. Missing, corrupt,
uncaptured and retired content must not be presented as an empty result.

## Verification

From the repository root using its fnm runtime:

```powershell
pnpm --filter @agent-anything/inspection... build
pnpm --filter @agent-anything/inspection test
pnpm --filter @agent-anything/inspection test:storage
```

The storage qualification runs the same better-sqlite3 Node-API binding under
Node and Electron, including independent WAL readers, checkpoint contention,
crash reopening and uncommitted content publication. SQLite calls run in workers,
not on the source execution or browser event loop.
