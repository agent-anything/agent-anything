import type { HelarcInstructionSectionSetting } from "./HelarcProtocolInstructions.js";

export const HELARC_DEFAULT_STOP_INSTRUCTIONS: readonly HelarcInstructionSectionSetting[] = Object.freeze([
  Object.freeze({
    id: "stop_instructions",
    enabled: false,
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
      "Assess the current evidence afresh; an earlier fulfilled assessment does not prevent a later incomplete or uncertain assessment when new evidence warrants it.",
      "Decide separately whether useful actionable work remains before this processing can end.",
      "Return disposition continue only when you can identify such work; explain that next work in rationale.",
      "A fulfilled task may still need concrete follow-up before ending; report fulfilled with disposition continue in that case, without inventing missing outcomes or unsupported claims.",
      "Return disposition allow when no useful next action remains and the Agent either fulfills the task or honestly explains its limitations.",
      "Incomplete or uncertain fulfillment alone is not a reason to demand another turn.",
      "Do not infer that a file changed or a command ran from the proposal text alone.",
    ].join("\n"),
  }),
]);
