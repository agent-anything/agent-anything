export interface NetDoctorInput {
  target: NormalizedTarget;
  symptom: string;
}

export interface NormalizedTarget {
  raw: string;
  host: string;
  port: number | null;
  protocol: string | null;
  normalized: string;
}
