import { describe, expect, it } from "vitest";
import { WorkflowId } from "@t3tools/contracts";

import { buildWorkflowRouteParams, resolveWorkflowRouteRef } from "./workflowRoutes";

describe("workflowRoutes", () => {
  it("builds canonical workflow route params from a scoped ref", () => {
    expect(
      buildWorkflowRouteParams({
        environmentId: "env-1" as never,
        workflowId: WorkflowId.make("workflow-1"),
      }),
    ).toEqual({
      environmentId: "env-1",
      workflowId: "workflow-1",
    });
  });

  it("resolves a workflow ref only when both params are present", () => {
    expect(
      resolveWorkflowRouteRef({
        environmentId: "env-1",
        workflowId: "workflow-1",
      }),
    ).toEqual({
      environmentId: "env-1",
      workflowId: "workflow-1",
    });

    expect(resolveWorkflowRouteRef({ environmentId: "env-1" })).toBeNull();
    expect(resolveWorkflowRouteRef({ workflowId: "workflow-1" })).toBeNull();
  });
});
