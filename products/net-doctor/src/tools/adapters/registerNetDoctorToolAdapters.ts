import {
  ToolAdapterRegistry,
  type ToolRegistry,
} from "@agent-anything/platform";
import { createNetDoctorToolAdapters } from "./createNetDoctorToolAdapters.js";

export function registerNetDoctorToolAdapters(toolRegistry: ToolRegistry): ToolAdapterRegistry {
  const adapterRegistry = new ToolAdapterRegistry();

  for (const adapter of createNetDoctorToolAdapters()) {
    adapterRegistry.register(adapter);
  }

  for (const definition of adapterRegistry.toToolDefinitions()) {
    toolRegistry.register(definition);
  }

  return adapterRegistry;
}
