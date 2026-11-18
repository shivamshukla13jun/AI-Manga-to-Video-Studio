import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/primitives';
import type { CostEstimate } from '@/lib/types';
import { formatCost, formatDuration, formatNumber } from '@/lib/utils';

/** Cost estimate review gate — required before any paid AI call. */
export const EstimateDialog = ({
  estimate,
  open,
  onOpenChange,
  confirmLabel,
  onConfirm,
  loading,
}: {
  estimate: CostEstimate | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  confirmLabel: string;
  onConfirm: () => void;
  loading?: boolean;
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title="Cost estimate" description="Estimates only — actual provider charges may differ.">
      {estimate && (
        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-line bg-panel-2 p-3">
            <span className="text-muted">Provider / model</span>
            <span className="text-right font-mono">{estimate.provider} · {estimate.model}</span>
            <span className="text-muted">API calls</span>
            <span className="text-right font-mono">{formatNumber(estimate.totals.requests)}</span>
            <span className="text-muted">Input tokens</span>
            <span className="text-right font-mono">{formatNumber(estimate.totals.inputTokens)}</span>
            <span className="text-muted">Output tokens (incl. thinking)</span>
            <span className="text-right font-mono">{formatNumber(estimate.totals.outputTokens + estimate.totals.thoughtTokens)}</span>
            {(estimate.totals as any).audioSeconds != null && (
              <>
                <span className="text-muted">Audio</span>
                <span className="text-right font-mono">{formatDuration((estimate.totals as any).audioSeconds)}</span>
              </>
            )}
            <span className="text-muted">Price list</span>
            <span className="text-right font-mono">{estimate.pricing?.version || '—'}</span>
          </div>

          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-line">
            {estimate.items.map((i) => (
              <div key={i.key} className="flex items-center justify-between px-3 py-1.5 odd:bg-panel-2">
                <span className="truncate text-muted">{i.label}</span>
                <span className="ml-2 font-mono">{formatCost(i.costUSD)}</span>
              </div>
            ))}
          </div>

          <div className="flex items-baseline justify-between rounded-md border border-line-strong bg-panel-3 px-3 py-2">
            <span className="font-medium">Estimated total</span>
            <span className="text-right">
              <span className="font-mono text-sm text-accent">{formatCost(estimate.totals.costUSD)}</span>
              {estimate.costINR != null && <span className="ml-2 font-mono text-muted">₹{estimate.costINR.toFixed(2)}</span>}
            </span>
          </div>

          {!estimate.withinBudget && (
            <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
              Exceeds your budget limit of {formatCost(estimate.budgetLimitUSD || 0)} — raise it in Settings or reduce the selection.
            </p>
          )}
          {estimate.assumptions && estimate.assumptions.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-muted">
              {estimate.assumptions.slice(0, 4).map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onConfirm} loading={loading} disabled={!estimate?.withinBudget}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
