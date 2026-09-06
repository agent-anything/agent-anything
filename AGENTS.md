# Repository Instructions

## Highest-Priority Engineering Method

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

When testing the core loop, preserve the deliberate ablation baseline when it
is relevant: zero built-in Agent Instructions, optional Hooks, Skills, and MCP;
retain complete Tool Contracts. Product-effectiveness behavior is evaluated
separately.

When evidence proves a foundational design wrong, correct it coherently. The
current pre-release project does not preserve wrong designs for compatibility.
