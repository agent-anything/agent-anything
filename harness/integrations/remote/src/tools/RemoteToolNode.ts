

export interface RemoteToolNode {
  id: string;
  name: string;
  capabilities: string[];
  metadata: Readonly<Record<string, unknown>>;
}
