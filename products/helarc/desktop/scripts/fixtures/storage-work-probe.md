# Fixed Storage Work Probe

This diagnostic uses synthetic immutable content and exact round-trip comparison.
It does not open a Run, a Provider, SQLite, or user data. Eight fresh encodings and
decodings report work counts, wall time, current-thread CPU, process age and memory.
Do not attribute a change in time to application work unless the work counts and
measurement boundaries agree.

From the Desktop package:

```powershell
node scripts/measure-storage-work.mjs
pnpm exec vitest run --config scripts/storage-work.vitest.config.ts
```

The Vitest experiment compares its Host, a fresh independent Node and a Worker.
Set `HELARC_STORAGE_PROBE_IMPORT_HOST=1` to load the Desktop Host without creating
one. Set `HELARC_STORAGE_PROBE_WAIT=1` instead to idle for 44 seconds without that
import. Clear each variable before selecting the other control.

For a Windows-only, reversible execution-policy comparison:

```powershell
$env:HELARC_STORAGE_PROBE_AGE = '1'
$env:HELARC_STORAGE_PROBE_POLICY = '1'
node scripts/measure-storage-work.mjs
Remove-Item Env:HELARC_STORAGE_PROBE_AGE
Remove-Item Env:HELARC_STORAGE_PROBE_POLICY
```

This measures before and after a 20-second idle interval, explicitly selects
HighQoS for this Node process, measures again, restores its prior policy in a
`finally`, and measures after restoration. The helper only accepts its directly
owning Node process. It does not alter machine power policy, process priority,
CPU affinity or an unrelated process. Unsupported selection/readback is an error,
not a silently accepted test condition.

An explicit foreground regression profile is available on Windows:

```powershell
pnpm run test:foreground
```

It retains the normal test pool assignments and timeouts, runs files sequentially,
records policy selection/readback/restoration for each test process, and restores
the exact original masks. The ordinary `test` entry and production app are
unchanged. Results from this profile prove behavior under the stated condition,
not equal latency under automatic background throttling. Actual Electron/SQLite
recovery verification is separate and does not use this profile.
