export interface NetDoctorToolInput {
  target: string;
  host: string;
  port: number | null;
  protocol: string | null;
  symptom: string;
}

export interface DnsLookupOutput {
  host: string;
  addresses: Array<{
    address: string;
    family: number;
  }>;
}

export interface TcpConnectOutput {
  host: string;
  port: number;
  reachable: boolean;
  timeoutMs: number;
}

export interface HttpReachabilityOutput {
  url: string;
  reachable: boolean;
  statusCode: number | null;
  statusMessage: string | null;
  timeoutMs: number;
}

export interface ProxyConfigOutput {
  hasProxy: boolean;
  variables: Array<{
    name: string;
    configured: boolean;
  }>;
}
