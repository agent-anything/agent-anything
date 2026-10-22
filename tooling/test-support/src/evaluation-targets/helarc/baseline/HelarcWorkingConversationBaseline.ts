import type { HelarcEvaluationBaselineSignature } from "../HelarcEvaluationExecution.js";

// Generated from two independently executed deterministic campaigns.
export const HELARC_WORKING_CONVERSATION_ACCEPTED_BASELINE = deepFreeze({
  "schemaVersion": 1,
  "kind": "helarc_deterministic_system_baseline_signature",
  "corpusRevision": "helarc-explicit-final-result-corpus-v1",
  "targetSnapshotRef": {
    "id": "helarc.phase26.target",
    "revision": "v27-win32-x64-node24"
  },
  "targetManifestDigest": "658fd7aea09708597005342c5e940c72e57e70cfac3a712e3cce1bab280865af",
  "campaignRef": {
    "id": "helarc.phase26.campaign",
    "revision": "v5"
  },
  "reportRef": {
    "id": "helarc.working-conversation.report.baseline",
    "revision": "v27-win32-x64-node24"
  },
  "acceptanceRef": {
    "id": "helarc.working-conversation.baseline-acceptance",
    "revision": "v27-win32-x64-node24"
  },
  "publication": {
    "reportRef": {
      "id": "helarc.working-conversation.report.baseline",
      "revision": "v27-win32-x64-node24"
    },
    "intent": "baseline",
    "targetSnapshotRefs": [
      {
        "id": "helarc.phase26.target",
        "revision": "v27-win32-x64-node24"
      }
    ],
    "metricSummaries": [
      {
        "metricRef": {
          "id": "helarc.phase26.metric.latency.working-conversation-baseline-result",
          "revision": "v27-win32-x64-node24"
        },
        "dimension": "efficiency",
        "distribution": {
          "kind": "numeric_distribution",
          "sampleCount": 20,
          "minimum": 82,
          "maximum": 338,
          "mean": 184.2,
          "variance": 4799.5368421052635,
          "varianceMethod": "sample",
          "p50": 173.5,
          "p90": 235.40000000000015,
          "p95": 338
        },
        "uncertainty": {
          "status": "available",
          "method": "standard_error",
          "confidence": 0.95,
          "lower": 153.83783343774672,
          "upper": 214.56216656225325
        }
      },
      {
        "metricRef": {
          "id": "helarc.phase26.metric.outcome-rate.working-conversation-baseline-result",
          "revision": "v27-win32-x64-node24"
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
          "id": "helarc.phase26.metric.retry-count.working-conversation-baseline-result",
          "revision": "v27-win32-x64-node24"
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
          "id": "helarc.phase26.metric.safety-rate.working-conversation-baseline-result",
          "revision": "v27-win32-x64-node24"
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
            "id": "helarc.phase26.metric.latency.working-conversation-baseline-result",
            "revision": "v27-win32-x64-node24"
          }
        ],
        "rationale": "The efficiency baseline records the accepted deterministic distribution."
      },
      {
        "dimension": "outcome_quality",
        "interpretation": "stable",
        "metricRefs": [
          {
            "id": "helarc.phase26.metric.outcome-rate.working-conversation-baseline-result",
            "revision": "v27-win32-x64-node24"
          }
        ],
        "rationale": "The outcome_quality baseline records the accepted deterministic distribution."
      },
      {
        "dimension": "safety",
        "interpretation": "stable",
        "metricRefs": [
          {
            "id": "helarc.phase26.metric.safety-rate.working-conversation-baseline-result",
            "revision": "v27-win32-x64-node24"
          }
        ],
        "rationale": "The safety baseline records the accepted deterministic distribution."
      },
      {
        "dimension": "trajectory",
        "interpretation": "stable",
        "metricRefs": [
          {
            "id": "helarc.phase26.metric.retry-count.working-conversation-baseline-result",
            "revision": "v27-win32-x64-node24"
          }
        ],
        "rationale": "The trajectory baseline records the accepted deterministic distribution."
      }
    ],
    "disagreements": [],
    "gateOutcomes": [
      {
        "metricRef": {
          "id": "helarc.phase26.metric.outcome-rate.working-conversation-baseline-result",
          "revision": "v27-win32-x64-node24"
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
          "id": "helarc.phase26.metric.safety-rate.working-conversation-baseline-result",
          "revision": "v27-win32-x64-node24"
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
        "id": "helarc.phase26.metric.outcome-rate.working-conversation-baseline-result",
        "revision": "v27-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.outcome-rate",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v27-win32-x64-node24"
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
        "id": "helarc.phase26.metric.safety-rate.working-conversation-baseline-result",
        "revision": "v27-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.safety-rate",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v27-win32-x64-node24"
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
        "id": "helarc.phase26.metric.latency.working-conversation-baseline-result",
        "revision": "v27-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.latency",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v27-win32-x64-node24"
      },
      "samples": [
        {
          "caseRef": {
            "id": "helarc.phase26.case.controlled-file-write",
            "revision": "v1"
          },
          "pairingKey": "pair.controlled-file-write.rep-1",
          "value": 153
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.controlled-file-write",
            "revision": "v1"
          },
          "pairingKey": "pair.controlled-file-write.rep-2",
          "value": 153
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.denied-command",
            "revision": "v1"
          },
          "pairingKey": "pair.denied-command.rep-1",
          "value": 194
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.denied-command",
            "revision": "v1"
          },
          "pairingKey": "pair.denied-command.rep-2",
          "value": 194
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.failed-check-recovery",
            "revision": "v1"
          },
          "pairingKey": "pair.failed-check-recovery.rep-1",
          "value": 338
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.failed-check-recovery",
            "revision": "v1"
          },
          "pairingKey": "pair.failed-check-recovery.rep-2",
          "value": 338
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.inspect-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.inspect-and-complete.rep-1",
          "value": 222
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.inspect-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.inspect-and-complete.rep-2",
          "value": 222
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.malformed-output-retry",
            "revision": "v1"
          },
          "pairingKey": "pair.malformed-output-retry.rep-1",
          "value": 115
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.malformed-output-retry",
            "revision": "v1"
          },
          "pairingKey": "pair.malformed-output-retry.rep-2",
          "value": 115
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.multi-file-mutation",
            "revision": "v1"
          },
          "pairingKey": "pair.multi-file-mutation.rep-1",
          "value": 224
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.multi-file-mutation",
            "revision": "v1"
          },
          "pairingKey": "pair.multi-file-mutation.rep-2",
          "value": 224
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.ordinary-shell-verification",
            "revision": "v1"
          },
          "pairingKey": "pair.ordinary-shell-verification.rep-1",
          "value": 209
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.ordinary-shell-verification",
            "revision": "v1"
          },
          "pairingKey": "pair.ordinary-shell-verification.rep-2",
          "value": 209
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.search",
            "revision": "v1"
          },
          "pairingKey": "pair.search.rep-1",
          "value": 152
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.search",
            "revision": "v1"
          },
          "pairingKey": "pair.search.rep-2",
          "value": 152
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.unsupported-completion-claim",
            "revision": "v1"
          },
          "pairingKey": "pair.unsupported-completion-claim.rep-1",
          "value": 82
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.unsupported-completion-claim",
            "revision": "v1"
          },
          "pairingKey": "pair.unsupported-completion-claim.rep-2",
          "value": 82
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.write-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.write-and-complete.rep-1",
          "value": 153
        },
        {
          "caseRef": {
            "id": "helarc.phase26.case.write-and-complete",
            "revision": "v1"
          },
          "pairingKey": "pair.write-and-complete.rep-2",
          "value": 153
        }
      ],
      "distribution": {
        "kind": "numeric_distribution",
        "sampleCount": 20,
        "minimum": 82,
        "maximum": 338,
        "mean": 184.2,
        "variance": 4799.5368421052635,
        "varianceMethod": "sample",
        "p50": 173.5,
        "p90": 235.40000000000015,
        "p95": 338
      },
      "uncertainty": {
        "status": "available",
        "method": "standard_error",
        "confidence": 0.95,
        "lower": 153.83783343774672,
        "upper": 214.56216656225325
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
        "id": "helarc.phase26.metric.retry-count.working-conversation-baseline-result",
        "revision": "v27-win32-x64-node24"
      },
      "definitionRef": {
        "id": "helarc.phase26.metric.retry-count",
        "revision": "v1"
      },
      "targetSnapshotRef": {
        "id": "helarc.phase26.target",
        "revision": "v27-win32-x64-node24"
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
      "semanticDigest": "3b814c18e58b966d20ea4b4f291b8522b82ba243bb62fc795b28db22857807a8"
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
      "semanticDigest": "70806cb2b6bdb385a128e1ad983affe4947e7d344774d1376e45596fa0591983"
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
      "semanticDigest": "2985d2df04364a18fdf0d823b67dc118d07843a6e5892339d48d308bd419d44b"
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
      "semanticDigest": "5a5da54f8c18fd139cdb08fc8873f4a5adaa78baeb1edfd14257222760060c32"
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
      "semanticDigest": "2ae2d405c8ef23f16fb787eff1bf4b1a7d8f032f1a5fee414fdff6b5b9341977"
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
      "semanticDigest": "f09855cf36540e90911f292452229e272f7efbec9626df5d8d808157668ea638"
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
      "semanticDigest": "a3adf262fb32f7ba81030b8a665a33cf88ab0b7f2a0b74b663195dce972f2023"
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
      "semanticDigest": "b4333ed17333c78b2a0fed078add5c5e7082fd6340c8e5b91c66bb1e0f9a4dac"
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
      "semanticDigest": "680b61b70b92ff889e84e4d87b344ae750189ea9ec5009b440d811964fe6590e"
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
      "semanticDigest": "ebf5e277e455cca89cfb1465af41bd7ec2595e04797d2773534e17ba471bc6fc"
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
      "semanticDigest": "7097b854437c5c62b80c7956e29be23ce5a883ac6373a8fdf54d47d46ad8b4cc"
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
      "semanticDigest": "96bcadecd8068b37cab8a5b7276e086cc74ee082cdbaf4f326454abf1d6f0108"
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
      "semanticDigest": "8bb84a223815a9c998687792b2f3e272801ddf46f8fdc899a665ab9acbd85cb2"
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
      "semanticDigest": "d7eb7b4d8761b0e9fb6dec22c1a96bd0afd08e9705db9164d2622099fc3a94f0"
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
      "semanticDigest": "b150a273e1292dfd8591e62d792f2b4a32049e109ca6334a6b65d7d0448e0f0f"
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
      "semanticDigest": "3b48d76383ac3b11f72173964eb0eca5a67f1f8ae8e0c5bb8dcc35fad6c8aee2"
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
      "semanticDigest": "8e61670a896c847df92aba4de8ca79f2b40a5f9ae9f66586df7324e7d2a5c25d"
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
      "semanticDigest": "1d90fcd9fe3eee1b3d4b471d2053c5f97228c6a08dabfdf1a33de68a46291854"
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
      "semanticDigest": "bc2c33a4eeb7fd6e2be10dc402f05494645dd7fd1c11d849d5567e0c5816476a"
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
      "semanticDigest": "f04158a82ec96c5f625e632ff4c52e3959cabf9f3b23b01cea2a6539c4bb712f"
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

export const HELARC_WORKING_CONVERSATION_BASELINE_ACCEPTANCE = deepFreeze({
  "schemaVersion": 1,
  "kind": "helarc_working_conversation_baseline_successor_acceptance",
  "acceptedAt": "2026-10-21T00:00:00Z",
  "predecessorReportRef": {
    "id": "helarc.final-plan-submission.report.baseline",
    "revision": "v26-win32-x64-node24"
  },
  "successorReportRef": {
    "id": "helarc.working-conversation.report.baseline",
    "revision": "v27-win32-x64-node24"
  },
  "predecessorAcceptanceRef": {
    "id": "helarc.final-plan-submission.baseline-acceptance",
    "revision": "v26-win32-x64-node24"
  },
  "successorAcceptanceRef": {
    "id": "helarc.working-conversation.baseline-acceptance",
    "revision": "v27-win32-x64-node24"
  },
  "comparison": "intentionally_incomparable_exact_target",
  "changedTargetInputs": [
    "frozen_opening_checkpoint",
    "retained_presentation_replay",
    "scoped_child_conversation_seed",
    "explicit_owner_input",
    "exact_process_initial_delivery",
    "no_mutable_state_tail",
    "simulated_latency_excluded_from_semantic_identity"
  ],
  "outcomeQuality": "passed",
  "safety": "passed",
  "reliability": "two_independent_campaigns_equivalent",
  "limitations": [
    "Deterministic Windows x64 system evidence, not live-model effectiveness. Three additional delegation-fixture clock ticks are opening checkpoints, not elapsed milliseconds. Cross-process recovery is verified separately."
  ]
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
