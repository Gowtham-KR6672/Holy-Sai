import { useState } from 'react';
import { ApiError, api } from '@/api/client';
import { Badge, Button, Card, Dl, PageHead, QueryState, SelectField, Switch, TextField, useToast } from '@/components/ui';
import { useApiQuery } from '@/hooks/useApi';
import { fmt } from '@/lib/format';
import { useQueryClient } from '@tanstack/react-query';

interface Field {
  key: string;
  label: string;
  hint?: string;
}

interface Gateway {
  gateway: string;
  label: string;
  currency: string;
  webhookPath: string;
  fields: Field[];
  secretFields: Field[];
  isEnabled: boolean;
  mode: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

/** We School's own payment gateway accounts for subscriptions (not the schools' fee gateways). */
export default function GatewaysPage() {
  const q = useApiQuery<Gateway[]>('/platform/gateways');
  return (
    <>
      <PageHead
        title="Payment gateways"
        sub="We School's own accounts for subscription payments. INR schools pay through Razorpay; USD schools through Stripe, PayPal or Razorpay International. Keys are stored encrypted."
        crumbs={false}
      />
      <QueryState query={q}>{(rows) => <div className="col g-4">{rows.map((g) => <GatewayCard key={g.gateway} g={g} />)}</div>}</QueryState>
    </>
  );
}

function GatewayCard({ g }: { g: Gateway }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ isEnabled: g.isEnabled, mode: g.mode, config: { ...g.config }, secrets: { ...g.secrets } });
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [errors, setErrors] = useState<string | null>(null);
  const webhook = `${window.location.origin}${g.webhookPath}`;

  const save = async () => {
    setBusy('save');
    setErrors(null);
    try {
      await api.put(`/platform/gateways/${g.gateway}`, f);
      toast(`${g.label} saved`, 'success');
      await qc.invalidateQueries({ queryKey: ['/platform/gateways'] });
    } catch (err) {
      setErrors(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy('test');
    try {
      const r = await api.post<{ message: string }>(`/platform/gateways/${g.gateway}/test`);
      toast(r.data.message, 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Test failed', 'critical');
    } finally {
      setBusy(null);
      await qc.invalidateQueries({ queryKey: ['/platform/gateways'] });
    }
  };

  return (
    <Card
      title={<span className="row g-2" style={{ display: 'inline-flex' }}>{g.label} <Badge tone="neutral">{g.currency}</Badge>{g.isEnabled ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>}</span>}
      icon="creditCard"
      actions={<><Button size="sm" icon="zap" loading={busy === 'test'} disabled={!!busy} onClick={test}>Test</Button><Button size="sm" variant="primary" icon="check" loading={busy === 'save'} disabled={!!busy} onClick={save}>Save</Button></>}
    >
      {errors && <p className="t-sm" style={{ color: 'var(--critical)' }}>{errors}</p>}
      <div className="form-grid">
        <div className="field"><Switch checked={f.isEnabled} onChange={(v) => setF((x) => ({ ...x, isEnabled: v }))} label="Schools can pay with this gateway" /></div>
        <SelectField label="Mode" value={f.mode} onChange={(v) => setF((x) => ({ ...x, mode: v }))} options={[{ value: 'test', label: 'Test / sandbox' }, { value: 'live', label: 'Live' }]} />
        {g.fields.map((fd) => (
          <TextField key={fd.key} label={fd.label} hint={fd.hint} value={f.config[fd.key] ?? ''} onChange={(v) => setF((x) => ({ ...x, config: { ...x.config, [fd.key]: v } }))} />
        ))}
        {g.secretFields.map((fd) => (
          <TextField key={fd.key} label={fd.label} hint={fd.hint ?? 'Stored encrypted; leave as is to keep it'} type="password" autoComplete="off"
            value={f.secrets[fd.key] ?? ''} onChange={(v) => setF((x) => ({ ...x, secrets: { ...x.secrets, [fd.key]: v } }))} />
        ))}
      </div>
      <div className="mt-4">
        <Dl items={[
          ['Webhook URL', <code key="w">{webhook}</code>],
          ['Last test', g.lastTestedAt ? <span key="t">{g.lastTestOk ? <Badge tone="success">OK</Badge> : <Badge tone="critical">Failed</Badge>} {fmt.dateTime(g.lastTestedAt)} — {g.lastTestMessage}</span> : 'Not tested yet'],
        ]} />
      </div>
    </Card>
  );
}
