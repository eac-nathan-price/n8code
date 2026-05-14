import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo } from "react";
import type { EnvironmentId, WorkflowId } from "@t3tools/contracts";

import { DiffPanelLoadingState } from "../components/DiffPanelShell";
import { SidebarInset } from "../components/ui/sidebar";
import { selectEnvironmentState, useStore } from "../store";

const OrchestrationPanel = lazy(() => import("../components/OrchestrationPanel"));

function WorkflowRouteView() {
  const navigate = useNavigate();
  const params = Route.useParams();
  const environmentId = params.environmentId as EnvironmentId;
  const workflowId = params.workflowId as WorkflowId;
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, environmentId).bootstrapComplete,
  );
  const workflow = useStore(
    useMemo(
      () => (store: import("../store").AppState) =>
        selectEnvironmentState(store, environmentId).workflowById?.[workflowId],
      [environmentId, workflowId],
    ),
  );

  useEffect(() => {
    if (!bootstrapComplete) {
      return;
    }

    if (!workflow) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, navigate, workflow]);

  if (!bootstrapComplete || !workflow) {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <Suspense fallback={<DiffPanelLoadingState label="Loading orchestration..." />}>
        <OrchestrationPanel environmentId={environmentId} workflowId={workflowId} mode="primary" />
      </Suspense>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/orchestration/$workflowId")({
  component: WorkflowRouteView,
});
