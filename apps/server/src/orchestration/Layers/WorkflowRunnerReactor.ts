import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ThreadId,
  type WorkflowDefinition,
  type WorkflowNodeDefinition,
  WorkflowNodeRunId,
  type WorkflowRun,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  WorkflowRunnerReactor,
  type WorkflowRunnerReactorShape,
} from "../Services/WorkflowRunnerReactor.ts";

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function nodeRunId(workflowRunId: string, nodeId: string): WorkflowNodeRunId {
  return WorkflowNodeRunId.make(`${workflowRunId}:${nodeId}`);
}

function renderPrompt(input: {
  readonly workflow: WorkflowDefinition;
  readonly run: WorkflowRun;
  readonly node: WorkflowNodeDefinition;
}): string {
  let prompt = input.node.config.promptTemplate.replaceAll("{{goal}}", input.run.goal);
  for (const nodeRun of input.run.nodeRuns) {
    const sourceNode = input.workflow.nodes.find((node) => node.id === nodeRun.nodeId);
    const output = nodeRun.output === undefined ? "" : String(nodeRun.output);
    prompt = prompt.replaceAll(`{{${nodeRun.nodeId}.output}}`, output);
    if (sourceNode) {
      prompt = prompt.replaceAll(`{{${sourceNode.title}.output}}`, output);
    }
  }
  return prompt.trim() || input.run.goal;
}

