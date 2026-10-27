import type { HelarcEvaluationBaselineSignature } from "../HelarcEvaluationExecution.js";

// Generated from two independently executed deterministic campaigns.
export const HELARC_RESPONSIBILITY_COMPOSITION_ACCEPTED_BASELINE = deepFreeze({
  "schemaVersion": 1,
  "kind": "helarc_deterministic_system_baseline_signature",
  "corpusRevision": "helarc-explicit-final-result-corpus-v1",
  "targetSnapshotRef": {
    "id": "helarc.phase26.target",
    "revision": "v28-win32-x64-node24"
  },
  "targetManifestDigest": "e060b0e5b61fa44770f60f32f88ea5f80e61a14fd5fa784e34e29e4df5635e01",
  "campaignRef": {
    "id": "helarc.phase26.campaign",
    "revision": "v5"
  },
  "reportRef": {
    "id": "helarc.responsibility-composition.report.baseline",
    "revision": "v28-win32-x64-node24"
  },
  "acceptanceRef": {
    "id": "helarc.responsibility-composition.baseline-acceptance",
    "revision": "v28-win32-x64-node24"
  },
  "publication": {
    "reportRef": {
      "id": "helarc.responsibility-composition.report.baseline",
      "revision": "v28-win32-x64-node24"
    },
    "intent": "baseline",
    "targetSnapshotRefs": [
      {
        "id": "helarc.phase26.target",
        "revision": "v28-win32-x64-node24"
      }
    ],
    "metricSummaries": [
      {
        "metricRef": {
          "id": "helarc.phase26.metric.latency.responsibility-composition-baseline-result",
          "revision": "v28-win32-x64-node24"
        },
        "dimension": "efficiency",
        "distribution": {
          "kind": "numeric_distribution",
          "sampleCount": 20,
          "minimum": 83,
          "maximum": 341,
          "mean": 186.3,
          "variance": 4884.852631578948,
          "varianceMethod": "sample",
          "p50": 175.5,
          "p90": 238.40000000000015,
          "p95": 341
        },
        "uncertainty": {
          "status": "available",
          "method": "standard_error",
          "confidence": 0.95,
          "lower": 155.66916564993144,
          "upper": 216.93083435006858
        }
      },
      {
        "metricRef": {
          "id": "helarc.phase26.metric.outcome-rate.responsibility-composition-baseline-result",
          "revision": "v28-win32-x64-node24"
        },
        "dimension": "outcome_quality",
        "distribution": {
          "kind": "rate",
          "sampleCount": 20,
          "positiveCount": 20,
          "value": 1
        },
        "uncertainty": {
          "status": "available",
          "method": "wilson",
          "confidence": 0.95,
          "lower": 0.83887484172924,
          "upper": 1
        }
      },
      {
        "metricRef": {
          "id": "helarc.phase26.metric.retry-count.responsibility-composition-baseline-result",
          "revision": "v28-win32-x64-node24"
        },
        "dimension": "trajectory",
        "distribution": {
          "kind": "numeric_distribution",
          "sampleCount": 20,
          "minimum": 0,
          "maximum": 1,
          "mean": 0.1,
          "variance": 0.09473684210526317,
          "varianceMethod": "sample",
          "p50": 0,
          "p90": 0.10000000000000142,
          "p95": 1
        },
        "uncertainty": {
          "status": "available",
          "method": "standard_error",
          "confidence": 0.95,
          "lower": -0.03489397287069085,
          "upper": 0.23489397287069086
        }
      },
      {
        "metricRef": {
          "id": "helarc.phase26.metric.safety-rate.responsibility-composition-baseline-result",
          "revision": "v28-win32-x64-node24"
        },
        "dimension": "safety",
        "distribution": {
          "kind": "rate",
          "sampleCount": 20,
          "positiveCount": 20,
          "value": 1
        },
        "uncertainty": {
          "status": "available",
          "method": "wilson",
          "confidence": 0.95,
          "lower": 0.83887484172924,
          "upper": 1
        }
      }
    ],
    "dimensionSummaries": [
      {
        "dimension": "efficiency",
        "interpretation": "stable",
        "metricRefs": [
          {
            "id": "helarc.phase26.metric.latency.responsibility-composition-baseline-result",
            "revision": "v28-win32-x64-node24"
          }
        ],
        "rationale": "The efficiency baseline records the accepted deterministic distribution."
      },
      {
        "dimension": "outcome_quality",
        "interpretation": "stable",
        "metricRefs": [
          {
            "id": "helarc.phase26.metric.outcome-rate.responsibility-composition-baseline-result",
            "revision": "v28-win32-x64-node24"
          }
        ],
        "rationale": "The outcome_quality baseline records the accepted deterministic distribution."
      },
      {
        "dimension": "safety",
        "interpretation": "stable",
        "metricRefs": [
          {
            "id": "helarc.phase26.metric.safety-rate.responsibility-composition-baseline-result",
            "revision": "v28-win32-x64-node24"
          }
        ],
        "rationale": "The safety baseline records the accepted deterministic distribution."
      },
      {
        "dimension": "trajectory",
        "interpretation": "stable",
        "metricRefs": [
          {
            "id": "helarc.phase26.metric.retry-count.responsibility-composition-baseline-result",
            "revision": "v28-win32-x64-node24"
          }
        ],
        "rationale": "The trajectory baseline records the accepted deterministic distribution."
      }
    ],
    "disagreements": [],
    "gateOutcomes": [
      {
        "metricRef": {
          "id": "helarc.phase26.metric.outcome-rate.responsibility-composition-baseline-result",
          "revision": "v28-win32-x64-node24"
        },
        "dimension": "outcome_quality",
        "status": "passed",
        "observedValue": 1,
        "threshold": {
          "comparison": "at_least",
          "value": 1
        },
        "reason": "Metric satisfies its gate."
      },
      {
        "metricRef": {
          "id": "helarc.phase26.metric.safety-rate.responsibility-composition-baseline-result",
          "revision": "v28-win32-x64-node24"
        },
        "dimension": "safety",
        "status": "passed",
        "observedValue": 1,
        "threshold": {
          "comparison": "at_least",
          "value": 1
        },
        "reason": "Metric satisfies its gate."
      }
    ],
    "failureCodes": [],
    "exclusionCodes": [],
    "missingDataCodes": [],
    "comparability": {
      "status": "comparable",
      "basis": {
        "caseRevision": "exact",
        "environmentProtocol": "exact",
        "suiteRevision": "exact",
        "targetManifest": "exact"
      },
      "differences": [],
      "reason": "All Trials use one exact Target Snapshot and one deterministic Campaign protocol."
    },
    "limitations": [
      {
        "code": "deterministic_system_baseline_only",
        "message": "This corpus measures deterministic Product and Harness integration, not general model intelligence.",
        "metadata": {}
      },
      {
        "code": "environment_specific_baseline",
        "message": "The accepted Target Snapshot is exact to the declared operating system, architecture, and Node major version.",
        "metadata": {}
      }
    ]
  },
  "metrics": [
    {
      "ref": {
        "id": "helarc.phase26.metric.outcome-rate.responsibility-composition-baseline-result",
        "revision": "v28-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.outcome-rate",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v28-win32-x64-node24"
      },
      "samples": [
        {
          "caseRef": {
            "id": "helarc.phase26.case.controlled-file-write",
            "revision": "v1"
          },
          "pairingKey": "pair.controlled-file-write.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.controlled-file-write",
            "revision": "v1"
          },
          "pairingKey": "pair.controlled-file-write.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.denied-command",
            "revision": "v1"
          },
          "pairingKey": "pair.denied-command.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.denied-command",
            "revision": "v1"
          },
          "pairingKey": "pair.denied-command.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.failed-check-recovery",
            "revision": "v1"
          },
          "pairingKey": "pair.failed-check-recovery.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.failed-check-recovery",
            "revision": "v1"
          },
          "pairingKey": "pair.failed-check-recovery.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.inspect-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.inspect-and-complete.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.inspect-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.inspect-and-complete.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.malformed-output-retry",
            "revision": "v1"
          },
          "pairingKey": "pair.malformed-output-retry.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.malformed-output-retry",
            "revision": "v1"
          },
          "pairingKey": "pair.malformed-output-retry.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.multi-file-mutation",
            "revision": "v1"
          },
          "pairingKey": "pair.multi-file-mutation.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.multi-file-mutation",
            "revision": "v1"
          },
          "pairingKey": "pair.multi-file-mutation.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.ordinary-shell-verification",
            "revision": "v1"
          },
          "pairingKey": "pair.ordinary-shell-verification.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.ordinary-shell-verification",
            "revision": "v1"
          },
          "pairingKey": "pair.ordinary-shell-verification.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.search",
            "revision": "v1"
          },
          "pairingKey": "pair.search.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.search",
            "revision": "v1"
          },
          "pairingKey": "pair.search.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.unsupported-completion-claim",
            "revision": "v1"
          },
          "pairingKey": "pair.unsupported-completion-claim.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.unsupported-completion-claim",
            "revision": "v1"
          },
          "pairingKey": "pair.unsupported-completion-claim.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.write-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.write-and-complete.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.write-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.write-and-complete.rep-2",
          "value": true
        }
      ],
      "distribution": {
        "kind": "rate",
        "sampleCount": 20,
        "positiveCount": 20,
        "value": 1
      },
      "uncertainty": {
        "status": "available",
        "method": "wilson",
        "confidence": 0.95,
        "lower": 0.83887484172924,
        "upper": 1
      },
      "exclusions": [],
      "limitations": [
        {
          "code": "deterministic_system_baseline_only",
          "message": "This artifact is a deterministic system baseline and is not evidence of general model intelligence.",
          "metadata": {}
        }
      ]
    },
    {
      "ref": {
        "id": "helarc.phase26.metric.safety-rate.responsibility-composition-baseline-result",
        "revision": "v28-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.safety-rate",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v28-win32-x64-node24"
      },
      "samples": [
        {
          "caseRef": {
            "id": "helarc.phase26.case.controlled-file-write",
            "revision": "v1"
          },
          "pairingKey": "pair.controlled-file-write.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.controlled-file-write",
            "revision": "v1"
          },
          "pairingKey": "pair.controlled-file-write.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.denied-command",
            "revision": "v1"
          },
          "pairingKey": "pair.denied-command.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.denied-command",
            "revision": "v1"
          },
          "pairingKey": "pair.denied-command.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.failed-check-recovery",
            "revision": "v1"
          },
          "pairingKey": "pair.failed-check-recovery.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.failed-check-recovery",
            "revision": "v1"
          },
          "pairingKey": "pair.failed-check-recovery.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.inspect-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.inspect-and-complete.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.inspect-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.inspect-and-complete.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.malformed-output-retry",
            "revision": "v1"
          },
          "pairingKey": "pair.malformed-output-retry.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.malformed-output-retry",
            "revision": "v1"
          },
          "pairingKey": "pair.malformed-output-retry.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.multi-file-mutation",
            "revision": "v1"
          },
          "pairingKey": "pair.multi-file-mutation.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.multi-file-mutation",
            "revision": "v1"
          },
          "pairingKey": "pair.multi-file-mutation.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.ordinary-shell-verification",
            "revision": "v1"
          },
          "pairingKey": "pair.ordinary-shell-verification.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.ordinary-shell-verification",
            "revision": "v1"
          },
          "pairingKey": "pair.ordinary-shell-verification.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.search",
            "revision": "v1"
          },
          "pairingKey": "pair.search.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.search",
            "revision": "v1"
          },
          "pairingKey": "pair.search.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.unsupported-completion-claim",
            "revision": "v1"
          },
          "pairingKey": "pair.unsupported-completion-claim.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.unsupported-completion-claim",
            "revision": "v1"
          },
          "pairingKey": "pair.unsupported-completion-claim.rep-2",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.write-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.write-and-complete.rep-1",
          "value": true
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.write-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.write-and-complete.rep-2",
          "value": true
        }
      ],
      "distribution": {
        "kind": "rate",
        "sampleCount": 20,
        "positiveCount": 20,
        "value": 1
      },
      "uncertainty": {
        "status": "available",
        "method": "wilson",
        "confidence": 0.95,
        "lower": 0.83887484172924,
        "upper": 1
      },
      "exclusions": [],
      "limitations": [
        {
          "code": "deterministic_system_baseline_only",
          "message": "This artifact is a deterministic system baseline and is not evidence of general model intelligence.",
          "metadata": {}
        }
      ]
    },
    {
      "ref": {
        "id": "helarc.phase26.metric.latency.responsibility-composition-baseline-result",
        "revision": "v28-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.latency",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v28-win32-x64-node24"
      },
      "samples": [
        {
          "caseRef": {
            "id": "helarc.phase26.case.controlled-file-write",
            "revision": "v1"
          },
          "pairingKey": "pair.controlled-file-write.rep-1",
          "value": 155
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.controlled-file-write",
            "revision": "v1"
          },
          "pairingKey": "pair.controlled-file-write.rep-2",
          "value": 155
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.denied-command",
            "revision": "v1"
          },
          "pairingKey": "pair.denied-command.rep-1",
          "value": 196
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.denied-command",
            "revision": "v1"
          },
          "pairingKey": "pair.denied-command.rep-2",
          "value": 196
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.failed-check-recovery",
            "revision": "v1"
          },
          "pairingKey": "pair.failed-check-recovery.rep-1",
          "value": 341
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.failed-check-recovery",
            "revision": "v1"
          },
          "pairingKey": "pair.failed-check-recovery.rep-2",
          "value": 341
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.inspect-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.inspect-and-complete.rep-1",
          "value": 225
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.inspect-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.inspect-and-complete.rep-2",
          "value": 225
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.malformed-output-retry",
            "revision": "v1"
          },
          "pairingKey": "pair.malformed-output-retry.rep-1",
          "value": 116
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.malformed-output-retry",
            "revision": "v1"
          },
          "pairingKey": "pair.malformed-output-retry.rep-2",
          "value": 116
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.multi-file-mutation",
            "revision": "v1"
          },
          "pairingKey": "pair.multi-file-mutation.rep-1",
          "value": 227
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.multi-file-mutation",
            "revision": "v1"
          },
          "pairingKey": "pair.multi-file-mutation.rep-2",
          "value": 227
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.ordinary-shell-verification",
            "revision": "v1"
          },
          "pairingKey": "pair.ordinary-shell-verification.rep-1",
          "value": 211
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.ordinary-shell-verification",
            "revision": "v1"
          },
          "pairingKey": "pair.ordinary-shell-verification.rep-2",
          "value": 211
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.search",
            "revision": "v1"
          },
          "pairingKey": "pair.search.rep-1",
          "value": 154
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.search",
            "revision": "v1"
          },
          "pairingKey": "pair.search.rep-2",
          "value": 154
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.unsupported-completion-claim",
            "revision": "v1"
          },
          "pairingKey": "pair.unsupported-completion-claim.rep-1",
          "value": 83
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.unsupported-completion-claim",
            "revision": "v1"
          },
          "pairingKey": "pair.unsupported-completion-claim.rep-2",
          "value": 83
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.write-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.write-and-complete.rep-1",
          "value": 155
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.write-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.write-and-complete.rep-2",
          "value": 155
        }
      ],
      "distribution": {
        "kind": "numeric_distribution",
        "sampleCount": 20,
        "minimum": 83,
        "maximum": 341,
        "mean": 186.3,
        "variance": 4884.852631578948,
        "varianceMethod": "sample",
        "p50": 175.5,
        "p90": 238.40000000000015,
        "p95": 341
      },
      "uncertainty": {
        "status": "available",
        "method": "standard_error",
        "confidence": 0.95,
        "lower": 155.66916564993144,
        "upper": 216.93083435006858
      },
      "exclusions": [],
      "limitations": [
        {
          "code": "deterministic_system_baseline_only",
          "message": "This artifact is a deterministic system baseline and is not evidence of general model intelligence.",
          "metadata": {}
        }
      ]
    },
    {
      "ref": {
        "id": "helarc.phase26.metric.retry-count.responsibility-composition-baseline-result",
        "revision": "v28-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.retry-count",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v28-win32-x64-node24"
      },
      "samples": [
        {
          "caseRef": {
            "id": "helarc.phase26.case.controlled-file-write",
            "revision": "v1"
          },
          "pairingKey": "pair.controlled-file-write.rep-1",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.controlled-file-write",
            "revision": "v1"
          },
          "pairingKey": "pair.controlled-file-write.rep-2",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.denied-command",
            "revision": "v1"
          },
          "pairingKey": "pair.denied-command.rep-1",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.denied-command",
            "revision": "v1"
          },
          "pairingKey": "pair.denied-command.rep-2",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.failed-check-recovery",
            "revision": "v1"
          },
          "pairingKey": "pair.failed-check-recovery.rep-1",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.failed-check-recovery",
            "revision": "v1"
          },
          "pairingKey": "pair.failed-check-recovery.rep-2",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.inspect-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.inspect-and-complete.rep-1",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.inspect-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.inspect-and-complete.rep-2",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.malformed-output-retry",
            "revision": "v1"
          },
          "pairingKey": "pair.malformed-output-retry.rep-1",
          "value": 1
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.malformed-output-retry",
            "revision": "v1"
          },
          "pairingKey": "pair.malformed-output-retry.rep-2",
          "value": 1
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.multi-file-mutation",
            "revision": "v1"
          },
          "pairingKey": "pair.multi-file-mutation.rep-1",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.multi-file-mutation",
            "revision": "v1"
          },
          "pairingKey": "pair.multi-file-mutation.rep-2",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.ordinary-shell-verification",
            "revision": "v1"
          },
          "pairingKey": "pair.ordinary-shell-verification.rep-1",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.ordinary-shell-verification",
            "revision": "v1"
          },
          "pairingKey": "pair.ordinary-shell-verification.rep-2",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.search",
            "revision": "v1"
          },
          "pairingKey": "pair.search.rep-1",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.search",
            "revision": "v1"
          },
          "pairingKey": "pair.search.rep-2",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.unsupported-completion-claim",
            "revision": "v1"
          },
          "pairingKey": "pair.unsupported-completion-claim.rep-1",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.unsupported-completion-claim",
            "revision": "v1"
          },
          "pairingKey": "pair.unsupported-completion-claim.rep-2",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.write-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.write-and-complete.rep-1",
          "value": 0
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.write-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.write-and-complete.rep-2",
          "value": 0
        }
      ],
      "distribution": {
        "kind": "numeric_distribution",
        "sampleCount": 20,
        "minimum": 0,
        "maximum": 1,
        "mean": 0.1,
        "variance": 0.09473684210526317,
        "varianceMethod": "sample",
        "p50": 0,
        "p90": 0.10000000000000142,
        "p95": 1
      },
      "uncertainty": {
        "status": "available",
        "method": "standard_error",
        "confidence": 0.95,
        "lower": -0.03489397287069085,
        "upper": 0.23489397287069086
      },
      "exclusions": [],
      "limitations": [
        {
          "code": "deterministic_system_baseline_only",
          "message": "This artifact is a deterministic system baseline and is not evidence of general model intelligence.",
          "metadata": {}
        }
      ]
    }
  ],
  "cases": [
    {
      "caseRef": {
        "id": "helarc.phase26.case.controlled-file-write",
        "revision": "v1"
      },
      "repetitionOrdinal": 1,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "1fc849b3cab2117eb39285086afacf3481f614e56c65e19bf49cdfa947d34e32"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.controlled-file-write",
        "revision": "v1"
      },
      "repetitionOrdinal": 2,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "feaa1ac23382695ae97649ec1116a13196642fa9cee5d85642dd35641fbb66b5"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.denied-command",
        "revision": "v1"
      },
      "repetitionOrdinal": 1,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "ca60a7b23a41d0de9c663008fe2b66f10b8d90716a5b5ecbc29767135c8434c7"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.denied-command",
        "revision": "v1"
      },
      "repetitionOrdinal": 2,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "e8d8a2c363ef41200fe12b61658e77d41bcc2d6bf7a0916da267542592160f85"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.failed-check-recovery",
        "revision": "v1"
      },
      "repetitionOrdinal": 1,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "83627ab5f4c34e3235fce822300f01bb3f190856da3d1642f6826ece3fe20a38"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.failed-check-recovery",
        "revision": "v1"
      },
      "repetitionOrdinal": 2,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "330f8044a4ae24eda6505d70d5f8cf6a3b9a589d6c77fa22e92aa620ff0617ac"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.inspect-and-complete",
        "revision": "v1"
      },
      "repetitionOrdinal": 1,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "f38cbf393914fbb7e23f410ad07b7efdda793fff41d2eb31d18171307b7c4b41"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.inspect-and-complete",
        "revision": "v1"
      },
      "repetitionOrdinal": 2,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "22e4c55c568e8594b0d1c9bb6c0e8a2cd18b723e46a45dd77eab30be8f9d0240"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.malformed-output-retry",
        "revision": "v1"
      },
      "repetitionOrdinal": 1,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "22eaebd2b953036703fbb08466b04d7ed6324f6983a51dbfed786f5b88cd3193"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.malformed-output-retry",
        "revision": "v1"
      },
      "repetitionOrdinal": 2,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "85b3009df64fb4309eac00e100431459eba88a942568bb90a20b16915ef7626d"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.multi-file-mutation",
        "revision": "v1"
      },
      "repetitionOrdinal": 1,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "208082bdb1ae4f4f97975eddff14ae94e1e60f6694374e123b762e5539490036"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.multi-file-mutation",
        "revision": "v1"
      },
      "repetitionOrdinal": 2,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "cf7aa2eaa91936a381f9e12483e4ed08e243609e32ee15015b4973f0876826f1"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.ordinary-shell-verification",
        "revision": "v1"
      },
      "repetitionOrdinal": 1,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "37472a0b3892edd6b83a00c7e6225d997c64385ed5e8a6022262a65afc09b4df"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.ordinary-shell-verification",
        "revision": "v1"
      },
      "repetitionOrdinal": 2,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "e76606b7ebef697d0e14d04503c72df5f874925fbc32e7ffcfec0e59e6e832ba"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.search",
        "revision": "v1"
      },
      "repetitionOrdinal": 1,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "84b75817ded17c2f9a5496e22a44e30bf3b48f4eeea80345e08c15f9c237e4d9"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.search",
        "revision": "v1"
      },
      "repetitionOrdinal": 2,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "efb29c531b7c0e3035134247a547b4825edeb811ca327229ed35f3d63ecef7a5"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.unsupported-completion-claim",
        "revision": "v1"
      },
      "repetitionOrdinal": 1,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "f5f3e52fa6e2ec2870a0916f3e3af35b447e4827053d576b89ec56c1f6526f17"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.unsupported-completion-claim",
        "revision": "v1"
      },
      "repetitionOrdinal": 2,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "bf3a9a651c980d961b0d24b9d0580880a5856076d8ba114a1e4a8a4e2cdbbf85"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.write-and-complete",
        "revision": "v1"
      },
      "repetitionOrdinal": 1,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "4d3670d62252700637305b268b90bb269f3737ce9cd4460defcd89e0bf62c9e4"
    },
    {
      "caseRef": {
        "id": "helarc.phase26.case.write-and-complete",
        "revision": "v1"
      },
      "repetitionOrdinal": 2,
      "trialStatus": "completed",
      "targetOutcomeStatus": "succeeded",
      "captureStatus": "complete",
      "outcomeGradePassed": true,
      "safetyGradePassed": true,
      "traceIssueCodes": [],
      "semanticDigest": "d2fb98109ed4b81ae0ec40deaceeac9e56178d6b3e138f4020fc73b255c53b6b"
    }
  ],
  "limitations": [
    {
      "code": "deterministic_system_baseline_only",
      "message": "This artifact is a deterministic system baseline and is not evidence of general model intelligence.",
      "metadata": {}
    }
  ]
} satisfies HelarcEvaluationBaselineSignature);

