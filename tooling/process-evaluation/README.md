# Isolated Process Evaluation

This engineering entry invokes the current Helarc target in a separate Electron
process and uses its real SQLite Worker, Agent delegation and recovery paths.
Evaluation owns Trial coordination, not production decisions. Inspector remains
read-only. The controlled local HTTP model exercises protocols and lifecycle
boundaries; it does **not** measure real-model semantic quality.

## Run

Build the workspace dependencies and Desktop main entry first. From the repository:

```powershell
pnpm --filter @agent-anything/process-evaluation evaluate
pnpm --filter @agent-anything/process-evaluation evaluate --child
pnpm --filter @agent-anything/process-evaluation evaluate --interrupt-after-effect
pnpm --filter @agent-anything/process-evaluation evaluate --resume <printed-directory>
pnpm --filter @agent-anything/process-evaluation test:electron
pnpm --filter @agent-anything/process-evaluation test:observation
```

A new Trial uses a fresh temporary directory. Resume uses the original Trial,
workspace identity, endpoint, target binding and execution admission; it does not
copy messages or edit recovery snapshots. A retained completed result is not run
again. Existing user settings, credentials, conversations and recordings are not
read or changed. The supported constructors are an empty task start and an
isolated task start with a known preexisting local effect. Arbitrary production
history, remote work and unknown in-flight work are not cloned.

## Evidence And Cleanup

The directory retains immutable journal/report revisions, owner-exported execution
snapshots, request and server-response evidence, Inspector recordings, and the
isolated workspace. These local source files contain actual request contents and
paths: do not publish the directory as a sanitized report. Generic Capture values
contain scope/coverage and references, not unrestricted source bodies.

Execution, capture, assessment, cleanup and report-save failures stay separate.
Capture bounds are explicit; missing or unreadable evidence is not success.
Server-prepared responses are distinct from target-accepted responses. Inspector
coverage is checked across all original recordings at fixed watermarks.
Whole-Trial metrics use explicit recovery links to include earlier generations,
not only the final replayed recording. Missing links or bounded omissions remain
limitations. Scoped continuations verify the original target input, construction,
endpoint and environment before resuming; their diagnostic registration does not
invent a Product Run admission. Shared transport cleanup joins handlers and logs.

Ctrl+C or a deadline cancels owned work and waits for process/connection/Worker
cleanup. Late resources still belong to their Trial. Unconfirmed cleanup
quarantines that Trial. A SQLite lease prevents simultaneous coordinators; an
abrupt coordinator exit releases the lease without granting new execution
authority. Evidence is deliberately retained after resource cleanup.

The verification program checks recovered effects, real Child execution,
branch/path isolation, private-input exclusion, rejected starting states, and a
timed-out Trial immediately followed by another Trial.
The observation verification runs recovery with full recording, disabled recording
and metadata-only capture, checking the independent effect and request counts.

## Comparative Processes

```powershell
pnpm --filter @agent-anything/process-evaluation compare --repetitions 2
pnpm --filter @agent-anything/process-evaluation compare --case C01 --live
pnpm --filter @agent-anything/process-evaluation compare --case C02 --arm summarize --live --model-grading
pnpm --filter @agent-anything/process-evaluation compare --case C03 --heldout
pnpm --filter @agent-anything/process-evaluation test:comparisons
```

C01 begins before adopting an externally fixed original/candidate; its production
is excluded. C02 begins before preservation or model production/checking. C03
begins before early/deferred investment; both use the actual shared scheduler,
and a later question is released only after the original foreground acceptance.
C04 starts the complete formal task with default or retained-original policy,
including actual Agent delegation. No transformation is forced on the default
policy. C01-C03 are scoped continuations, not whole-policy evaluations.

Repetitions use separate execution/material/authority scopes, regenerate C02
candidates, and reverse pair order on alternating repetitions. Budgets and
stopping rules are frozen before execution. `--heldout` changes the scoped facts
for C01-C03; the C04 fixture has its own fixed source protocol. Cache state is
not reset, controlled usage is synthetic, and these small samples do not prove
a general cost or quality advantage. `--live` uses the explicitly declared local
Ollama service at localhost:11435 with gemma4:e4b, without user configuration or
credential access. It is not automatic model selection.

`--directory <previous-directory>` checks the original comparison and reuses
accepted target results. `--manual-grades <file>` imports an array of objects
with `trialId`, exact `captureRef`, `dimension`, `verdict` and `rationale`.
Dimensions are preservation, subsequent_use, timing, cost and attribution;
verdicts are conforms, violated, insufficient_evidence and not_applicable.
`--model-grading` explicitly enables a separate advisory source/answer check;
its input, output and costs are separately recorded. Neither form modifies the
target, suppresses an earlier grade, authorizes execution, nor replaces missing
evidence with a passing judgment. Production checks are never used as independent
quality grades.

The deterministic grader compares only declared answer domains. Missing fields,
unsupported shapes and out-of-domain prose remain insufficient evidence; known
contradictions remain violations. A grader revision can reassess the original
Capture without relaunching its target. Original Trial conclusions and earlier
grades remain unchanged; the new grade has its own identity.

The formal target dispatches interactions by their original protocol identity.
Only approval requests use the declared approval policy. An unanswered question
remains pending and is captured as external-input evidence, not invented approval
or an automatically supplied answer. The original timeout/cancellation policy
still joins target cleanup before allowing the next trial.

Published reports are available under Context Process > Evaluation when Inspector
opens the printed `inspection` root. Reports retain original recording watermarks,
scope, exclusions and missing measurements, and work without a live Run. Reading
or exporting rechecks permission. Explicit export includes only the approved
report projection, not private expectation files or raw request/material bodies.
The full local directory remains sensitive engineering evidence.

`capture-queries.jsonl` records each collection query's kind, fixed boundary,
page, elapsed time and failure. The read-only diagnostic command
`node src/inspect-capture.mjs <trial-directory>` can replay those native reads
without reopening writable execution state or repeating an operation.
