import type { ToolDefinition } from "../ToolDefinition.js";
import type { ToolAdapter } from "./ToolAdapter.js";

export class ToolAdapterRegistry {
  private readonly adapters = new Map<string, ToolAdapter>();

  register(adapter: ToolAdapter): void {
    if (adapter.name.trim().length === 0) {
      throw new Error("Tool adapter name must not be empty.");
    }

    if (this.adapters.has(adapter.name)) {
      throw new Error(`Tool adapter is already registered: ${adapter.name}`);
    }

    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): ToolAdapter | undefined {
    return this.adapters.get(name);
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  list(): ToolAdapter[] {
    return [...this.adapters.values()];
  }

  toToolDefinitions(): ToolDefinition[] {
    return this.list().map((adapter) => adapter.toToolDefinition());
  }
}
