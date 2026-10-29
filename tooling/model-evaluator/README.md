# Independent Model Evaluator

Run `pnpm model:evaluate` and open the local access URL. This program owns its
connections, fixtures, requests and reports. It neither imports Helarc runtime
logic nor publishes capabilities to Helarc. Reports are stored under
`~/.model-evaluator` (override with `MODEL_EVALUATOR_DATA_DIR`).

## Context Representation Evaluation

The baseline suite tests instructions and native calls. The context suite tests
different responsibilities separately:

- Generation: reconstruct a compact structured working representation from
  source messages, preserving corrections, scope, exact values, provenance and
  uncertainty. A long variant adds irrelevant records; it is not a window-size
  benchmark.
- Subsequent use: answer fixed questions using only the generated representation.
- Repeated transformation: transform the first representation again and check
  both generations against the original, independent answer key.
- Checking: assess both faithful prose candidates and deliberately faulty ones.
  Include a paraphrased correct candidate whose exact value is in prose, not a
  structured field. Measure false rejection as well as false acceptance.

Generation uses structured representations so expected facts can be compared
without pretending to mechanically understand arbitrary summaries. Checking
uses natural-language candidates with controlled defects. Answer keys and
expected judgments are never sent to the evaluated model. There is no model
self-grade, repair loop, retry-until-pass, tool execution or added output cap.
The response schema is supplied as a prompt contract, not a Provider-enforced
`response_format`/`format` setting. These cases therefore also measure adherence
to that contract; they do not test native constrained-decoding support.
If an otherwise parseable response has a single JSON Markdown fence, the strict
protocol result remains failed. A separately labelled content-only diagnostic
can still reveal semantic defects or checking errors. It does not turn the trial
into a pass, edit values, infer missing fields or continue subsequent-use steps.
Sources contain changing values and trial markers to reduce literal memorization;
this does not disable Provider caching. All actual requests and responses remain
in the report, including failed and truncated responses.

Each trial records its oracle, phase and per-assertion outcome. Invalid response
shape, semantic mismatches, false acceptance/rejection and inconclusive transport
or length failures remain distinct. Four checking directions are elicited, but
the automated semantic oracle checks the explicit requirements, not speculative
natural-language explanations. A correct explanation still needs human review.

Results apply only to these fixtures, endpoint, model and generation settings.
They do not establish general compaction reliability, arbitrary prose quality,
multimodal capability, a safe maximum context length or long-task reliability.
No combined pass badge certifies a model for production. Manual model selection
can use the separate generation/checking evidence; runtime retention requirements
and per-candidate acceptance must remain independent.

Tests: `pnpm model:evaluate:test`. Tests use isolated temporary report directories
and local controlled endpoints; they do not access production credentials or data.
