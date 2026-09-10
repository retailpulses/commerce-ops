import { useControlPlaneQuery } from "@/hooks/useControlPlane";
import { Spinner } from "@/components/shared/Spinner";

function value(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "Unknown" : String(value);
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
    <h2 className="font-semibold mb-3 dark:text-gray-100">{title}</h2>{children}
  </section>;
}

export function ControlPlaneDashboard() {
  const { data, isLoading, error, refetch, isFetching } = useControlPlaneQuery();
  if (isLoading) return <div className="py-16"><Spinner /></div>;
  if (error || !data) return <div className="rounded border border-red-300 bg-red-50 p-4 text-red-700">Control-plane read failed: {(error as Error)?.message || "unknown error"}</div>;

  const operationRows = Object.entries(data.external_operations.counts_by_capability);
  return <div className="space-y-4">
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-lg font-semibold dark:text-gray-100">Pipeline control plane</h1>
        <p className="text-xs text-gray-500">Generated {new Date(data.generated_at).toLocaleString()}</p>
      </div>
      <div className="flex items-center gap-3">
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${data.health.state === "HEALTHY" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-800"}`}>{data.health.state}</span>
        <button onClick={() => refetch()} disabled={isFetching} className="rounded border border-gray-300 px-3 py-1 text-sm dark:text-gray-200">{isFetching ? "Refreshing…" : "Refresh"}</button>
      </div>
    </div>

    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <Card title="Release & scheduler">
        <dl className="space-y-1 text-sm dark:text-gray-200">
          <div>Release: <code>{value(data.release.sha?.slice(0, 12))}</code></div>
          <div>Active live executor: {value(data.scheduler.active_live_executor)}</div>
          <div>Executor evidence: {data.scheduler.active_live_executor_evidence}</div>
          <div>Active executor: {value(data.scheduler.active_executor_mode)}</div>
          <div>Target owner: {data.scheduler.target_owner}</div>
          <div>Production kill switch: {data.scheduler.production_kill_switch_state}</div>
        </dl>
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">{data.scheduler.warning}</p>
        <p className="mt-1 text-xs text-gray-500">Pipeline: {data.health.pipeline_state}; governance: {data.health.governance_state}</p>
      </Card>

      <Card title="Lease & latest run">
        <div className="space-y-1 text-sm dark:text-gray-200">
          <div>Lease: {data.lease.active ? "Active" : "Inactive"}</div>
          <div>Owner: {value(data.lease.owner_id)}</div>
          <div>Heartbeat: {value(data.lease.heartbeat_at)}</div>
          <div>Latest run: {value(data.latest_run?.run_id)}</div>
          <div>Mode/status: {data.latest_run ? `${data.latest_run.execution_mode} / ${data.latest_run.status}` : "Unknown"}</div>
        </div>
      </Card>

      <Card title="Workload backlog">
        <dl className="space-y-1 text-sm dark:text-gray-200">
          <div>Pending review: {data.workload_backlog.pending_review_orders}</div>
          <div>Missing projection: {data.workload_backlog.missing_projection_orders}</div>
          <div>Unsynced projection: {data.workload_backlog.unsynced_projection_orders}</div>
          <div>Shipped not closed: {data.workload_backlog.shipped_not_closed_orders}</div>
        </dl>
        {data.workload_backlog.truncated && <p className="mt-2 text-xs text-amber-700">Counts truncated at safety limit.</p>}
      </Card>
    </div>

    <Card title="Verified scheduler ownership">
      {data.scheduler.workload_ownership.length === 0 ? <p className="text-sm text-amber-700">No current workload ownership evidence has been recorded.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm dark:text-gray-200">
        <thead><tr className="border-b"><th className="py-2">Workload</th><th>Owner</th><th>Host</th><th>Kill switch</th><th>Evidence expires</th></tr></thead>
        <tbody>{data.scheduler.workload_ownership.map((row) => <tr key={row.workload_id} className="border-b border-gray-100 dark:border-gray-700">
          <td className="py-2">{row.workload_id}</td><td className={row.current ? "" : "text-red-600 font-semibold"}>{row.scheduler_owner}</td><td>{row.runtime_host}</td><td>{row.kill_switch_state}</td><td>{value(row.expires_at)}</td>
        </tr>)}</tbody>
      </table></div>}
      {data.scheduler.ownership_truncated && <p className="mt-2 text-xs text-amber-700">Ownership rows truncated at safety limit.</p>}
    </Card>

    <Card title={`Lifecycle freshness (SLA ${data.lifecycle.freshness_sla_minutes} min)`}>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm dark:text-gray-200">
        <thead><tr className="border-b"><th className="py-2">Platform / shop</th><th>State</th><th>Age</th><th>Completed</th></tr></thead>
        <tbody>{data.lifecycle.watermarks.map((row) => <tr key={`${row.platform}:${row.source_store_id}`} className="border-b border-gray-100 dark:border-gray-700">
          <td className="py-2">{row.platform} / {row.source_store_id}</td><td className={row.stale ? "text-red-600 font-semibold" : "text-green-600"}>{row.stale ? "STALE" : row.completion_state}</td><td>{value(row.age_minutes)} min</td><td>{value(row.completed_at)}</td>
        </tr>)}</tbody>
      </table></div>
      {data.lifecycle.truncated && <p className="mt-2 text-xs text-amber-700">Watermarks truncated at safety limit.</p>}
    </Card>

    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={`External operation attention (${data.external_operations.open_count})`}>
        {operationRows.length === 0 ? <p className="text-sm text-gray-500">No open operation intents.</p> : operationRows.map(([capability, counts]) => <div key={capability} className="mb-2 text-sm dark:text-gray-200"><span className="font-medium">{capability}</span>: {Object.entries(counts).map(([status, count]) => `${status} ${count}`).join(", ")}</div>)}
        {data.external_operations.truncated && <p className="mt-2 text-xs text-amber-700">Operation counts are a lower bound due to the safety limit.</p>}
      </Card>
      <Card title="Failed or blocked steps">
        {data.failed_or_blocked_steps.length === 0 ? <p className="text-sm text-gray-500">No recent failed or blocked steps.</p> : data.failed_or_blocked_steps.map((step) => <div key={`${step.run_id}:${step.step_name}`} className="mb-2 text-sm dark:text-gray-200"><span className="font-medium">{step.step_name}</span> — {step.status}{step.error_code ? ` (${step.error_code})` : ""}</div>)}
      </Card>
    </div>
  </div>;
}
