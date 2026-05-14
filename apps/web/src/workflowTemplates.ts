import {
  type ModelSelection,
  type ProjectId,
  type WorkflowDefinition,
  WorkflowEdgeId,
  WorkflowId,
  type WorkflowNodeDefinition,
  WorkflowNodeId,
} from "@t3tools/contracts";

function id(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function makeStarterWorkflow(input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly defaultModelSelection: ModelSelection | null;
}): WorkflowDefinition {
  const now = new Date().toISOString();
  const planNodeId = WorkflowNodeId.make(id("workflow-node:plan"));
  const buildNodeId = WorkflowNodeId.make(id("workflow-node:build"));
  const reviewNodeId = WorkflowNodeId.make(id("workflow-node:review"));
  const summarizeNodeId = WorkflowNodeId.make(id("workflow-node:summarize"));
  const nodes: WorkflowNodeDefinition[] = [
    {
      id: planNodeId,
      kind: "agent",
      title: "Plan",
      position: { x: 0, y: 80 },
      config: {
        promptTemplate: "Create a concise plan to complete this goal:\n\n{{goal}}",
        modelSelection: null,
        runtimeMode: "full-access",
        interactionMode: "plan",
        inputBindings: {},
        retryPolicy: { maxAttempts: 0 },
      },
    },
    {
      id: buildNodeId,
      kind: "agent",
      title: "Build",
      position: { x: 280, y: 80 },
      config: {
        promptTemplate:
          "Implement the plan for this goal:\n\nGoal:\n{{goal}}\n\nPlan:\n{{Plan.output}}",
        modelSelection: null,
        runtimeMode: "full-access",
        interactionMode: "default",
        inputBindings: {},
        retryPolicy: { maxAttempts: 0 },
      },
    },
    {
      id: reviewNodeId,
      kind: "condition",
      title: "Check Completion",
      position: { x: 560, y: 80 },
      config: {
        promptTemplate:
          "Check whether the goal is fully complete. Return JSON with complete:boolean and summary:string.\n\n{{Build.output}}",
        modelSelection: null,
        runtimeMode: "full-access",
        interactionMode: "default",
        inputBindings: {},
        outputSchema: { type: "object", properties: { complete: { type: "boolean" } } },
        retryPolicy: { maxAttempts: 0 },
      },
    },
    {
      id: summarizeNodeId,
      kind: "agent",
      title: "Summarize",
      position: { x: 840, y: 80 },
      config: {
        promptTemplate: "Summarize the completed work for the user.\n\n{{Check Completion.output}}",
        modelSelection: null,
        runtimeMode: "full-access",
        interactionMode: "default",
        inputBindings: {},
        retryPolicy: { maxAttempts: 0 },
      },
    },
  ];

  return {
    id: WorkflowId.make(id("workflow")),
    projectId: input.projectId,
    title: input.title,
    description: "Goal loop starter workflow",
    defaultModelSelection: input.defaultModelSelection,
    nodes,
    edges: [
      {
        id: WorkflowEdgeId.make(id("workflow-edge")),
        sourceNodeId: planNodeId,
        targetNodeId: buildNodeId,
      },
      {
        id: WorkflowEdgeId.make(id("workflow-edge")),
        sourceNodeId: buildNodeId,
        targetNodeId: reviewNodeId,
      },
      {
        id: WorkflowEdgeId.make(id("workflow-edge")),
        sourceNodeId: reviewNodeId,
        targetNodeId: summarizeNodeId,
        condition: "complete === true",
      },
      {
        id: WorkflowEdgeId.make(id("workflow-edge")),
        sourceNodeId: reviewNodeId,
        targetNodeId: planNodeId,
        condition: "complete === false",
      },
    ],
    version: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}
