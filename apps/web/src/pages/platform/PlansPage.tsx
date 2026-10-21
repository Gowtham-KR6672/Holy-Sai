import { useEffect, useState } from 'react';
import { Button, Card, DataTable, PageHead, Switch, TextField } from '@/components/ui';
import { useApiMutation, useApiQuery } from '@/hooks/useApi';

interface Plan {
  code: string;
  name: string;
  months: number;
  priceInr: number;
  priceUsd: number;
  isActive: boolean;
}

/** Plan prices in INR and USD. A plan with price 0 cannot be paid online. */
export default function PlansPage() {
  const q = useApiQuery<Plan[]>('/platform/plans');
  const [edits, setEdits] = useState<Record<string, { priceInr: string; priceUsd: string; isActive: boolean }>>({});
  useEffect(() => {
    if (q.data) setEdits(Object.fromEntries(q.data.map((p) => [p.code, { priceInr: String(p.priceInr), priceUsd: String(p.priceUsd), isActive: p.isActive }])));
  }, [q.data]);
  const save = useApiMutation<{ code: string; priceInr: number; priceUsd: number; isActive: boolean }>('put', (v) => `/platform/plans/${v.code}`, {
    invalidate: ['/platform/plans'],
    body: (v) => ({ priceInr: v.priceInr, priceUsd: v.priceUsd, isActive: v.isActive }),
  });
  const set = (code: string, k: 'priceInr' | 'priceUsd' | 'isActive', v: string | boolean) => setEdits((e) => ({ ...e, [code]: { ...e[code], [k]: v } }));

  return (
    <>
      <PageHead title="Plans and prices" sub="Prices before tax. Schools billed in INR pay the INR price (Razorpay); schools billed in USD pay the USD price (Stripe, PayPal, Razorpay International)." crumbs={false} />
      <Card flush>
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          rowKey={(p) => p.code}
          columns={[
            { key: 'name', label: 'Plan', render: (p) => <><span className="t-bold">{p.name}</span><div className="t-micro t-muted">{p.months} month{p.months === 1 ? '' : 's'}</div></> },
            { key: 'priceInr', label: 'Price (INR)', render: (p) => <TextField label="" aria-label={`${p.name} price in rupees`} type="number" min={0} step="1" value={edits[p.code]?.priceInr ?? ''} onChange={(v) => set(p.code, 'priceInr', v)} style={{ maxWidth: 160 }} /> },
            { key: 'priceUsd', label: 'Price (USD)', render: (p) => <TextField label="" aria-label={`${p.name} price in dollars`} type="number" min={0} step="0.01" value={edits[p.code]?.priceUsd ?? ''} onChange={(v) => set(p.code, 'priceUsd', v)} style={{ maxWidth: 160 }} /> },
            { key: 'isActive', label: 'Offered', render: (p) => <Switch checked={edits[p.code]?.isActive ?? p.isActive} onChange={(v) => set(p.code, 'isActive', v)} label="" /> },
            {
              key: 'save', label: '', render: (p) => {
                const e = edits[p.code];
                const changed = e && (Number(e.priceInr) !== p.priceInr || Number(e.priceUsd) !== p.priceUsd || e.isActive !== p.isActive);
                return <Button size="sm" variant={changed ? 'primary' : 'ghost'} disabled={!changed} loading={save.isPending && save.variables?.code === p.code} onClick={() => save.mutate({ code: p.code, priceInr: Number(e.priceInr) || 0, priceUsd: Number(e.priceUsd) || 0, isActive: e.isActive })}>Save</Button>;
              },
            },
          ]}
        />
      </Card>
    </>
  );
}
