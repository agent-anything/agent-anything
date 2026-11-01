module.exports=async function taskRunnerConfig(directory,registration,contextAccess=[]) {
  const {createOperationDefinitionCatalog}=await import("@agent-anything/operation-catalog/catalog");
  const {createOperationBindingResolverSnapshot}=await import("@agent-anything/operation-catalog/binding");
  const {createOperationResultContracts}=await import("@agent-anything/operation-catalog/result");
  const {createFixedLocalToolSelection}=await import("@agent-anything/tools/selection");
  const {resolvePermissionProfile}=await import("@agent-anything/permission");
  const catalog=createOperationDefinitionCatalog({id:"empty",revision:"1",entries:contextAccess.map(value=>value.operation)});
  const operations={catalog,bindings:createOperationBindingResolverSnapshot("empty",contextAccess.map(value=>value.resolver)),toolInputSemanticValidators:[],
    resultContracts:createOperationResultContracts(catalog,contextAccess.map(value=>value.contract)),internalHandlers:contextAccess.map(value=>value.handler),
    availability:contextAccess.map(value=>({binding:value.operation.binding.ref,assess:()=>({basisRefs:[{owner:value.operation.operation.semanticOwner,
      kind:"static_operation_path",id:value.operation.operation.ref.operation.name,revision:value.operation.binding.ref.revision}],disposition:"available",reason:null})}))};
  const managedConstraints={constraintSetId:"fixture",selectableProfiles:{allowedProfileIds:null,deniedProfileIds:[]},
    fileSystem:[],network:{enabled:null,allowedDomains:[],deniedDomains:[]},allowUnenforcedExecution:true};
  const retry={maxRetries:0,delay:{kind:"exponential_jitter",baseDelayMs:0,maxDelayMs:0,multiplier:2,jitterRatio:0.1},
    retryableCategories:[],serverDelay:{mode:"ignore"}};
  const config={workspace:{primary:{id:"workspace",name:"Fixture",rootRef:directory,trustState:"trusted",source:"test",policyRefs:[],metadata:{}},additional:[]},
    identity:{id:"fixture",kind:"user",displayName:"Fixture",metadata:{}},
    permissions:{permissionProfile:resolvePermissionProfile({profileId:":read-only",profiles:[],environment:{environmentId:"fixture",platform:"win32",workspaceRoots:[{rootId:"workspace",path:directory}]},managedConstraints}),
      approvalPolicy:"never",reviewer:null,rules:[],networkRules:[],managedConstraints,sessionAuthority:null,persistentPolicyAmendments:null,authorityApplicationLimits:{commitTimeoutMs:1000}},
    tools:createFixedLocalToolSelection(registration,catalog,[]),actionExecution:null,
    limits:{maxIterations:8,maxActions:8,maxConsecutiveActionFailures:3,maxDurationMs:300000,maxPendingInteractions:4,plan:{maxSteps:8,maxStepLength:500,maxExplanationLength:2000}},
    runTreeLimits:{maxTotalDescendantRuns:0,maxActiveDescendantRuns:0,maxDescendantDepth:0},
    runTreeResources:Object.fromEntries(["controllerTurns","actions","modelInputTokens","modelOutputTokens","costUnits","contextBytes","resultBytes"]
      .map(key=>[key,["modelInputTokens","modelOutputTokens","costUnits"].includes(key)?{threshold:8000000,enforcement:"observational"}:
        {maximum:key==="controllerTurns"||key==="actions"?32:8000000,minimumChildGrant:1,enforcement:"hard"}])),
    runTreeApprovals:{maxTotalRequests:4,maxRequestsPerOperationFingerprint:2,maxConsecutiveDeclines:2,maxConsecutiveReviewerFailures:2,maxActiveReviews:2},
    audit:"optional",telemetry:"optional",cancellationLimits:{operationSettlementTimeoutMs:5000,processGracePeriodMs:100,processForceKillTimeoutMs:500,finalizationTimeoutMs:1000},
    retry:{providerRequest:retry,structuredOutput:retry,action:{maxAttempts:1}},metadata:{}};
  return {operations,config};
};
