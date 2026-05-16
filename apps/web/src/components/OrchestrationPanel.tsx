import "@xyflow/react/dist/style.css";

import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import {
  type ClientOrchestrationCommand,
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
  type ThreadId,
  type WorkflowNodeDefinition,
  type WorkflowId,
  WorkflowRunId,
  type WorkflowRun,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { retainThreadDetailSubscription } from "~/environments/runtime/service";
import { useSettings } from "~/hooks/useSettings";
import { getAppModelOptionsForInstance } from "~/modelSelection";
import { deriveProviderInstanceEntries, sortProviderInstanceEntries } from "~/providerInstances";
import { useServerProviders } from "~/rpc/serverState";
import { selectEnvironmentState, useStore } from "~/store";
import { cn } from "~/lib/utils";

const EDGE_MIN_ANIMATION_MS = 1_000;

type NodePosition = {
  readonly x: number;
  readonly y: number;
};

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

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDebugPayload(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [nodePositions, setNodePositions] = useState<Record<string, NodePosition>>({});
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);

  const workflowThreadIds = useMemo(
    () =>
      Array.from(
        new Set(
          latestRun?.nodeRuns
            .map((nodeRun) => nodeRun.threadId)
            .filter((threadId): threadId is ThreadId => threadId !== null) ?? [],
        ),
      ),
    [latestRun],
  );

  useEffect(() => {
    setSelectedNodeId(null);
  }, [props.workflowId]);

  useEffect(() => {
    setPromptDraft(selectedNode?.config.promptTemplate ?? "");
  }, [selectedNode?.id, selectedNode?.config.promptTemplate]);

  useEffect(() => {
    setNodePositions(
      Object.fromEntries(
        workflow?.nodes.map((node) => [
          node.id,
          {
            x: node.position.x,
            y: node.position.y,
          },
        ]) ?? [],
      ),
    );
    setHoveredNodeId(null);
    setDraggingNodeId(null);
  }, [workflow?.id, workflow?.nodes]);

  useEffect(() => {
    if (workflowThreadIds.length === 0) return;
    const releases = workflowThreadIds.map((threadId) =>
      retainThreadDetailSubscription(props.environmentId, threadId),
    );
    return () => {
      for (const release of releases) {
        release();
      }
    };
  }, [props.environmentId, workflowThreadIds]);

  useEffect(() => {
    if (latestRun?.status !== "running") return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [latestRun?.status]);

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
          position: nodePositions[node.id] ?? node.position,
          data: {
            label: (
              <div className="min-w-36">
                <div className="text-xs uppercase text-muted-foreground">{node.kind}</div>
                <div className="font-medium">{node.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">{run?.status ?? "not run"}</div>
                {run?.status === "running" ? (
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-primary/15">
                    <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
                  </div>
                ) : null}
                <div className="mt-1 max-w-44 truncate text-[0.7rem] text-muted-foreground">
                  {modelSelectionLabel(effectiveModel)}
                </div>
              </div>
            ),
          },
          className: cn(
            "rounded-lg border bg-card p-2 text-card-foreground shadow-sm transition-[border-color,box-shadow,transform] duration-150",
            hoveredNodeId === node.id &&
              "border-primary/70 shadow-lg shadow-primary/20 ring-1 ring-primary/30",
            draggingNodeId === node.id &&
              "scale-[1.02] cursor-grabbing border-primary shadow-xl shadow-primary/30 ring-2 ring-primary/40",
            run?.status === "running" && "border-primary shadow-primary/30",
            run?.status === "failed" && "border-destructive",
            run?.status === "completed" && "border-emerald-500",
          ),
        };
      }) ?? [];
    const outgoingEdgeCountByNodeId = new Map<string, number>();
    for (const edge of workflow?.edges ?? []) {
      outgoingEdgeCountByNodeId.set(
        edge.sourceNodeId,
        (outgoingEdgeCountByNodeId.get(edge.sourceNodeId) ?? 0) + 1,
      );
    }

    const edges: Edge[] =
      workflow?.edges.map((edge) => {
        const sourceRun = nodeRuns.get(edge.sourceNodeId);
        const targetRun = nodeRuns.get(edge.targetNodeId);
        const sourceCompletedAt = timestampMs(sourceRun?.completedAt);
        const targetStartedAt = timestampMs(targetRun?.startedAt);
        const animateUntil =
          sourceCompletedAt === null
            ? null
            : targetStartedAt === null
              ? Number.POSITIVE_INFINITY
              : Math.max(sourceCompletedAt + EDGE_MIN_ANIMATION_MS, targetStartedAt);
        const isUsedTransition =
          sourceRun?.status === "completed" &&
          targetRun !== undefined &&
          targetRun.status !== "pending";
        const isWaitingForTarget =
          sourceRun?.status === "completed" &&
          targetRun?.status === "pending" &&
          outgoingEdgeCountByNodeId.get(edge.sourceNodeId) === 1;
        const animated =
          sourceCompletedAt !== null &&
          (isUsedTransition || isWaitingForTarget) &&
          nowMs < (animateUntil ?? 0);
        return {
          id: edge.id,
          source: edge.sourceNodeId,
          target: edge.targetNodeId,
          animated,
          className: cn(animated && "stroke-primary"),
          ...(edge.condition !== undefined ? { label: edge.condition } : {}),
          ...(animated ? { style: { strokeWidth: 2 } } : {}),
        };
      }) ?? [];
    return { nodes, edges };
  }, [
    draggingNodeId,
    hoveredNodeId,
    latestRun,
    nodePositions,
    nowMs,
    project?.defaultModelSelection,
    workflow,
  ]);

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

  const persistNodePosition = useCallback(
    async (nodeId: string, position: { readonly x: number; readonly y: number }) => {
      if (!workflow) return;
      await updateWorkflow({
        nodes: workflow.nodes.map((node) =>
          node.id === nodeId ? { ...node, position: { x: position.x, y: position.y } } : node,
        ),
      });
    },
    [updateWorkflow, workflow],
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

  const debugText = useMemo(() => {
    if (!workflow || !latestRun) {
      return "No workflow run selected.";
    }

    const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
    const sections = latestRun.nodeRuns.map((nodeRun) => {
      const node = nodeById.get(nodeRun.nodeId);
      const title = node?.title ?? nodeRun.nodeId;
      const lines = [
        `# ${title}`,
        `nodeRunId: ${nodeRun.id}`,
        `status: ${nodeRun.status}`,
        `threadId: ${nodeRun.threadId ?? "none"}`,
      ];

      if (nodeRun.error) {
        lines.push(`error: ${nodeRun.error}`);
      }

      if (nodeRun.threadId === null) {
        lines.push("No thread has been started for this node yet.");
        return lines.join("\n");
      }

      const messageIds = environmentState.messageIdsByThreadId[nodeRun.threadId] ?? [];
      const messagesById = environmentState.messageByThreadId[nodeRun.threadId] ?? {};
      const activityIds = environmentState.activityIdsByThreadId[nodeRun.threadId] ?? [];
      const activitiesById = environmentState.activityByThreadId[nodeRun.threadId] ?? {};

      if (messageIds.length === 0 && activityIds.length === 0) {
        lines.push("Waiting for thread output...");
        return lines.join("\n");
      }

      for (const activityId of activityIds) {
        const activity = activitiesById[activityId];
        if (!activity) continue;
        lines.push(
          `[activity ${activity.createdAt}] ${activity.kind}: ${activity.summary}`,
          formatDebugPayload(activity.payload),
        );
      }

      for (const messageId of messageIds) {
        const message = messagesById[messageId];
        if (!message) continue;
        lines.push(
          `[message ${message.createdAt}] ${message.role}${message.streaming ? " (streaming)" : ""}:`,
          message.text.trim() || "(empty)",
        );
      }

      return lines.filter((line) => line.length > 0).join("\n");
    });

    return sections.join("\n\n---\n\n");
  }, [
    environmentState.activityByThreadId,
    environmentState.activityIdsByThreadId,
    environmentState.messageByThreadId,
    environmentState.messageIdsByThreadId,
    latestRun,
    workflow,
  ]);

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
            onNodeMouseEnter={(_, node) => setHoveredNodeId(node.id)}
            onNodeMouseLeave={(_, node) => {
              setHoveredNodeId((current) => (current === node.id ? null : current));
            }}
            onNodeDragStart={(_, node) => {
              setDraggingNodeId(node.id);
              setHoveredNodeId(node.id);
            }}
            onNodeDrag={(_, node) => {
              setNodePositions((current) => ({
                ...current,
                [node.id]: {
                  x: node.position.x,
                  y: node.position.y,
                },
              }));
            }}
            onNodeDragStop={(_, node) => {
              setDraggingNodeId(null);
              setNodePositions((current) => ({
                ...current,
                [node.id]: {
                  x: node.position.x,
                  y: node.position.y,
                },
              }));
              void persistNodePosition(node.id, node.position);
            }}
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
      <div className="grid max-h-72 grid-cols-1 overflow-hidden border-t border-border text-sm lg:grid-cols-[minmax(260px,0.9fr)_minmax(360px,1.1fr)]">
        <div className="overflow-auto border-b border-border p-3 lg:border-b-0 lg:border-r">
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
        <div className="flex min-h-0 flex-col p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="font-medium">Raw agent output</div>
            <div className="text-xs text-muted-foreground">
              {workflowThreadIds.length} live thread{workflowThreadIds.length === 1 ? "" : "s"}
            </div>
          </div>
          <pre className="min-h-32 flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {debugText}
          </pre>
        </div>
      </div>
    </div>
  );
}

export default OrchestrationPanel;
