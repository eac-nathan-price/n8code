import type { EnvironmentId, WorkflowId } from "@t3tools/contracts";

export interface ScopedWorkflowRef {
  readonly environmentId: EnvironmentId;
  readonly workflowId: WorkflowId;
}

export function buildWorkflowRouteParams(ref: ScopedWorkflowRef): {
  environmentId: EnvironmentId;
  workflowId: WorkflowId;
} {
  return {
    environmentId: ref.environmentId,
    workflowId: ref.workflowId,
  };
}

export function resolveWorkflowRouteRef(
  params: Partial<Record<"environmentId" | "workflowId", string | undefined>>,
): ScopedWorkflowRef | null {
  if (!params.environmentId || !params.workflowId) {
    return null;
  }

  return {
    environmentId: params.environmentId as EnvironmentId,
    workflowId: params.workflowId as WorkflowId,
  };
}
