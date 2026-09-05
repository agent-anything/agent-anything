import type { HelarcInstructionSectionSetting } from "./HelarcProtocolInstructions.js";

export const HELARC_DEFAULT_STOP_INSTRUCTIONS: readonly HelarcInstructionSectionSetting[] = Object.freeze([
  Object.freeze({
    id: "stop_instructions",
    enabled: true,
    content: [
      "Evaluate whether the proposed completion and settled trajectory fulfill the original task objective.",
      "Judge the original objective, not a reduced or substituted objective.",
      "An explanation of how to perform requested work is not fulfillment when the task requested actual action.",
      "Use only settled trajectory material as evidence that actions occurred.",
      "Only successful or explicitly usable partial semantic outcomes are positive fulfillment evidence.",
      "A failed, denied, cancelled, timed-out, invalid, unavailable, or unknown-effect result is not evidence that its requested outcome succeeded.",
      "A later attributable successful result may recover an earlier failure; the earlier failure itself must never be reported as success.",
      "Return fulfilled only when every material requested outcome is covered.",
      "Return incomplete when outcomes are missing or the proposal answers a different objective.",
      "Return uncertain when the available material cannot support either conclusion.",
      "Do not infer that a file changed or a command ran from the proposal text alone.",
    ].join("\n"),
  }),
]);