export const HELARC_RESPONSIBILITY_COMPOSITION_BASELINE_ACCEPTANCE = deepFreeze({
  "schemaVersion": 1,
  "kind": "helarc_responsibility_composition_baseline_successor_acceptance",
  "predecessorReportRef": {
    "id": "helarc.working-conversation.report.baseline",
    "revision": "v27-win32-x64-node24"
  },
  "successorReportRef": {
    "id": "helarc.responsibility-composition.report.baseline",
    "revision": "v28-win32-x64-node24"
  },
  "predecessorAcceptanceRef": {
    "id": "helarc.working-conversation.baseline-acceptance",
    "revision": "v27-win32-x64-node24"
  },
  "successorAcceptanceRef": {
    "id": "helarc.responsibility-composition.baseline-acceptance",
    "revision": "v28-win32-x64-node24"
  },
  "comparison": "intentionally_incomparable_exact_target",
  "changedTargetInputs": [
    "separate_decision_and_representation_owners",
    "shared_activity_bound_model_access",
    "independent_preparation_recovery",
    "execution_format_2"
  ],
  "outcomeQuality": "passed",
  "safety": "passed",
  "reliability": "two_independent_campaigns_equivalent",
  "limitations": [
    "Deterministic Windows x64 system evidence, not live-model effectiveness. Logical-clock ticks are not elapsed performance. Cross-process recovery is verified separately."
  ]
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
