import "@xyflow/react/dist/style.css";

import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import {
  type ClientOrchestrationCommand,
  CommandId,
  type EnvironmentId,
  type ProjectId,
  ThreadId,
  type WorkflowDefinition,
  WorkflowEdgeId,
  WorkflowId,
  type WorkflowNodeDefinition,
  WorkflowNodeId,
  WorkflowRunId,
  type WorkflowRun,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { readEnvironmentConnection } from "~/environments/runtime";
import {
  selectProjectByRef,
  selectThreadByRef,
  selectWorkflowRunsByWorkflow,
  selectWorkflowsByEnvironment,
  useStore,
} from "~/store";
import { cn } from "~/lib/utils";

function id(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function makeStarterWorkflow(input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly defaultModelSelection: WorkflowDefinition["defaultModelSelection"];
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

function latestRunForWorkflow(runs: WorkflowRun[]): WorkflowRun | null {
  return runs.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

export function OrchestrationPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly mode: "sidebar" | "sheet";
}) {
  const thread = useStore((state) =>
    selectThreadByRef(state, { environmentId: props.environmentId, threadId: props.threadId }),
  );
  const project = useStore((state) =>
    thread
      ? selectProjectByRef(state, {
          environmentId: props.environmentId,
          projectId: thread.projectId,
        })
      : undefined,
  );
  const workflows = useStore((state) => selectWorkflowsByEnvironment(state, props.environmentId));
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const workflow =
    workflows.find((entry) => entry.id === selectedWorkflowId) ?? workflows[0] ?? null;
  const runs = useStore((state) =>
    selectWorkflowRunsByWorkflow(state, props.environmentId, workflow?.id ?? null),
  );
  const latestRun = latestRunForWorkflow(runs);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const selectedNode = workflow?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const [goal, setGoal] = useState("");

  const graph = useMemo(() => {
    const nodeRuns = new Map(latestRun?.nodeRuns.map((run) => [run.nodeId, run]) ?? []);
    const nodes: Node[] =
      workflow?.nodes.map((node) => {
        const run = nodeRuns.get(node.id);
        return {
          id: node.id,
          position: node.position,
          data: {
            label: (
              <div className="min-w-36">
                <div className="text-xs uppercase text-muted-foreground">{node.kind}</div>
                <div className="font-medium">{node.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">{run?.status ?? "not run"}</div>
              </div>
            ),
          },
          className: cn(
            "rounded-lg border bg-card p-2 text-card-foreground shadow-sm",
            run?.status === "running" && "border-primary shadow-primary/30",
            run?.status === "failed" && "border-destructive",
            run?.status === "completed" && "border-emerald-500",
          ),
        };
      }) ?? [];
    const edges: Edge[] =
      workflow?.edges.map((edge) => ({
        id: edge.id,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        label: edge.condition,
        animated: latestRun?.status === "running",
      })) ?? [];
    return { nodes, edges };
  }, [latestRun, workflow]);

  const dispatch = async (command: ClientOrchestrationCommand) => {
    const connection = readEnvironmentConnection(props.environmentId);
    if (!connection) return;
    await connection.client.orchestration.dispatchCommand(command);
  };

  const createWorkflow = async () => {
    if (!project) return;
    const now = new Date().toISOString();
    const workflow = makeStarterWorkflow({
      projectId: project.id,
      title: "Goal loop",
      defaultModelSelection: project.defaultModelSelection,
    });
    await dispatch({
      type: "workflow.create",
      commandId: CommandId.make(id("client:workflow-create")),
      workflow,
      createdAt: now,
    });
    setSelectedWorkflowId(workflow.id);
  };

  const runWorkflow = async () => {
    if (!workflow) return;
    const now = new Date().toISOString();
    await dispatch({
      type: "workflow.run.start",
      commandId: CommandId.make(id("client:workflow-run-start")),
      workflowRunId: WorkflowRunId.make(id("workflow-run")),
      workflowId: workflow.id,
      goal: goal.trim() || thread?.messages.at(-1)?.text || workflow.title,
      inputs: {},
      createdAt: now,
    });
  };

  const stopRun = async () => {
    if (!latestRun) return;
    await dispatch({
      type: "workflow.run.stop",
      commandId: CommandId.make(id("client:workflow-run-stop")),
      workflowRunId: latestRun.id,
      updatedAt: new Date().toISOString(),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">Orchestration</h2>
            <p className="text-xs text-muted-foreground">Visual workflow editor and run monitor</p>
          </div>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
            onClick={createWorkflow}
          >
            New
          </button>
        </div>
        <div className="mt-3 flex gap-2">
          <select
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={workflow?.id ?? ""}
            onChange={(event) => setSelectedWorkflowId(event.target.value || null)}
          >
            {workflows.length === 0 ? <option value="">No workflows</option> : null}
            {workflows.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
            onClick={runWorkflow}
            disabled={!workflow}
          >
            Run
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1 text-sm disabled:opacity-50"
            onClick={stopRun}
            disabled={!latestRun || latestRun.status !== "running"}
          >
            Stop
          </button>
        </div>
        <textarea
          className="mt-2 h-16 w-full resize-none rounded-md border border-border bg-background p-2 text-sm"
          placeholder="Goal or workflow input..."
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1">
        {workflow ? (
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            fitView
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
          >
            <Background />
            <Controls />
            {props.mode === "sidebar" ? <MiniMap pannable zoomable /> : null}
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Create a workflow to start arranging agents.
          </div>
        )}
      </div>
      <div className="max-h-52 overflow-auto border-t border-border p-3 text-sm">
        {selectedNode ? (
          <div className="space-y-2">
            <div className="font-medium">{selectedNode.title}</div>
            <div className="text-xs uppercase text-muted-foreground">{selectedNode.kind}</div>
            <pre className="whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
              {selectedNode.config.promptTemplate || "(no prompt)"}
            </pre>
          </div>
        ) : (
          <div className="text-muted-foreground">
            {latestRun
              ? `Latest run: ${latestRun.status} with ${latestRun.nodeRuns.length} node runs`
              : "Select a node to inspect its prompt and run state."}
          </div>
        )}
      </div>
    </div>
  );
}

export default OrchestrationPanel;
