import type { ISODateTimeString } from "@agent-anything/shared";

export type PolicyAmendmentEffect = "allow" | "forbidden";

export interface ExecPolicyAmendment {
  readonly amendmentId: string;
  readonly environmentId: string;
  readonly commandPattern: readonly [string, ...string[]];
  readonly cwd: string | null;
  readonly effect: PolicyAmendmentEffect;
  readonly sourceFingerprint: string;
}

export interface NetworkPolicyAmendment {
  readonly amendmentId: string;
  readonly environmentId: string;
  readonly hostPattern: string;
  readonly ports: readonly number[];
  readonly protocols: readonly string[];
  readonly effect: PolicyAmendmentEffect;
  readonly sourceFingerprint: string;
}

export type TrustedPolicyAmendment =
  | {
      readonly kind: "exec_policy";
      readonly amendment: ExecPolicyAmendment;
    }
  | {
      readonly kind: "network_policy";
      readonly amendment: NetworkPolicyAmendment;
    };

export interface AppliedPolicyAmendmentRecord {
  readonly id: string;
  readonly proposalRef: string;
  readonly sourceRequestId: string;
  readonly sourceActionFingerprint: string;
  readonly amendment: TrustedPolicyAmendment;
  readonly appliedAt: ISODateTimeString;
}
