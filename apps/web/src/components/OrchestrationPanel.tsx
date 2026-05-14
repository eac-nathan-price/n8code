import "@xyflow/react/dist/style.css";

import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import {
  type ClientOrchestrationCommand,
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
  type WorkflowNodeDefinition,
  type WorkflowId,
  WorkflowRunId,
  type WorkflowRun,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { useSettings } from "~/hooks/useSettings";
import { getAppModelOptionsForInstance } from "~/modelSelection";
import { deriveProviderInstanceEntries, sortProviderInstanceEntries } from "~/providerInstances";
import { useServerProviders } from "~/rpc/serverState";
import { selectEnvironmentState, useStore } from "~/store";
import { cn } from "~/lib/utils";

function id(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
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
  readonly workflowId: WorkflowId;
  readonly mode: "primary";
}) {
  const environmentState = useStore((state) => selectEnvironmentState(state, props.environmentId));
  const workflow = environmentState.workflowById?.[props.workflowId] ?? null;
  const project = workflow ? environmentState.projectById[workflow.projectId] : undefined;
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
    setSelectedNodeId(null);
  }, [props.workflowId]);

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

  const dispatch = useCallback(
    async (command: ClientOrchestrationCommand) => {
      const api = readEnvironmentApi(props.environmentId);
      if (!api) return;
      await api.orchestration.dispatchCommand(command);
    },
    [props.environmentId],
  );

  const updateWorkflow = useCallback(
    async (
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
    },
    [dispatch, workflow],
  );

  const updateSelectedNode = useCallback(
    async (update: (node: WorkflowNodeDefinition) => WorkflowNodeDefinition) => {
      if (!workflow || !selectedNode) return;
      await updateWorkflow({
        nodes: workflow.nodes.map((node) => (node.id === selectedNode.id ? update(node) : node)),
      });
    },
    [selectedNode, updateWorkflow, workflow],
  );

  const runWorkflow = useCallback(async () => {
    if (!workflow) return;
    const now = new Date().toISOString();
    await dispatch({
      type: "workflow.run.start",
      commandId: CommandId.make(id("client:workflow-run-start")),
      workflowRunId: WorkflowRunId.make(id("workflow-run")),
      workflowId: workflow.id,
      goal: goal.trim() || workflow.title,
      inputs: {},
      createdAt: now,
    });
  }, [dispatch, goal, workflow]);

  const stopRun = useCallback(async () => {
    if (!latestRun) return;
    await dispatch({
      type: "workflow.run.stop",
      commandId: CommandId.make(id("client:workflow-run-stop")),
      workflowRunId: latestRun.id,
      updatedAt: new Date().toISOString(),
    });
  }, [dispatch, latestRun]);

  useEffect(() => {
    if (!workflow || !selectedNode) return;
    if (promptDraft === selectedNode.config.promptTemplate) return;

    const timeout = window.setTimeout(() => {
      void updateSelectedNode((node) => ({
        ...node,
        config: {
          ...node.config,
          promptTemplate: promptDraft,
        },
      }));
    }, 600);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [promptDraft, selectedNode, updateSelectedNode, workflow]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">Orchestration</h2>
            <p className="text-xs text-muted-foreground">Visual workflow editor and run monitor</p>
          </div>
          <div className="text-xs text-muted-foreground">{project?.name ?? "Unknown project"}</div>
        </div>
        <div className="mt-3 flex gap-2">
          <div className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm">
            {workflow?.title ?? "Missing workflow"}
          </div>
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
            <Background color="hsl(var(--border))" />
            <Controls className="overflow-hidden rounded-md border border-border bg-card text-foreground [&_button]:!border-border [&_button]:!bg-card [&_button]:!text-foreground [&_button:hover]:!bg-accent [&_svg]:!fill-current" />
            {props.mode === "primary" ? (
              <MiniMap
                pannable
                zoomable
                className="overflow-hidden rounded-md border border-border bg-card"
                maskColor="hsl(var(--background) / 0.72)"
                nodeColor="hsl(var(--primary))"
                nodeStrokeColor="hsl(var(--border))"
              />
            ) : null}
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
              Save now
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
