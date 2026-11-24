const assert=require("node:assert/strict");
// Admit through the real coordinator; this component test never activates task decisions.
async function admitComponentRun(store,directory,runId="root"){
  const existing=await store.readLatestRun(runId);
  if(existing)return existing;
  const {RunExecutionCoordinator}=await import("@agent-anything/agent-runtime/execution-coordinator");
  const {createAgentInstructions}=await import("@agent-anything/agent-core/agent");
  const {createOperationDefinitionCatalog}=await import("@agent-anything/operation-catalog/catalog");
  const {createOperationBindingResolverSnapshot}=await import("@agent-anything/operation-catalog/binding");
  const {createOperationResultContracts}=await import("@agent-anything/operation-catalog/result");
  const {createToolRegistrationSnapshot}=await import("@agent-anything/tools/registration");
  const {createFixedLocalToolSelection}=await import("@agent-anything/tools/selection");
  const {createInteractionProtocolRegistrySnapshot}=await import("@agent-anything/interaction/coordination");
  const {resolvePermissionProfile}=await import("@agent-anything/permission");
  const {createTestContextProjection}=await import("@agent-anything/test-support");
  const catalog=createOperationDefinitionCatalog({id:"empty",revision:"1",entries:[]});
  const operations={catalog,bindings:createOperationBindingResolverSnapshot("empty",[]),
    toolInputSemanticValidators:[],resultContracts:createOperationResultContracts(catalog,[]),internalHandlers:[],availability:[]};
  const agent={id:"agent",revision:"1",name:"Component fixture owner",metadata:{},
    instructions:createAgentInstructions({id:"empty",release:{id:"empty",revision:"1"},
      model:{providerId:"fixture",modelId:"fixture"},resolverRevision:"1",blocks:[]}),
    output:{validate:output=>({valid:true,output})}};
  const managedConstraints={constraintSetId:"fixture",selectableProfiles:{allowedProfileIds:null,deniedProfileIds:[]},
    fileSystem:[],network:{enabled:null,allowedDomains:[],deniedDomains:[]},allowUnenforcedExecution:true};
  const retry={maxRetries:0,delay:{kind:"exponential_jitter",baseDelayMs:0,maxDelayMs:0,multiplier:2,jitterRatio:0.1},
    retryableCategories:[],serverDelay:{mode:"ignore"}};
  const config={workspace:{primary:{id:"workspace",name:"Fixture",rootRef:directory,trustState:"trusted",source:"test",policyRefs:[],metadata:{}},additional:[]},
    identity:{id:"fixture",kind:"user",displayName:"Fixture",metadata:{}},
    permissions:{permissionProfile:resolvePermissionProfile({profileId:":read-only",profiles:[],
      environment:{environmentId:"fixture",platform:"win32",workspaceRoots:[{rootId:"workspace",path:directory}]},managedConstraints}),
      approvalPolicy:"never",reviewer:null,rules:[],networkRules:[],managedConstraints,sessionAuthority:null,
      persistentPolicyAmendments:null,authorityApplicationLimits:{commitTimeoutMs:1000}},
    tools:createFixedLocalToolSelection(createToolRegistrationSnapshot(catalog,[]),catalog,[]),actionExecution:null,
    limits:{maxIterations:8,maxActions:8,maxConsecutiveActionFailures:3,maxDurationMs:300000,maxPendingInteractions:4,
      plan:{maxSteps:8,maxStepLength:200,maxExplanationLength:500}},
    runTreeLimits:{maxTotalDescendantRuns:0,maxActiveDescendantRuns:0,maxDescendantDepth:0},
    runTreeResources:Object.fromEntries(["controllerTurns","actions","modelInputTokens","modelOutputTokens","costUnits","contextBytes","resultBytes"]
      .map(key=>[key,{maximum:key==="controllerTurns"||key==="actions"?32:8000000,minimumChildGrant:1,enforcement:"hard"}])),
    runTreeApprovals:{maxTotalRequests:4,maxRequestsPerOperationFingerprint:2,maxConsecutiveDeclines:2,maxConsecutiveReviewerFailures:2,maxActiveReviews:2},
    audit:"optional",telemetry:"optional",cancellationLimits:{operationSettlementTimeoutMs:1000,processGracePeriodMs:100,
      processForceKillTimeoutMs:500,finalizationTimeoutMs:1000},retry:{providerRequest:retry,structuredOutput:retry,action:{maxAttempts:1}},metadata:{}};
  const now=()=>new Date().toISOString();
  const runner=new RunExecutionCoordinator({taskDecisions:{
    resourceMetering:{modelInputTokens:"not_applicable",modelOutputTokens:"not_applicable",costUnits:"not_applicable"},
    next:async()=>{throw new Error("Task decisions are outside this admission-only component fixture");}},
    operations,contextProjection:createTestContextProjection(),createRunId:()=>runId,now,runTreeCommits:store,
    interactions:createInteractionProtocolRegistrySnapshot("empty",[])});
  await runner.admit(agent,{task:{id:"task",kind:"fixture",input:{},createdAt:now(),metadata:{}},
    items:[{id:"assignment",kind:"message",role:"user",content:"Keep the selected blue option and the completed command.",createdAt:now(),metadata:{}}],metadata:{}},config);
  const retained=await store.readLatestRun(runId);assert.equal(retained.state.settlement,null);assert.equal(retained.control.cancellation,null);
  return retained;
}
async function commitComponentRun(store,commit){
  const retained=await store.readRunTree(commit.state.run.id);
  assert(retained,"Component Run must have an original coordinated admission");
  const previous=retained.commit,revision=previous.revision+1;
  return store.commitRunTree({...previous,id:`${commit.state.run.id}:tree_commit:${revision}`,
    expectedRevision:previous.revision,revision,runs:[commit]});
}
module.exports={admitComponentRun,commitComponentRun};

