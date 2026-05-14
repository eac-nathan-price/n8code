import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface WorkflowRunnerReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class WorkflowRunnerReactor extends Context.Service<
  WorkflowRunnerReactor,
  WorkflowRunnerReactorShape
>()("t3/orchestration/Services/WorkflowRunnerReactor") {}
