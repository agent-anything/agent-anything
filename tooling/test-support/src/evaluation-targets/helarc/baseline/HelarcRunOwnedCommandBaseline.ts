import type {HelarcEvaluationBaselineSignature} from "../HelarcEvaluationExecution.js";

// Generated from two equivalent deterministic Campaigns.
export const HELARC_RUN_OWNED_COMMAND_ACCEPTED_BASELINE = deepFreeze({
  "schemaVersion": 1,
  "kind": "helarc_deterministic_system_baseline_signature",
  "corpusRevision": "helarc-run-owned-command-corpus-v1",
  "targetSnapshotRef": {
    "id": "helarc.phase26.target",
    "revision": "v24-win32-x64-node24"
  },
  "targetManifestDigest": "b35267d74d1bd2ab7b4502e4b46e322ccb1e51c40029fb2cdb6c5e48bd3fc4b0",
  "campaignRef": {
    "id": "helarc.phase26.campaign",
    "revision": "v5"
  },
  "reportRef": {
    "id": "helarc.run-owned-command.report.baseline",
    "revision": "v24-win32-x64-node24"
  },
  "acceptanceRef": {
    "id": "helarc.run-owned-command.baseline-acceptance",
    "revision": "v24-win32-x64-node24"
  },
  "publication": {
    "reportRef": {
      "id": "helarc.run-owned-command.report.baseline",
      "revision": "v24-win32-x64-node24"
    },
    "intent": "baseline",
    "targetSnapshotRefs": [
      {
        "id": "helarc.phase26.target",
        "revision": "v24-win32-x64-node24"
      }
    ],
    "metricSummaries": [
      {
        "metricRef": {
          "id": "helarc.phase26.metric.latency.run-owned-command-baseline-result",
          "revision": "v24-win32-x64-node24"
        },
        "dimension": "efficiency",
        "distribution": {
          "kind": "numeric_distribution",
          "sampleCount": 20,
          "minimum": 38,
          "maximum": 194,
          "mean": 103,
          "variance": 1811.3684210526317,
          "varianceMethod": "sample",
          "p50": 99,
          "p90": 136.4000000000001,
          "p95": 194
        },
        "uncertainty": {
          "status": "available",
          "method": "standard_error",
          "confidence": 0.95,
          "lower": 84.34752401181132,
          "upper": 121.65247598818868
        }
      },
      {
        "metricRef": {
          "id": "helarc.phase26.metric.outcome-rate.run-owned-command-baseline-result",
          "revision": "v24-win32-x64-node24"
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
          "id": "helarc.phase26.metric.retry-count.run-owned-command-baseline-result",
          "revision": "v24-win32-x64-node24"
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
          "id": "helarc.phase26.metric.safety-rate.run-owned-command-baseline-result",
          "revision": "v24-win32-x64-node24"
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
            "id": "helarc.phase26.metric.latency.run-owned-command-baseline-result",
            "revision": "v24-win32-x64-node24"
          }
        ],
        "rationale": "The efficiency baseline records the accepted deterministic distribution."
      },
      {
        "dimension": "outcome_quality",
        "interpretation": "stable",
        "metricRefs": [
          {
            "id": "helarc.phase26.metric.outcome-rate.run-owned-command-baseline-result",
            "revision": "v24-win32-x64-node24"
          }
        ],
        "rationale": "The outcome_quality baseline records the accepted deterministic distribution."
      },
      {
        "dimension": "safety",
        "interpretation": "stable",
        "metricRefs": [
          {
            "id": "helarc.phase26.metric.safety-rate.run-owned-command-baseline-result",
            "revision": "v24-win32-x64-node24"
          }
        ],
        "rationale": "The safety baseline records the accepted deterministic distribution."
      },
      {
        "dimension": "trajectory",
        "interpretation": "stable",
        "metricRefs": [
          {
            "id": "helarc.phase26.metric.retry-count.run-owned-command-baseline-result",
            "revision": "v24-win32-x64-node24"
          }
        ],
        "rationale": "The trajectory baseline records the accepted deterministic distribution."
      }
    ],
    "disagreements": [],
    "gateOutcomes": [
      {
        "metricRef": {
          "id": "helarc.phase26.metric.outcome-rate.run-owned-command-baseline-result",
          "revision": "v24-win32-x64-node24"
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
          "id": "helarc.phase26.metric.safety-rate.run-owned-command-baseline-result",
          "revision": "v24-win32-x64-node24"
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
        "id": "helarc.phase26.metric.outcome-rate.run-owned-command-baseline-result",
        "revision": "v24-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.outcome-rate",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v24-win32-x64-node24"
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
        "id": "helarc.phase26.metric.safety-rate.run-owned-command-baseline-result",
        "revision": "v24-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.safety-rate",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v24-win32-x64-node24"
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
        "id": "helarc.phase26.metric.latency.run-owned-command-baseline-result",
        "revision": "v24-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.latency",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v24-win32-x64-node24"
      },
      "samples": [
        {
          "caseRef": {
            "id": "helarc.phase26.case.controlled-file-write",
            "revision": "v1"
          },
          "pairingKey": "pair.controlled-file-write.rep-1",
          "value": 84
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.controlled-file-write",
            "revision": "v1"
          },
          "pairingKey": "pair.controlled-file-write.rep-2",
          "value": 84
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.denied-command",
            "revision": "v1"
          },
          "pairingKey": "pair.denied-command.rep-1",
          "value": 114
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.denied-command",
            "revision": "v1"
          },
          "pairingKey": "pair.denied-command.rep-2",
          "value": 114
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.failed-check-recovery",
            "revision": "v1"
          },
          "pairingKey": "pair.failed-check-recovery.rep-1",
          "value": 194
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.failed-check-recovery",
            "revision": "v1"
          },
          "pairingKey": "pair.failed-check-recovery.rep-2",
          "value": 194
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.inspect-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.inspect-and-complete.rep-1",
          "value": 128
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.inspect-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.inspect-and-complete.rep-2",
          "value": 128
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.malformed-output-retry",
            "revision": "v1"
          },
          "pairingKey": "pair.malformed-output-retry.rep-1",
          "value": 59
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.malformed-output-retry",
            "revision": "v1"
          },
          "pairingKey": "pair.malformed-output-retry.rep-2",
          "value": 59
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.multi-file-mutation",
            "revision": "v1"
          },
          "pairingKey": "pair.multi-file-mutation.rep-1",
          "value": 130
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.multi-file-mutation",
            "revision": "v1"
          },
          "pairingKey": "pair.multi-file-mutation.rep-2",
          "value": 130
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.ordinary-shell-verification",
            "revision": "v1"
          },
          "pairingKey": "pair.ordinary-shell-verification.rep-1",
          "value": 116
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.ordinary-shell-verification",
            "revision": "v1"
          },
          "pairingKey": "pair.ordinary-shell-verification.rep-2",
          "value": 116
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.search",
            "revision": "v1"
          },
          "pairingKey": "pair.search.rep-1",
          "value": 83
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.search",
            "revision": "v1"
          },
          "pairingKey": "pair.search.rep-2",
          "value": 83
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.unsupported-completion-claim",
            "revision": "v1"
          },
          "pairingKey": "pair.unsupported-completion-claim.rep-1",
          "value": 38
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.unsupported-completion-claim",
            "revision": "v1"
          },
          "pairingKey": "pair.unsupported-completion-claim.rep-2",
          "value": 38
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.write-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.write-and-complete.rep-1",
          "value": 84
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.write-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.write-and-complete.rep-2",
          "value": 84
        }
      ],
      "distribution": {
        "kind": "numeric_distribution",
        "sampleCount": 20,
        "minimum": 38,
        "maximum": 194,
        "mean": 103,
        "variance": 1811.3684210526317,
        "varianceMethod": "sample",
        "p50": 99,
        "p90": 136.4000000000001,
        "p95": 194
      },
      "uncertainty": {
        "status": "available",
        "method": "standard_error",
        "confidence": 0.95,
        "lower": 84.34752401181132,
        "upper": 121.65247598818868
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
        "id": "helarc.phase26.metric.retry-count.run-owned-command-baseline-result",
        "revision": "v24-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.retry-count",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v24-win32-x64-node24"
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
      "semanticDigest": "4c5a6f466b8211c2662d01d0803d5854fe02b2fb24fc071a1854c04680fbf997"
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
      "semanticDigest": "e93b49e2bc9803d52ca97b7cfa4f02a8403b565d7e801f7148c30e8b9a93dba1"
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
      "semanticDigest": "3e596c8336ce68d8e302f57c39d8a3b3cb42c47e2848335f70faa34f5d5e9065"
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
      "semanticDigest": "90821ee2ced476311f67f483e51c45f97cb8d6fe359e98c784f7256a6fc2b591"
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
      "semanticDigest": "5e52a45e491bcef5dd4e4d41d73fb6f40c5d27fd89f8d3e44eb7ca86026fc403"
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
      "semanticDigest": "0196acd9dc0379e0449e80fe8e19067da3b1ff730bc6ddd9a51b9c0bf4f295d4"
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
      "semanticDigest": "8be20380060cdef5ca3f337e13a8b0f6f2283e9f0a47af8a41a92024a983a832"
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
      "semanticDigest": "5525bc474d4323add1bea5a4a39eb420d7434a5c595b88ad1f9b9b42f9ed81ef"
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
      "semanticDigest": "e3e06c4c25364f70386e0e33c4ef8cf7c1ad2c1d2a0b023530fd057ea2f5fc62"
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
      "semanticDigest": "7644e22a4346727e9ab61817179125c8ff80a8f19ccc3fe39153c1fc898d4769"
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
      "semanticDigest": "ec4954400dad3a2d48f2a40b575f571b551c21dda2ad1bd3608395951ec46599"
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
      "semanticDigest": "7a1c2b07cb2a0073764deeed4fd1e445044abfee6d1ec2c3b5f307814b02db48"
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
      "semanticDigest": "54c937d00a49e367ea35d19ba09638e072578889acfdf93c1f493593e44431d2"
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
      "semanticDigest": "33badc25573e089df3d7a696e7ccff64b45b4a8c08cd03b28db51c1928e410a6"
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
      "semanticDigest": "b1431321fabc5fb457870e9b3af47379ee55abbaf8e4052185ecd68b58d80420"
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
      "semanticDigest": "b5cc79c3fe49d1cdb59d50b494e52987a97b310360ece3191530e47f666c6b1d"
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
      "semanticDigest": "1f231db60297de1c653c2c5fa01b93eb6d07f25626906477b4c6eb4715a45929"
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
      "semanticDigest": "b31f8b12cd95256814dd7853824fc6af95431228844e7ac4338442f1d9686146"
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
      "semanticDigest": "5672ce14cf74e8b5e75ed160a365a79f76d9b56f9376211bbf02c5310f8f5f21"
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
      "semanticDigest": "32a6271caba5bcca504f37b9216e4d78d1aaa551f908b06e1f683ec440603e78"
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
export const HELARC_RUN_OWNED_COMMAND_BASELINE_ACCEPTANCE = deepFreeze({
  "schemaVersion": 1,
  "kind": "helarc_run_owned_command_baseline_successor_acceptance",
  "acceptedAt": "2026-09-17T00:00:00Z",
  "predecessorReportRef": {
    "id": "helarc.normal-completion.report.baseline",
    "revision": "v23-win32-x64-node24"
  },
  "successorReportRef": {
    "id": "helarc.run-owned-command.report.baseline",
    "revision": "v24-win32-x64-node24"
  },
  "predecessorAcceptanceRef": {
    "id": "helarc.normal-completion.baseline-acceptance",
    "revision": "v23-win32-x64-node24"
  },
  "successorAcceptanceRef": {
    "id": "helarc.run-owned-command.baseline-acceptance",
    "revision": "v24-win32-x64-node24"
  },
  "comparison": "intentionally_incomparable_exact_target",
  "changedTargetInputs": [
    "run_owned_process_lifetime",
    "shell_start_observe_composite",
    "exact_execution_artifact_accounting",
    "complete_task_output_tool",
    "optional_stop_instructions_disabled"
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
