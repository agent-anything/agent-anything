import type {HelarcContextSettingsSnapshot as CoreSnapshot} from "@agent-anything/helarc/configuration";
import type {HelarcContextSettingsSnapshot} from "../../shared/HelarcContextSettings.js";

/** Project validated configuration without expanding the IPC surface or changing its revision. */
export function projectHelarcContextSettings(snapshot:CoreSnapshot):HelarcContextSettingsSnapshot {
  return Object.freeze({revision:snapshot.revision,settings:Object.freeze({
    autoRepresentation:snapshot.settings.autoRepresentation,
    observations:Object.freeze(snapshot.settings.observations.map(observation=>{
      const {target}=observation;
      const projected="kind" in target?Object.freeze({kind:target.kind,configuration:Object.freeze({id:target.configuration.id,revision:target.configuration.revision}),
        protocol:Object.freeze({id:target.protocol.id,revision:target.protocol.revision}),model:target.model,semanticRevision:target.semanticRevision,artifact:target.artifact}):
        Object.freeze({profileId:target.profileId,providerKind:target.providerKind,baseUrl:target.baseUrl,model:target.model,
          modelSettings:Object.freeze({service:target.modelSettings.service,thinking:Object.freeze({mode:target.modelSettings.thinking.mode,
            ...(target.modelSettings.thinking.mode==="enabled"&&target.modelSettings.thinking.effort!==undefined?{effort:target.modelSettings.thinking.effort}:{})})}),
          contextWindowTokens:target.contextWindowTokens,artifact:target.artifact});
      return Object.freeze({
        id:observation.id,revision:observation.revision,
        target:projected,
        duty:observation.duty,
        method:observation.method===null?null:Object.freeze({id:observation.method.id,revision:observation.method.revision}),
        protocol:observation.protocol,conclusion:observation.conclusion,dimensions:Object.freeze([...observation.dimensions]),
        conditions:observation.conditions,finding:observation.finding,source:observation.source,
        limitations:observation.limitations,observedAt:observation.observedAt,
      });
    })),
  })});
}
