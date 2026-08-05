export type PlanUpdateOutcome =
  | {
      readonly status: "applied";
      readonly transition: "created" | "updated" | "completed" | "reactivated";
      readonly planId: string;
      readonly version: number;
    }
  | {
      readonly status: "no_change";
      readonly planId: string;
      readonly version: number;
    }
  | {
      readonly status: "rejected";
      readonly code: "plan_invalid" | "plan_limit_exceeded";
      readonly message: string;
    };
