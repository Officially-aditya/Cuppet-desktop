import { useEffect, useRef, useState } from 'react';
import type { ProviderPlanUsage } from '../types';

type Props = { providerID: string; providerLabel: string };

export function PlanUsagePanel({ providerID, providerLabel }: Props) {
  const [report, setReport] = useState<ProviderPlanUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let pending = false;
    setReport(null);
    const load = async () => {
      if (pending || disposed) return;
      if (!providerID) { setLoading(false); return; }
      pending = true;
      setLoading(true);
      try {
        const next = await window.cuppet.usage.plan(providerID);
        if (next.providerID !== providerID) throw new Error('The usage report did not match the selected platform. Try refreshing.');
        if (!disposed) setReport(next);
      } catch (error) {
        if (!disposed) setReport({
          providerID, status: 'error', planType: null, limits: [], fetchedAt: null,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        pending = false;
        if (!disposed) setLoading(false);
      }
    };
    const update = () => { void load(); };
    refresh.current = update;
    update();
    const timer = window.setInterval(update, 60_000);
    window.addEventListener('focus', update);
    return () => {
      disposed = true;
      refresh.current = () => {};
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }, [providerID]);

  // Never display a previous platform's allowance while its replacement loads.
  const active = report?.providerID === providerID ? report : null;
  const checking = loading || Boolean(providerID && !active);
  const available = active?.status === 'available';
  return <section className="settings-card plan-usage-card" aria-label="Plan usage" aria-busy={checking}>
    <div className="settings-card-heading">
      <div><h3>Plan usage</h3><p>{providerLabel || 'Your platform'} subscription allowance and reset times.</p></div>
      <div className="usage-heading-actions">
        {active?.planType && <span className="settings-status-pill">{active.planType}</span>}
        <button type="button" className="ghost-button settings-action-button" disabled={checking || !providerID} onClick={() => refresh.current()}>{checking ? 'Refreshing…' : 'Refresh'}</button>
      </div>
    </div>
    {available ? <>
      <div className="plan-usage-limits">
        {active.limits.map((limit) => <div className="plan-usage-limit" key={limit.id}>
          <h4>{limit.label}</h4>
          <div className="plan-usage-windows">
            {limit.windows.map((window) => <div className="plan-usage-window" key={window.id}>
              <div className="plan-usage-window-heading"><strong>{window.label}</strong><span>{percent(window.remainingPercent)}% remaining</span></div>
              <progress max={100} value={window.usedPercent} aria-label={`${limit.label} ${window.label} usage`} />
              <div className="plan-usage-window-detail"><span>{percent(window.usedPercent)}% used</span><span>{window.resetsAt
                ? window.resetsAt <= Date.now()
                  ? 'Reset time passed · awaiting provider update'
                  : `Resets ${formatTime(window.resetsAt)}`
                : 'Reset time not reported'}</span></div>
            </div>)}
          </div>
          {limit.detail && <p className="plan-usage-credits">{limit.detail}</p>}
          {limit.credits && <p className="plan-usage-credits">{limit.credits.unlimited ? 'Unlimited credits' : `${limit.credits.balance} credits remaining`}</p>}
        </div>)}
      </div>
      <div className="usage-footnote"><span>Reported by your provider across your account. Updates every minute while this page is open.</span>{active.fetchedAt && <span>Last updated {formatTime(active.fetchedAt)}.</span>}</div>
    </> : <div className="usage-placeholder" role={active?.status === 'error' ? 'alert' : 'status'}>
      <strong>{checking ? 'Checking plan usage…' : active?.status === 'signed-out' ? 'Sign in to view plan usage' : 'Plan usage unavailable'}</strong>
      <span>{checking ? 'Reading your provider’s current limits.' : active?.message || 'Choose a platform in Settings to view plan usage.'}</span>
    </div>}
  </section>;
}

function percent(value: number) { return value.toLocaleString(undefined, { maximumFractionDigits: 1 }); }
function formatTime(value: number) {
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
