import type {
  ToolAdapter,
  ToolDefinition,
} from "@agent-anything/platform";

export class NetDoctorToolDefinitionAdapter implements ToolAdapter {
  readonly name: string;

  constructor(
    private readonly toolDefinition: ToolDefinition,
  ) {
    this.name = toolDefinition.name;
  }

  toToolDefinition(): ToolDefinition {
    return {
      ...this.toolDefinition,
      metadata: {
        ...this.toolDefinition.metadata,
        adapter: "net-doctor-tool-definition",
        product: "net-doctor",
      },
    };
  }
}
