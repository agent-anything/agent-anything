# Repository Instructions

## Highest-Priority Engineering Method

For every design change, including one discovered during implementation,
verify affected concept names against their confirmed responsibilities. Prefer
the smallest semantic scope that fully covers the responsibility, without
implying additional duties or omitting necessary ones. This is not a shortest-
name rule; precise longer names are welcome. Check adjacent boundaries even
when no rename was requested, and never change a responsibility silently to fit
a name. Record a brief verification outcome before accepting the design change.
The full naming standard is
`../agent-anything-design/standards/architecture-documentation.md`, under
"Minimum Sufficient Responsibility Naming", when the design repository is
available. The rule above applies independently of that file's availability.

For model requests and context, also apply
`../agent-anything-design/standards/model-request-correctness.md` when available.
Every request must faithfully represent the objective, applicable constraints
and capabilities, accepted interaction in causal order, correlated Call outcomes
and current state. Do not erase feedback, duplicate delivery, invent effects,
or repeat completed work on recovery. Protocol validity alone is insufficient:
verify actual encoded requests against independent expected facts. Keep source,
authority, transformations and missing information explicit.

For context selection and representation changes, also apply
`../agent-anything-design/standards/context-transformation-correctness-and-effectiveness.md`
when available. Check whole-input continuity, local responsibilities and known
relationships, then repeated use and recovery before judging savings. Structural
validation is not semantic preservation; do not add per-Turn semantic review.

Core principle: model input is a truthful, coherent working conversation, not
a mirror of internal state. Preserve truthfulness, coherence, and consistency
before removing repetition without an independent interaction purpose. Read
the actual input in delivery order; each contribution needs a clear source,
recipient, purpose, and position. A state change alone does not justify a new
message, while necessary restatement is not automatically redundant. Apply
this across Context, Tools, notifications, history, recovery, and compaction;
do not silently rewrite past exchanges or restore disabled instructions.

This is the highest-priority project method for analyzing problems and changing
this repository. The full human-maintained standard is
`../agent-anything-design/standards/problem-analysis-and-change-method.md` when
the adjacent design repository is available; the rules below are self-contained.

For every problem or related set of symptoms:

1. diagnose from the Agent core loop and foundational concepts downward through
   Contracts, supporting mechanisms, local implementation, and Product/model UX;
2. state the responsible layer or state that evidence is insufficient;
3. stop downstream patching when an upstream defect is found, correct it, and
   rerun the observation before reassessing lower-layer symptoms;
4. treat documents, code, and tests as correctable working artifacts, not
   immutable truth;
5. research material uncertainty before settling concepts or design, preferring
   primary sources and separating facts, inference, unknowns, and project
   judgment;
6. update accepted design first, then update Contracts, implementation, tests,
   and verification together; and
7. do not introduce symptom-specific prompt coaching, compatibility shims,
   fallback behavior, or abstractions without a justified long-term owner.

Before proposing a remedy or editing files, give the current layer verdict and
say whether lower-layer observations remain trustworthy. If the verdict is
uncertain, investigate before changing the system.

If investigation is noticeably harder than expected, first reassess gaps in
Inspector/log evidence and program structure. Identify the concrete missing
facts or unclear ownership/control flow. When necessary, improve reusable
diagnostics or address the structural obstacle before continuing costly
tracing; do not substitute speculation or repeated throwaway instrumentation.
Keep changes proportional and preserve active Runs, execution/recovery
semantics, sensitive-data policy and resource bounds.

When testing the core loop, preserve the deliberate ablation baseline when it
is relevant: zero built-in Agent Instructions, optional Hooks, Skills, and MCP;
retain complete Tool Contracts. Product-effectiveness behavior is evaluated
separately.

When evidence proves a foundational design wrong, correct it coherently. The
current pre-release project does not preserve wrong designs for compatibility.
