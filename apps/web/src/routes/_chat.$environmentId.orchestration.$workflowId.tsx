import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo } from "react";

import { DiffPanelLoadingState } from "../components/DiffPanelShell";
import { SidebarInset } from "../components/ui/sidebar";
import { selectEnvironmentState, useStore } from "../store";
import { resolveWorkflowRouteRef } from "../workflowRoutes";

const OrchestrationPanel = lazy(() => import("../components/OrchestrationPanel"));

function WorkflowRouteView() {
  const navigate = useNavigate();
  const workflowRef = Route.useParams({
    select: (params) => resolveWorkflowRouteRef(params),
  });
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, workflowRef?.environmentId ?? null).bootstrapComplete,
  );
  const workflow = useStore(
    useMemo(
      () => (store: import("../store").AppState) =>
        workflowRef
          ? selectEnvironmentState(store, workflowRef.environmentId).workflowById?.[
              workflowRef.workflowId
            ]
          : undefined,
      [workflowRef],
    ),
  );

  useEffect(() => {
    if (!workflowRef || !bootstrapComplete) {
      return;
    }

    if (!workflow) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, navigate, workflow, workflowRef]);

  if (!workflowRef || !bootstrapComplete || !workflow) {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <Suspense fallback={<DiffPanelLoadingState label="Loading orchestration..." />}>
        <OrchestrationPanel
          environmentId={workflowRef.environmentId}
          workflowId={workflowRef.workflowId}
          mode="primary"
        />
      </Suspense>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/orchestration/$workflowId")({
  component: WorkflowRouteView,
});
