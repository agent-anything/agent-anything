import * as React from "react";
import { useState } from "react";
import { Check, ChevronRight, Circle, Play } from "lucide-react";
import type { HelarcPresentationValue } from "../../shared/HelarcWorkbench.js";

interface PlanStep {
  description?: string;
  title?: string;
  status?: string;
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
            {step.description ?? step.title}
            <small>{step.status?.replaceAll("_", " ")}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ConversationPlan({ value }: { value: HelarcPresentationValue }) {
  const steps = stepsOf(value);
  if (!steps.length) return null;
  const completed = steps.filter((step) => step.status === "completed").length;
  const current = steps.find((step) => step.status === "in_progress");
  const currentText = current?.description ?? current?.title;
  return (
    <details className="wb-conversation-plan">
      <summary>
        <ChevronRight size={15} className="wb-plan-chevron" />
        <strong>Plan</strong>
        <span className="wb-plan-count">
          {completed}/{steps.length}
        </span>
        {currentText && (
          <span className="wb-plan-current" title={currentText}>
            {currentText}
          </span>
        )}
      </summary>
      <div className="wb-plan-steps">
        <PlanSteps steps={steps} />
      </div>
    </details>
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