function resolveModelSelection(input: {
  readonly workflow: WorkflowDefinition;
  readonly node: WorkflowNodeDefinition;
  readonly projectModelSelection: ModelSelection | null;
}): ModelSelection | null {
  return (
    input.node.config.modelSelection ??
    input.workflow.defaultModelSelection ??
    input.projectModelSelection
  );
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const workflowById = new Map<string, WorkflowDefinition>();
  const runById = new Map<string, WorkflowRun>();
  const runningNodeByThreadId = new Map<
    string,
    { readonly workflowRunId: WorkflowRun["id"]; readonly nodeRunId: WorkflowNodeRunId }
  >();

  const dispatch = (command: OrchestrationCommand) =>
    orchestrationEngine.dispatch(command).pipe(Effect.ignoreCause({ log: true }));

  const setRun = (run: WorkflowRun) => {
    runById.set(run.id, run);
    for (const nodeRun of run.nodeRuns) {
      if (nodeRun.status === "running" && nodeRun.threadId !== null) {
        runningNodeByThreadId.set(nodeRun.threadId, {
          workflowRunId: run.id,
          nodeRunId: nodeRun.id,
        });
      }
    }
  };

  const updateRun = (
    workflowRunId: WorkflowRun["id"],
    update: (run: WorkflowRun) => WorkflowRun,
  ) => {
    const current = runById.get(workflowRunId);
    if (!current) return null;
    const next = update(current);
    setRun(next);
    return next;
  };

  const failNode = (input: {
    readonly run: WorkflowRun;
    readonly node: WorkflowNodeDefinition;
    readonly error: string;
  }) =>
    nowIso.pipe(
      Effect.flatMap((completedAt) =>
        dispatch({
          type: "workflow.node-run.fail",
          commandId: serverCommandId("workflow-node-fail"),
          workflowRunId: input.run.id,
          nodeRunId: nodeRunId(input.run.id, input.node.id),
          error: input.error,
          completedAt,
        }),
      ),
    );

  const startNode = Effect.fn("WorkflowRunnerReactor.startNode")(function* (input: {
    readonly workflow: WorkflowDefinition;
    readonly run: WorkflowRun;
    readonly node: WorkflowNodeDefinition;
    readonly projectModelSelection: ModelSelection | null;
  }) {
    const modelSelection = resolveModelSelection(input);
    if (modelSelection === null) {
      yield* failNode({
        run: input.run,
        node: input.node,
        error: "No model is configured for this workflow node.",
      });
      return;
    }

    const startedAt = yield* nowIso;
    const threadId = ThreadId.make(
      `workflow:${input.run.id}:${input.node.id}:${crypto.randomUUID()}`,
    );
    const nodeRun = nodeRunId(input.run.id, input.node.id);
    yield* dispatch({
      type: "workflow.node-run.start",
      commandId: serverCommandId("workflow-node-start"),
      workflowRunId: input.run.id,
      nodeRunId: nodeRun,
      nodeId: input.node.id,
      threadId,
      startedAt,
    });
    updateRun(input.run.id, (run) => ({
      ...run,
      nodeRuns: run.nodeRuns.map((entry) =>
        entry.id === nodeRun
          ? {
              ...entry,
              status: "running",
              threadId,
              startedAt,
              updatedAt: startedAt,
            }
          : entry,
      ),
      updatedAt: startedAt,
    }));

    yield* dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("workflow-thread-turn-start"),
      threadId,
      message: {
        messageId: MessageId.make(`workflow:${input.run.id}:${input.node.id}:message`),
        role: "user",
        text: renderPrompt(input),
        attachments: [],
      },
      modelSelection,
      titleSeed: input.node.title,
      runtimeMode: input.node.config.runtimeMode,
      interactionMode: input.node.config.interactionMode,
      bootstrap: {
        createThread: {
          projectId: input.workflow.projectId,
          title: `${input.workflow.title}: ${input.node.title}`,
          modelSelection,
          runtimeMode: input.node.config.runtimeMode,
          interactionMode: input.node.config.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt: startedAt,
        },
      },
      createdAt: startedAt,
    });
  });

  const scheduleRunnableNodes = Effect.fn("WorkflowRunnerReactor.scheduleRunnableNodes")(function* (
    workflowRunId: string,
  ) {
    const readModel = yield* projectionSnapshotQuery
      .getCommandReadModel()
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Workflow runner failed to read command model", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
    const persistedRun = (readModel?.workflowRuns ?? []).find(
      (entry) => entry.id === workflowRunId,
    );
    if (persistedRun) {
      setRun(runById.get(persistedRun.id) ?? persistedRun);
    }
    for (const workflow of readModel?.workflows ?? []) {
      workflowById.set(workflow.id, workflow);
    }
    const run = runById.get(workflowRunId);
    if (!run || run.status !== "running") return;
    const workflow = workflowById.get(run.workflowId);
    if (!workflow || workflow.deletedAt !== null) return;
    const project = readModel?.projects.find((entry) => entry.id === workflow.projectId);
    const completedNodeIds = new Set(
      run.nodeRuns
        .filter((nodeRun) => nodeRun.status === "completed")
        .map((nodeRun) => nodeRun.nodeId),
    );
    const runningNodeIds = new Set(
      run.nodeRuns
        .filter((nodeRun) => nodeRun.status === "running")
        .map((nodeRun) => nodeRun.nodeId),
    );
    let pendingNodes = workflow.nodes.filter((node) => {
      if (completedNodeIds.has(node.id) || runningNodeIds.has(node.id)) return false;
      const inbound = workflow.edges.filter((edge) => edge.targetNodeId === node.id);
      return inbound.every((edge) => completedNodeIds.has(edge.sourceNodeId));
    });
    if (
      pendingNodes.length === 0 &&
      completedNodeIds.size === 0 &&
      runningNodeIds.size === 0 &&
      workflow.nodes.length > 0
    ) {
      pendingNodes = [workflow.nodes[0]!];
    }

    if (pendingNodes.length === 0) {
      const hasRunning = run.nodeRuns.some((nodeRun) => nodeRun.status === "running");
      const allCompleted =
        run.nodeRuns.length > 0 && run.nodeRuns.every((nodeRun) => nodeRun.status === "completed");
      if (!hasRunning && allCompleted) {
        const completedAt = yield* nowIso;
        yield* dispatch({
          type: "workflow.run.complete",
          commandId: serverCommandId("workflow-run-complete"),
          workflowRunId: run.id,
          status: "completed",
          completedAt,
        });
      }
      return;
    }

    yield* Effect.forEach(
      pendingNodes,
      (node) =>
        startNode({
          workflow,
          run,
          node,
          projectModelSelection: project?.defaultModelSelection ?? null,
        }),
      { concurrency: "unbounded" },
    );
  });

  const completeNodeForThread = Effect.fn("WorkflowRunnerReactor.completeNodeForThread")(function* (
    threadId: ThreadId,
  ) {
    const runningNode = runningNodeByThreadId.get(threadId);
    if (!runningNode) return;
    const completedAt = yield* nowIso;
    yield* dispatch({
      type: "workflow.node-run.complete",
      commandId: serverCommandId("workflow-node-complete"),
      workflowRunId: runningNode.workflowRunId,
      nodeRunId: runningNode.nodeRunId,
      output: { threadId, completedAt },
      completedAt,
    });
    runningNodeByThreadId.delete(threadId);
    updateRun(runningNode.workflowRunId, (run) => ({
      ...run,
      nodeRuns: run.nodeRuns.map((nodeRun) =>
        nodeRun.id === runningNode.nodeRunId
          ? {
              ...nodeRun,
              status: "completed",
              output: { threadId, completedAt },
              completedAt,
              updatedAt: completedAt,
            }
          : nodeRun,
      ),
      updatedAt: completedAt,
    }));
    yield* scheduleRunnableNodes(runningNode.workflowRunId);
  });

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "workflow.created":
      case "workflow.updated":
        workflowById.set(event.payload.workflow.id, event.payload.workflow);
        return Effect.void;
      case "workflow.run-started":
        setRun(event.payload.run);
        return scheduleRunnableNodes(event.payload.run.id);
      case "workflow.run-paused":
      case "workflow.run-resumed":
      case "workflow.run-stopping":
        updateRun(event.payload.workflowRunId, (run) => ({
          ...run,
          status:
            event.type === "workflow.run-paused"
              ? "paused"
              : event.type === "workflow.run-resumed"
                ? "running"
                : "stopping",
          updatedAt: event.payload.updatedAt,
        }));
        return Effect.void;
      case "workflow.node-run-completed":
        updateRun(event.payload.workflowRunId, (run) => ({
          ...run,
          nodeRuns: run.nodeRuns.map((nodeRun) =>
            nodeRun.id === event.payload.nodeRunId
              ? {
                  ...nodeRun,
                  status: "completed",
                  ...(event.payload.output !== undefined ? { output: event.payload.output } : {}),
                  completedAt: event.payload.completedAt,
                  updatedAt: event.payload.completedAt,
                }
              : nodeRun,
          ),
          updatedAt: event.payload.completedAt,
        }));
        return scheduleRunnableNodes(event.payload.workflowRunId);
      case "workflow.node-run-failed":
        updateRun(event.payload.workflowRunId, (run) => ({
          ...run,
          status: "failed",
          completedAt: event.payload.completedAt,
          nodeRuns: run.nodeRuns.map((nodeRun) =>
            nodeRun.id === event.payload.nodeRunId
              ? {
                  ...nodeRun,
                  status: "failed",
                  error: event.payload.error,
                  completedAt: event.payload.completedAt,
                  updatedAt: event.payload.completedAt,
                }
              : nodeRun,
          ),
          updatedAt: event.payload.completedAt,
        }));
        return Effect.void;
      case "thread.turn-diff-completed":
        return completeNodeForThread(event.payload.threadId);
      default:
        return Effect.void;
    }
  };

  const worker = yield* makeDrainableWorker(processEvent);

  const start: WorkflowRunnerReactorShape["start"] = () =>
    Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, worker.enqueue),
    ).pipe(Effect.asVoid);

  return {
    start,
    drain: worker.drain,
  } satisfies WorkflowRunnerReactorShape;
});

export const WorkflowRunnerReactorLive = Layer.effect(WorkflowRunnerReactor, make);
