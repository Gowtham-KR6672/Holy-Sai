import { useEffect, useState } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { useApiMutation, useApiQuery } from '@/hooks/useApi';
import { Badge, Banner, Button, Card, ErrorState, Grid, Icon, Page, PageHead, PageSkeleton, SelectField, Switch, TextField } from '@/components/ui';
import { fmt } from '@/lib/format';

/**
 * Integrations (new in the rebuild): WhatsApp, SMS, email, payment gateway, push, GPS trackers, gate readers,
 * staff biometrics, maps and file storage. Secrets are encrypted and come back masked.
 */

interface Field { key: string; label: string; secret?: boolean; placeholder?: string }
interface Integration {
  kind: string; label: string; providers: string[]; provider: string | null; isEnabled: boolean; config: Record<string, string>;
  status: 'not_configured' | 'configured' | 'ok' | 'failed'; lastTestedAt: string | null; lastTestMessage: string | null;
}
interface Data { integrations: Integration[]; fields: Record<string, Field[]> }

const ICON: Record<string, string> = {
  whatsapp: 'message', sms: 'phone', email: 'mail', payment: 'creditCard', push: 'bell', gps: 'navigation', gate: 'door', biometric: 'scan', maps: 'mapPin', storage: 'folder',
};

const PURPOSE: Record<string, string> = {
  whatsapp: 'Absence alerts, receipts, circulars, admissions enquiries (WhatsApp AI).',
  sms: 'OTP for pickup verification and fallback alerts. Indian SMS needs a DLT-registered sender ID.',
  email: 'Critical alerts, reports and account messages.',
  payment: 'Parent "Pay Now" for fees (UPI, cards, net banking) and settlement reconciliation.',
  push: 'Notifications on the We School mobile app (iOS and Android).',
  gps: 'Student GPS tags, ID-card trackers and bus devices post locations to the ingest address below.',
  gate: 'Card and face readers at the gates post each scan to the webhook below.',
  biometric: 'Staff attendance devices post punches to the webhook below.',
  maps: 'Map tiles for student and bus tracking.',
  storage: 'Where uploaded documents, answer sheets and photos are kept.',
};

/** Provider callback addresses. Each school has its own (/api/w/<code>/…); GPS devices share one, their token finds the school. */
const ENDPOINT: Record<string, { label: string; path: string; shared?: boolean }> = {
  payment: { label: 'Webhook URL (Razorpay → Settings → Webhooks)', path: '/api/finance/webhooks/razorpay' },
  gps: { label: 'Device ingest URL (device token in the X-Device-Token header)', path: '/api/tracking/ingest', shared: true },
  gate: { label: 'Reader webhook URL (send the webhook secret in the X-Webhook-Secret header)', path: '/api/gate/webhooks/scan' },
  biometric: { label: 'Device webhook URL (send the webhook secret in the X-Webhook-Secret header)', path: '/api/workforce/webhooks/biometric' },
  whatsapp: { label: 'Webhook callback URL (Meta → WhatsApp → Configuration)', path: '/api/whatsapp/webhook' },
};

const STATUS: Record<Integration['status'], { tone: string; label: string }> = {
  not_configured: { tone: 'neutral', label: 'Not configured' },
  configured: { tone: 'info', label: 'Configured' },
  ok: { tone: 'success', label: 'Working' },
  failed: { tone: 'critical', label: 'Failed' },
};

export default function IntegrationsPage() {
  const q = useApiQuery<Data>('/admin/integrations');
  if (q.isLoading) return <Page><PageSkeleton /></Page>;
  if (q.error || !q.data) return <Page><PageHead title="Integrations" /><ErrorState error={q.error} onRetry={() => q.refetch()} /></Page>;
  const working = q.data.integrations.filter((i) => i.isEnabled && (i.status === 'ok' || i.status === 'configured')).length;
  return (
    <Page>
      <PageHead title="Integrations" sub={`External services the school connects. ${working} of ${q.data.integrations.length} enabled. Secrets are stored encrypted and shown masked.`} />
      <div className="mb-4">
        <Banner tone="neutral" icon="info">Each service needs an account with that provider. Enter the provider's credentials, save, then use <strong>Test</strong>. Messages are recorded with their delivery state.</Banner>
      </div>
      <Grid cols="g-2col">
        {q.data.integrations.map((i) => <IntegrationCard key={i.kind} item={i} fields={q.data.fields[i.kind] ?? []} />)}
      </Grid>
    </Page>
  );
}

function IntegrationCard({ item, fields }: { item: Integration; fields: Field[] }) {
  const school = useAuth().user?.workspace?.code;
  const [f, setF] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState(item.provider ?? '');
  const [enabled, setEnabled] = useState(item.isEnabled);
  useEffect(() => {
    setF(Object.fromEntries(fields.map((x) => [x.key, item.config[x.key] ?? ''])));
    setProvider(item.provider ?? item.providers[0] ?? '');
    setEnabled(item.isEnabled);
  }, [item, fields]);
  const save = useApiMutation('put', `/admin/integrations/${item.kind}`, {
    invalidate: ['/admin/integrations', '/public/config'],
    body: () => ({ provider, isEnabled: enabled, config: f }),
  });
  const test = useApiMutation('post', `/admin/integrations/${item.kind}/test`, { invalidate: ['/admin/integrations'] });
  const st = STATUS[item.status];
  const endpoint = ENDPOINT[item.kind];
  return (
    <Card icon={ICON[item.kind] ?? 'link'} title={item.label} sub={PURPOSE[item.kind]}
      actions={<Badge tone={st.tone}>{st.label}</Badge>}
      foot={
        <div className="row g-2 wrap">
          <Button variant="primary" icon="save" loading={save.isPending} onClick={() => save.mutate({})}>Save</Button>
          <Button icon="activity" loading={test.isPending} disabled={item.status === 'not_configured' && !save.isSuccess} onClick={() => test.mutate({})}>Test</Button>
          {item.lastTestedAt && <span className="t-xs t-muted">Last test {fmt.dateTime(item.lastTestedAt)}</span>}
        </div>
      }>
      <div className="col g-3">
        <div className="grid g-2col g-3">
          <SelectField label="Provider" value={provider} onChange={setProvider} options={item.providers} />
          <div className="field" style={{ justifyContent: 'flex-end' }}><Switch checked={enabled} onChange={setEnabled} label={enabled ? 'Enabled' : 'Disabled'} /></div>
        </div>
        <div className="grid g-2col g-3">
          {fields.map((x) => (
            <TextField key={x.key} label={x.label} type={x.secret ? 'password' : 'text'} autoComplete="new-password" name={`${item.kind}-${x.key}`}
              value={f[x.key] ?? ''} placeholder={x.placeholder} onChange={(v) => setF((s) => ({ ...s, [x.key]: v }))}
              hint={x.secret && item.config[x.key] ? 'Saved — type to replace' : undefined} />
          ))}
        </div>
        {endpoint && (
          <div className="t-xs">
            <div className="t-muted">{endpoint.label}</div>
            <code className="t-mono oi-code" style={{ wordBreak: 'break-all' }}>{window.location.origin}{endpoint.shared || !school ? endpoint.path : endpoint.path.replace('/api/', `/api/w/${school}/`)}</code>
          </div>
        )}
        {item.lastTestMessage && (
          <div className={`row g-2 t-xs ${item.status === 'failed' ? 't-critical' : 't-muted'}`}>
            <Icon name={item.status === 'failed' ? 'alertCircle' : 'info'} size={14} />
            <span>{item.lastTestMessage}</span>
          </div>
        )}
      </div>
    </Card>
  );
}
