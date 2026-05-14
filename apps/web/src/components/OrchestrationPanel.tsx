import "@xyflow/react/dist/style.css";

import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import {
  type ClientOrchestrationCommand,
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  ThreadId,
  type WorkflowDefinition,
  WorkflowEdgeId,
  WorkflowId,
  type WorkflowNodeDefinition,
  WorkflowNodeId,
  WorkflowRunId,
  type WorkflowRun,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { readEnvironmentConnection } from "~/environments/runtime";
import { useSettings } from "~/hooks/useSettings";
import { getAppModelOptionsForInstance } from "~/modelSelection";
import { deriveProviderInstanceEntries, sortProviderInstanceEntries } from "~/providerInstances";
import { useServerProviders } from "~/rpc/serverState";
import { selectEnvironmentState, useStore } from "~/store";
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

function modelSelectionKey(selection: ModelSelection): string {
  return `${selection.instanceId}\u0000${selection.model}`;
}

function parseModelSelectionKey(value: string): ModelSelection | null {
  const separatorIndex = value.indexOf("\u0000");
  if (separatorIndex <= 0) return null;
  const instanceId = value.slice(0, separatorIndex) as ProviderInstanceId;
  const model = value.slice(separatorIndex + 1).trim();
  return model.length > 0 ? { instanceId, model } : null;
}

function modelSelectionLabel(selection: ModelSelection | null): string {
  return selection ? `${selection.instanceId} / ${selection.model}` : "None";
}

function ModelSelectionSelect(props: {
  readonly label: string;
  readonly value: ModelSelection | null;
  readonly inheritLabel: string;
  readonly onChange: (selection: ModelSelection | null) => void;
}) {
  const providers = useServerProviders();
  const settings = useSettings();
  const options = useMemo(() => {
    const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers)).filter(
      (entry) => entry.enabled && entry.status === "ready",
    );
    return entries.flatMap((entry) =>
      getAppModelOptionsForInstance(settings, entry).map((model) => ({
        key: modelSelectionKey({ instanceId: entry.instanceId, model: model.slug }),
        instanceId: entry.instanceId,
        instanceLabel: entry.displayName,
        model: model.slug,
        modelLabel: model.shortName ?? model.name,
      })),
    );
  }, [providers, settings]);

  return (
    <label className="block space-y-1 text-xs">
      <span className="font-medium text-muted-foreground">{props.label}</span>
      <select
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
        value={props.value ? modelSelectionKey(props.value) : ""}
        onChange={(event) => props.onChange(parseModelSelectionKey(event.target.value))}
      >
        <option value="">{props.inheritLabel}</option>
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.instanceLabel}: {option.modelLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

export function OrchestrationPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly mode: "sidebar" | "sheet";
}) {
  const environmentState = useStore((state) => selectEnvironmentState(state, props.environmentId));
  const threadShell = environmentState.threadShellById[props.threadId];
  const project = threadShell ? environmentState.projectById[threadShell.projectId] : undefined;
  const latestMessageText = useMemo(() => {
    const messageIds = environmentState.messageIdsByThreadId[props.threadId] ?? [];
    const latestMessageId = messageIds.at(-1);
    return latestMessageId
      ? environmentState.messageByThreadId[props.threadId]?.[latestMessageId]?.text
      : undefined;
  }, [environmentState, props.threadId]);
  const workflows = useMemo(
    () =>
      (environmentState.workflowIds ?? [])
        .map((workflowId) => environmentState.workflowById?.[workflowId])
        .filter((workflow): workflow is WorkflowDefinition => workflow !== undefined),
    [environmentState],
  );
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const workflow =
    workflows.find((entry) => entry.id === selectedWorkflowId) ?? workflows[0] ?? null;
  const runs = useMemo(
    () =>
      workflow
        ? (environmentState.workflowRunIds ?? [])
            .map((runId) => environmentState.workflowRunById?.[runId])
            .filter(
              (run): run is WorkflowRun => run !== undefined && run.workflowId === workflow.id,
            )
        : [],
    [environmentState, workflow],
  );
  const latestRun = latestRunForWorkflow(runs);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const selectedNode = workflow?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const [promptDraft, setPromptDraft] = useState("");
  const [goal, setGoal] = useState("");

  useEffect(() => {
    setPromptDraft(selectedNode?.config.promptTemplate ?? "");
  }, [selectedNode?.id, selectedNode?.config.promptTemplate]);

  const graph = useMemo(() => {
    const nodeRuns = new Map(latestRun?.nodeRuns.map((run) => [run.nodeId, run]) ?? []);
    const nodes: Node[] =
      workflow?.nodes.map((node) => {
        const run = nodeRuns.get(node.id);
        const effectiveModel =
          node.config.modelSelection ??
          workflow.defaultModelSelection ??
          project?.defaultModelSelection ??
          null;
        return {
          id: node.id,
          position: node.position,
          data: {
            label: (
              <div className="min-w-36">
                <div className="text-xs uppercase text-muted-foreground">{node.kind}</div>
                <div className="font-medium">{node.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">{run?.status ?? "not run"}</div>
                <div className="mt-1 max-w-44 truncate text-[0.7rem] text-muted-foreground">
                  {modelSelectionLabel(effectiveModel)}
                </div>
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
  }, [latestRun, project?.defaultModelSelection, workflow]);

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

  const updateWorkflow = async (
    patch: Pick<
      Extract<ClientOrchestrationCommand, { type: "workflow.update" }>,
      "defaultModelSelection" | "nodes"
    >,
  ) => {
    if (!workflow) return;
    await dispatch({
      type: "workflow.update",
      commandId: CommandId.make(id("client:workflow-update")),
      workflowId: workflow.id,
      expectedVersion: workflow.version,
      updatedAt: new Date().toISOString(),
      ...patch,
    });
  };

  const updateSelectedNode = async (
    update: (node: WorkflowNodeDefinition) => WorkflowNodeDefinition,
  ) => {
    if (!workflow || !selectedNode) return;
    await updateWorkflow({
      nodes: workflow.nodes.map((node) => (node.id === selectedNode.id ? update(node) : node)),
    });
  };

  const runWorkflow = async () => {
    if (!workflow) return;
    const now = new Date().toISOString();
    await dispatch({
      type: "workflow.run.start",
      commandId: CommandId.make(id("client:workflow-run-start")),
      workflowRunId: WorkflowRunId.make(id("workflow-run")),
      workflowId: workflow.id,
      goal: goal.trim() || latestMessageText || workflow.title,
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
        {workflow ? (
          <div className="mt-2">
            <ModelSelectionSelect
              label="Workflow default model"
              value={workflow.defaultModelSelection}
              inheritLabel={`Use project default (${modelSelectionLabel(project?.defaultModelSelection ?? null)})`}
              onChange={(selection) => void updateWorkflow({ defaultModelSelection: selection })}
            />
          </div>
        ) : null}
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
            <ModelSelectionSelect
              label="Node model"
              value={selectedNode.config.modelSelection ?? null}
              inheritLabel={`Inherit workflow default (${modelSelectionLabel(
                workflow?.defaultModelSelection ?? project?.defaultModelSelection ?? null,
              )})`}
              onChange={(selection) =>
                void updateSelectedNode((node) => ({
                  ...node,
                  config: {
                    ...node.config,
                    modelSelection: selection,
                  },
                }))
              }
            />
            <label className="block space-y-1 text-xs">
              <span className="font-medium text-muted-foreground">Prompt</span>
              <textarea
                className="h-24 w-full resize-none rounded-md border border-border bg-background p-2 text-xs"
                value={promptDraft}
                onChange={(event) => setPromptDraft(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
              disabled={promptDraft === selectedNode.config.promptTemplate}
              onClick={() =>
                void updateSelectedNode((node) => ({
                  ...node,
                  config: {
                    ...node.config,
                    promptTemplate: promptDraft,
                  },
                }))
              }
            >
              Save Prompt
            </button>
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
