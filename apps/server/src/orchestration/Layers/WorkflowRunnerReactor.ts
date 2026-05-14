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

  const dispatch = (command: OrchestrationCommand) =>
    orchestrationEngine.dispatch(command).pipe(Effect.ignoreCause({ log: true }));

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
    if (readModel === null) return;
    const run = (readModel.workflowRuns ?? []).find((entry) => entry.id === workflowRunId);
    if (!run || run.status !== "running") return;
    const workflow = (readModel.workflows ?? []).find((entry) => entry.id === run.workflowId);
    if (!workflow || workflow.deletedAt !== null) return;
    const project = readModel.projects.find((entry) => entry.id === workflow.projectId);
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
    const pendingNodes = workflow.nodes.filter((node) => {
      if (completedNodeIds.has(node.id) || runningNodeIds.has(node.id)) return false;
      const inbound = workflow.edges.filter((edge) => edge.targetNodeId === node.id);
      return inbound.every((edge) => completedNodeIds.has(edge.sourceNodeId));
    });

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
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    for (const run of readModel.workflowRuns ?? []) {
      const nodeRun = run.nodeRuns.find(
        (entry) => entry.threadId === threadId && entry.status === "running",
      );
      if (!nodeRun) continue;
      const completedAt = yield* nowIso;
      yield* dispatch({
        type: "workflow.node-run.complete",
        commandId: serverCommandId("workflow-node-complete"),
        workflowRunId: run.id,
        nodeRunId: nodeRun.id,
        output: { threadId, completedAt },
        completedAt,
      });
      yield* scheduleRunnableNodes(run.id);
      return;
    }
  });

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "workflow.run-started":
        return scheduleRunnableNodes(event.payload.run.id);
      case "workflow.node-run-completed":
        return scheduleRunnableNodes(event.payload.workflowRunId);
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
