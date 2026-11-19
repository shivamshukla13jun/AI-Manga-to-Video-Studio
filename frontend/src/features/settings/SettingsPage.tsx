import { useEffect, useState } from 'react';
import { RefreshCw, Save, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/primitives';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { LoadingState, PageHeader } from '@/components/common/states';
import { useAction, usePriceTable, useStudioSettings, voiceApi } from '@/lib/queries';

const LANGS = [['hi','Hindi'],['en','English'],['ja','Japanese'],['ko','Korean'],['ta','Tamil'],['te','Telugu'],['bn','Bengali'],['es','Spanish'],['fr','French'],['de','German']] as const;
import { formatCost, formatDate } from '@/lib/utils';

export const SettingsPage = () => {
  const settings = useStudioSettings();
  const pricing = usePriceTable();
  const [f, setF] = useState({ budgetLimitUSD: '', confirmAboveUSD: '', displayCurrency: 'INR', pricingTier: 'standard', aiProvider: 'local', defaultTtsProvider: 'local', narrationLanguage: 'hi', narrationMode: 'recap', wpmDefault: '', wpmHi: '', wpmEn: '' });

  useEffect(() => {
    const s = settings.data;
    if (!s) return;
    setF({
      budgetLimitUSD: String(s.budgetLimitUSD),
      confirmAboveUSD: String(s.confirmAboveUSD),
      displayCurrency: s.displayCurrency,
      pricingTier: s.pricingTier,
      aiProvider: 'local',
      defaultTtsProvider: s.defaultTtsProvider,
      narrationLanguage: s.narrationLanguage || 'hi',
      narrationMode: s.narrationMode || 'recap',
      wpmDefault: String(s.wordsPerMinute?.default || 145),
      wpmHi: String(s.wordsPerMinute?.hi || 140),
      wpmEn: String(s.wordsPerMinute?.en || 150),
    });
  }, [settings.data]);

  const save = useAction(
    () =>
      voiceApi.updateSettings({
        budgetLimitUSD: Number(f.budgetLimitUSD),
        confirmAboveUSD: Number(f.confirmAboveUSD),
        displayCurrency: f.displayCurrency as 'USD' | 'INR',
        pricingTier: f.pricingTier as 'standard' | 'batch',
        aiProvider: 'local',
        defaultTtsProvider: 'local',
        narrationLanguage: f.narrationLanguage,
        narrationMode: f.narrationMode as 'original' | 'recap',
        wordsPerMinute: { default: Number(f.wpmDefault), hi: Number(f.wpmHi), en: Number(f.wpmEn) },
      }),
    { success: 'Settings saved', onSuccess: () => settings.refetch() }
  );
  const fx = useAction(() => voiceApi.refreshFx(), { success: (d: any) => `Rate updated: 1 USD = ₹${d.usdToInr}`, onSuccess: () => settings.refetch() });

  if (settings.isLoading) return <LoadingState />;
  const s = settings.data;

  return (
    <div className="p-6">
      <PageHeader title="Settings" subtitle="Budget guard, currency and narration defaults." icon={Settings} />
      <div className="mt-4 grid max-w-5xl gap-4 lg:grid-cols-2">
        <section className="space-y-3 rounded-lg border border-line bg-panel p-4">
          <h2 className="text-sm font-medium">Cost control</h2>
          <Field label="Budget limit per generation (USD)" hint="Cloud calls with estimates above this are refused. 0 = no limit.">
            <Input type="number" min={0} step={0.01} value={f.budgetLimitUSD} onChange={(e) => setF({ ...f, budgetLimitUSD: e.target.value })} />
          </Field>
          <Field label="Confirm above (USD)" hint="Reserved for future soft-confirmation threshold.">
            <Input type="number" min={0} step={0.01} value={f.confirmAboveUSD} onChange={(e) => setF({ ...f, confirmAboveUSD: e.target.value })} />
          </Field>
          <Field label="Pricing tier">
            <NativeSelect value={f.pricingTier} onChange={(e) => setF({ ...f, pricingTier: e.target.value })}>
              <option value="standard">Standard</option>
              <option value="batch">Batch (−50%, async)</option>
            </NativeSelect>
          </Field>
        </section>

        <section className="space-y-3 rounded-lg border border-line bg-panel p-4">
          <h2 className="text-sm font-medium">Currency</h2>
          <Field label="Display currency">
            <NativeSelect value={f.displayCurrency} onChange={(e) => setF({ ...f, displayCurrency: e.target.value })}>
              <option value="INR">INR (₹)</option>
              <option value="USD">USD ($)</option>
            </NativeSelect>
          </Field>
          <div className="flex items-center justify-between rounded-md border border-line bg-panel-2 px-3 py-2 text-xs">
            <span className="text-muted">
              {s?.usdToInr ? `1 USD = ₹${s.usdToInr}` : 'No rate yet'} {s?.usdToInrUpdatedAt ? `· updated ${formatDate(s.usdToInrUpdatedAt)}` : ''}
              {s?.usdToInrSource ? ` · ${s.usdToInrSource}` : ''}
            </span>
            <Button size="xs" variant="outline" onClick={() => fx.mutate()} loading={fx.isPending}>
              <RefreshCw /> Refresh rate
            </Button>
          </div>
        </section>

        <section className="space-y-3 rounded-lg border border-line bg-panel p-4">
          <h2 className="text-sm font-medium">Narration & TTS</h2>
          <div className="rounded-md border border-line bg-panel-2 px-3 py-2 text-[11px] text-muted">
            Story generation runs on the Python ai-service → <span className="font-mono">free-gemini-api</span> proxy (free, no API key). Scene detection uses the Python CV service.
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Narration language" hint="Global — applies to every project.">
              <NativeSelect value={f.narrationLanguage} onChange={(e) => setF({ ...f, narrationLanguage: e.target.value })}>
                {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Narration style" hint="Global — applies to every project.">
              <NativeSelect value={f.narrationMode} onChange={(e) => setF({ ...f, narrationMode: e.target.value })}>
                <option value="recap">Recap (condensed)</option>
                <option value="original">Original (full)</option>
              </NativeSelect>
            </Field>
          </div>
          <div className="rounded-md border border-line bg-panel-2 px-3 py-2 text-[11px] text-muted">
            Voices: local TTS engines (piper/kokoro) via ai-service — cloud TTS was removed.
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Hindi wpm"><Input type="number" value={f.wpmHi} onChange={(e) => setF({ ...f, wpmHi: e.target.value })} /></Field>
            <Field label="English wpm"><Input type="number" value={f.wpmEn} onChange={(e) => setF({ ...f, wpmEn: e.target.value })} /></Field>
            <Field label="Other wpm"><Input type="number" value={f.wpmDefault} onChange={(e) => setF({ ...f, wpmDefault: e.target.value })} /></Field>
          </div>
          <p className="text-[10px] text-muted">Used for narration duration and audio-cost estimates. Calibrate after your first real generation.</p>
        </section>

        <section className="space-y-3 rounded-lg border border-line bg-panel p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Price list</h2>
            <Badge tone="neutral">{pricing.data?.[0]?.version || ''}</Badge>
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto text-[11px]">
            {(pricing.data || []).map((p, i) => (
              <div key={i} className="flex items-center justify-between rounded bg-panel-2 px-2 py-1">
                <span className="font-mono">{p.model} <span className="text-muted">({p.kind}/{p.tier})</span></span>
                <span className="font-mono text-muted">
                  in {formatCost(p.inputPerMillion / 1e6 * 1e6)}/M → out {formatCost(p.outputPerMillion)}/M{p.audioTokensPerSecond ? ` · ${p.audioTokensPerSecond} tok/s audio` : ''}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <div className="mt-4">
        <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
          <Save /> Save settings
        </Button>
      </div>
    </div>
  );
};
