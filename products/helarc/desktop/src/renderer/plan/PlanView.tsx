import * as React from "react";
import { useId, useState } from "react";
import { Check, ChevronDown, ChevronUp, Circle, Play } from "lucide-react";
import type { HelarcPresentationValue } from "../../shared/HelarcWorkbench.js";

interface PlanStep {
  readonly step: string;
  readonly status: "pending" | "in_progress" | "completed";
}

function stepsOf(value: HelarcPresentationValue): PlanStep[] {
  return (value as { steps?: PlanStep[] } | null)?.steps ?? [];
}

function PlanSteps({ steps }: { steps: PlanStep[] }) {
  return (
    <ol className="wb-plan">
      {steps.map((step, i) => (
        <li key={i} className={step.status}>
          {step.status === "completed" ? (
            <Check size={15} />
          ) : step.status === "in_progress" ? (
            <Play size={15} />
          ) : (
            <Circle size={13} />
          )}
          <span>
            {step.step}
            <small>{step.status.replaceAll("_", " ")}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ConversationPlan({ value }: { value: HelarcPresentationValue }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const steps = stepsOf(value);
  if (!steps.length) return null;
  const completed = steps.filter((step) => step.status === "completed").length;
  const current = steps.find((step) => step.status === "in_progress");
  const currentText = current?.step;
  return (
    <section className="wb-conversation-plan" aria-label="Plan">
      <div className="wb-plan-body">
        <div className="wb-plan-summary">
          <span className="wb-plan-heading">
            <strong>Plan</strong>
            <span className="wb-plan-count">
              {completed}/{steps.length}
            </span>
          </span>
          {currentText && (
            <span className="wb-plan-current" title={currentText}>
              {currentText}
            </span>
          )}
        </div>
        <div id={contentId} className="wb-plan-steps" hidden={!open}>
          <PlanSteps steps={steps} />
        </div>
      </div>
      <button type="button" className="wb-conversation-disclosure" aria-expanded={open} aria-controls={contentId}
        aria-label={open ? "Collapse Plan" : "Expand Plan"} title={open ? "Collapse Plan" : "Expand Plan"}
        onClick={() => setOpen(value => !value)}>
        {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      </button>
    </section>
  );
}

export function PlanView({ value }: { value: HelarcPresentationValue }) {
  const steps = stepsOf(value);
  const [showCompleted, setShowCompleted] = useState(false);
  if (!steps.length) return null;
  const completed = steps.filter((step) => step.status === "completed").length;
  return (
    <section className="wb-section">
      <h3>
        Plan <span>{completed} of {steps.length}</span>
      </h3>
      <PlanSteps
        steps={steps.filter((step) =>
          steps.length <= 6 || showCompleted || step.status !== "completed",
        )}
      />
      {steps.length > 6 && completed > 0 && (
        <button
          className="wb-link"
          onClick={() => setShowCompleted((value) => !value)}
        >
          {showCompleted ? "Hide" : "Show"} completed steps
        </button>
      )}
    </section>
  );
}
