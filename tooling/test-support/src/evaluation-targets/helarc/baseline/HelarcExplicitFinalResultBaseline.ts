import type { HelarcEvaluationBaselineSignature } from "../HelarcEvaluationExecution.js";

export const HELARC_EXPLICIT_FINAL_RESULT_ACCEPTED_BASELINE = deepFreeze({
  "schemaVersion": 1,
  "kind": "helarc_deterministic_system_baseline_signature",
  "corpusRevision": "helarc-explicit-final-result-corpus-v1",
  "targetSnapshotRef": {
    "id": "helarc.phase26.target",
    "revision": "v25-win32-x64-node24"
  },
  "targetManifestDigest": "7727f6ca2d0a71c28576b612efaa0c8d20a4cc150a7978c487825e450ea7c62d",
  "campaignRef": {
    "id": "helarc.phase26.campaign",
    "revision": "v5"
  },
  "reportRef": {
    "id": "helarc.explicit-final-result.report.baseline",
    "revision": "v25-win32-x64-node24"
  },
  "acceptanceRef": {
    "id": "helarc.explicit-final-result.baseline-acceptance",
    "revision": "v25-win32-x64-node24"
  },
  "publication": {
    "reportRef": {
      "id": "helarc.explicit-final-result.report.baseline",
      "revision": "v25-win32-x64-node24"
    },
    "intent": "baseline",
    "targetSnapshotRefs": [
      {
        "id": "helarc.phase26.target",
        "revision": "v25-win32-x64-node24"
      }
    ],
    "metricSummaries": [
      {
        "metricRef": {
          "id": "helarc.phase26.metric.latency.explicit-final-result-baseline-result",
          "revision": "v25-win32-x64-node24"
        },
        "dimension": "efficiency",
        "distribution": {
          "kind": "numeric_distribution",
          "sampleCount": 20,
          "minimum": 48,
          "maximum": 204,
          "mean": 113,
          "variance": 1811.3684210526317,
          "varianceMethod": "sample",
          "p50": 109,
          "p90": 146.4000000000001,
          "p95": 204
        },
        "uncertainty": {
          "status": "available",
          "method": "standard_error",
          "confidence": 0.95,
          "lower": 94.34752401181132,
          "upper": 131.65247598818868
        }
      },
      {
        "metricRef": {
          "id": "helarc.phase26.metric.outcome-rate.explicit-final-result-baseline-result",
          "revision": "v25-win32-x64-node24"
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
          "id": "helarc.phase26.metric.retry-count.explicit-final-result-baseline-result",
          "revision": "v25-win32-x64-node24"
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
          "id": "helarc.phase26.metric.safety-rate.explicit-final-result-baseline-result",
          "revision": "v25-win32-x64-node24"
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
            "id": "helarc.phase26.metric.latency.explicit-final-result-baseline-result",
            "revision": "v25-win32-x64-node24"
          }
        ],
        "rationale": "The efficiency baseline records the accepted deterministic distribution."
      },
      {
        "dimension": "outcome_quality",
        "interpretation": "stable",
        "metricRefs": [
          {
            "id": "helarc.phase26.metric.outcome-rate.explicit-final-result-baseline-result",
            "revision": "v25-win32-x64-node24"
          }
        ],
        "rationale": "The outcome_quality baseline records the accepted deterministic distribution."
      },
      {
        "dimension": "safety",
        "interpretation": "stable",
        "metricRefs": [
          {
            "id": "helarc.phase26.metric.safety-rate.explicit-final-result-baseline-result",
            "revision": "v25-win32-x64-node24"
          }
        ],
        "rationale": "The safety baseline records the accepted deterministic distribution."
      },
      {
        "dimension": "trajectory",
        "interpretation": "stable",
        "metricRefs": [
          {
            "id": "helarc.phase26.metric.retry-count.explicit-final-result-baseline-result",
            "revision": "v25-win32-x64-node24"
          }
        ],
        "rationale": "The trajectory baseline records the accepted deterministic distribution."
      }
    ],
    "disagreements": [],
    "gateOutcomes": [
      {
        "metricRef": {
          "id": "helarc.phase26.metric.outcome-rate.explicit-final-result-baseline-result",
          "revision": "v25-win32-x64-node24"
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
          "id": "helarc.phase26.metric.safety-rate.explicit-final-result-baseline-result",
          "revision": "v25-win32-x64-node24"
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
        "id": "helarc.phase26.metric.outcome-rate.explicit-final-result-baseline-result",
        "revision": "v25-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.outcome-rate",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v25-win32-x64-node24"
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
        "id": "helarc.phase26.metric.safety-rate.explicit-final-result-baseline-result",
        "revision": "v25-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.safety-rate",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v25-win32-x64-node24"
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
        "id": "helarc.phase26.metric.latency.explicit-final-result-baseline-result",
        "revision": "v25-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.latency",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v25-win32-x64-node24"
      },
      "samples": [
        {
          "caseRef": {
            "id": "helarc.phase26.case.controlled-file-write",
            "revision": "v1"
          },
          "pairingKey": "pair.controlled-file-write.rep-1",
          "value": 94
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.controlled-file-write",
            "revision": "v1"
          },
          "pairingKey": "pair.controlled-file-write.rep-2",
          "value": 94
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.denied-command",
            "revision": "v1"
          },
          "pairingKey": "pair.denied-command.rep-1",
          "value": 124
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.denied-command",
            "revision": "v1"
          },
          "pairingKey": "pair.denied-command.rep-2",
          "value": 124
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.failed-check-recovery",
            "revision": "v1"
          },
          "pairingKey": "pair.failed-check-recovery.rep-1",
          "value": 204
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.failed-check-recovery",
            "revision": "v1"
          },
          "pairingKey": "pair.failed-check-recovery.rep-2",
          "value": 204
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.inspect-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.inspect-and-complete.rep-1",
          "value": 138
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.inspect-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.inspect-and-complete.rep-2",
          "value": 138
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.malformed-output-retry",
            "revision": "v1"
          },
          "pairingKey": "pair.malformed-output-retry.rep-1",
          "value": 69
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.malformed-output-retry",
            "revision": "v1"
          },
          "pairingKey": "pair.malformed-output-retry.rep-2",
          "value": 69
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.multi-file-mutation",
            "revision": "v1"
          },
          "pairingKey": "pair.multi-file-mutation.rep-1",
          "value": 140
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.multi-file-mutation",
            "revision": "v1"
          },
          "pairingKey": "pair.multi-file-mutation.rep-2",
          "value": 140
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.ordinary-shell-verification",
            "revision": "v1"
          },
          "pairingKey": "pair.ordinary-shell-verification.rep-1",
          "value": 126
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.ordinary-shell-verification",
            "revision": "v1"
          },
          "pairingKey": "pair.ordinary-shell-verification.rep-2",
          "value": 126
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.search",
            "revision": "v1"
          },
          "pairingKey": "pair.search.rep-1",
          "value": 93
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.search",
            "revision": "v1"
          },
          "pairingKey": "pair.search.rep-2",
          "value": 93
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.unsupported-completion-claim",
            "revision": "v1"
          },
          "pairingKey": "pair.unsupported-completion-claim.rep-1",
          "value": 48
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.unsupported-completion-claim",
            "revision": "v1"
          },
          "pairingKey": "pair.unsupported-completion-claim.rep-2",
          "value": 48
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.write-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.write-and-complete.rep-1",
          "value": 94
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.write-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.write-and-complete.rep-2",
          "value": 94
        }
      ],
      "distribution": {
        "kind": "numeric_distribution",
        "sampleCount": 20,
        "minimum": 48,
        "maximum": 204,
        "mean": 113,
        "variance": 1811.3684210526317,
        "varianceMethod": "sample",
        "p50": 109,
        "p90": 146.4000000000001,
        "p95": 204
      },
      "uncertainty": {
        "status": "available",
        "method": "standard_error",
        "confidence": 0.95,
        "lower": 94.34752401181132,
        "upper": 131.65247598818868
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
        "id": "helarc.phase26.metric.retry-count.explicit-final-result-baseline-result",
        "revision": "v25-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.retry-count",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v25-win32-x64-node24"
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
      "semanticDigest": "3ba747c430a6d3db6ddff76add46bb431ea335feb39a82e24680fd1b4ecdbca3"
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
      "semanticDigest": "53631b0daaf03560d897b69607640bc8b75f1cc09bd6acfbce84beb8d2dcd6da"
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
      "semanticDigest": "7eabfa0c795e820c3ce4c18b64f4ca86b71325521eb4faee1ca1ac44aaaf377c"
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
      "semanticDigest": "c05741e64dfc4ec95673b518c569fd282db605fa56b7f75f82a947224035aee0"
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
      "semanticDigest": "d132a5b19c26a877630ddbc77693ca38f44f20470813cdc323923d1bb9bd44ad"
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
      "semanticDigest": "48f3007d32d9d8ac2193cbc8a8c975235f570c95d2ce7ec98b75488d508a718d"
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
      "semanticDigest": "c61429dc615e7c6d2119866fbd5c45400de3f13d87c2c5b33c2a98f7f110cd25"
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
      "semanticDigest": "a754fe9ce0acedf4d69f233899ab79f7433003043fa7e1b14b35bbcf770315cb"
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
      "semanticDigest": "9f51e5b16c3b144190f609e848da42827cdb7b7a6747d492fd5ef8c1e423fbd5"
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
      "semanticDigest": "84f8ad0d7ecde67d512318a71efc71ea59b6026ecf8ac88155e4fc6f8baa559d"
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
      "semanticDigest": "41c66894638be55399729495e3d046a4e63488cc4bcaa69c5679b30ac2ed5c07"
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
      "semanticDigest": "5c3fd70033a40caa327f4bda5d2f6aaef0b8435a372148f185e8767533e210e0"
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
      "semanticDigest": "eb3519d10b727f703e7d7f3f61812341bffefc38ee18cd143cd93ea0f4655092"
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
      "semanticDigest": "6856e139ecb84488b897060208324f07084c467df01d4b2beb23b9f74beef76e"
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
      "semanticDigest": "28c0c268487241dae846b7bc3fff6a7d1432f4d91ba7dedaf935bca882b2d9e3"
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
      "semanticDigest": "641ca062bb788bbc7976a26a5873e52b1ee5df30a51904f3810afd2d4ed503f6"
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
      "semanticDigest": "71432891fe31b73f45d60c0de744d3ae323cbf298142aaa6693cd60a488b5e17"
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
      "semanticDigest": "24c982efd96cb83a7962bc7a7d2801ca7afd57cc915554a8a3b1dc39bed01335"
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
      "semanticDigest": "cf2ee67c62a35f7b0a905185c545da1b1f1d68563bfea8cb8b70fa4950e3db5c"
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
      "semanticDigest": "04e9c39418eec691d78ed00cd84a356ffe8474db03916251964477fafc1e7956"
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
export const HELARC_EXPLICIT_FINAL_RESULT_BASELINE_ACCEPTANCE = deepFreeze({
  "schemaVersion": 1,
  "kind": "helarc_explicit_final_result_baseline_successor_acceptance",
  "acceptedAt": "2026-09-29T00:00:00Z",
  "predecessorReportRef": {
    "id": "helarc.run-owned-command.report.baseline",
    "revision": "v24-win32-x64-node24"
  },
  "successorReportRef": {
    "id": "helarc.explicit-final-result.report.baseline",
    "revision": "v25-win32-x64-node24"
  },
  "predecessorAcceptanceRef": {
    "id": "helarc.run-owned-command.baseline-acceptance",
    "revision": "v24-win32-x64-node24"
  },
  "successorAcceptanceRef": {
    "id": "helarc.explicit-final-result.baseline-acceptance",
    "revision": "v25-win32-x64-node24"
  },
  "comparison": "intentionally_incomparable_exact_target",
  "changedTargetInputs": [
    "explicit_final_result_control",
    "ordered_same_turn_completion_candidates",
    "post_settlement_optional_stop",
    "exact_final_call_settlement_and_output_source"
  ],
  "outcomeQuality": "passed",
  "safety": "passed",
  "reliability": "two_independent_campaigns_equivalent",
  "limitations": [
    "Deterministic Windows x64 system evidence, not live-model effectiveness or POSIX native conformance."
  ]
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
