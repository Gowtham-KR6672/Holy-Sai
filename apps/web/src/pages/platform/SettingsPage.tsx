import { useEffect, useState } from 'react';
import { ApiError, api } from '@/api/client';
import { Button, Card, PageHead, QueryState, TextArea, TextField, useToast } from '@/components/ui';
import { useApiMutation, useApiQuery } from '@/hooks/useApi';

type Settings = Record<string, string | number>;

/** We School's billing details (on invoices), tax, renewal reminders and the email sender. */
export default function SettingsPage() {
  const q = useApiQuery<Settings>('/platform/settings');
  const toast = useToast();
  const [f, setF] = useState<Settings>({});
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const save = useApiMutation<Settings>('put', '/platform/settings', { invalidate: ['/platform/settings'] });
  const set = (k: string) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const v = (k: string) => String(f[k] ?? '');

  const testEmail = async () => {
    setTesting(true);
    try {
      await save.mutateAsync(f);
      const r = await api.post<{ sent: boolean }>('/platform/settings/test-email');
      toast(r.message, 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The email test failed', 'critical');
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <PageHead title="Platform settings" sub="Shown on invoices and used for renewal reminders" crumbs={false}
        actions={<Button variant="primary" icon="check" loading={save.isPending && !testing} onClick={() => save.mutate(f)}>Save</Button>} />
      <QueryState query={q}>
        {() => (
          <div className="col g-4">
            <Card title="Billing details" icon="receipt" sub="Printed on every invoice">
              <div className="form-grid">
                <TextField label="Legal name" value={v('billing.legal_name')} onChange={set('billing.legal_name')} />
                <TextField label="Support email" type="email" value={v('billing.support_email')} onChange={set('billing.support_email')} />
                <TextArea className="span-2" label="Address" rows={3} value={v('billing.address')} onChange={set('billing.address')} />
                <TextField label="Tax ID (GSTIN / VAT)" value={v('billing.tax_id')} onChange={set('billing.tax_id')} />
                <TextField label="Tax name" value={v('billing.tax_label')} onChange={set('billing.tax_label')} hint="e.g. GST or VAT" />
                <TextField label="Tax on INR plans (%)" type="number" min={0} step="0.01" value={v('billing.tax_percent_inr')} onChange={set('billing.tax_percent_inr')} hint="Added to the plan price, e.g. 18" />
                <TextField label="Tax on USD plans (%)" type="number" min={0} step="0.01" value={v('billing.tax_percent_usd')} onChange={set('billing.tax_percent_usd')} />
                <TextField label="Invoice number prefix" value={v('billing.invoice_prefix')} onChange={set('billing.invoice_prefix')} hint="Invoices are numbered PREFIX-YEAR-0001" />
              </div>
            </Card>
            <Card title="Renewals" icon="calendar">
              <div className="form-grid">
                <TextField label="Warn from (days before the end)" type="number" min={1} value={v('subscription.warning_days')} onChange={set('subscription.warning_days')} hint="Reminders at 15, 7, 3 and 1 days within this window" />
                <TextField label="Grace period (days)" type="number" min={0} value={v('subscription.grace_days')} onChange={set('subscription.grace_days')} hint="After this, only Workspace Admins can sign in (to renew)" />
              </div>
            </Card>
            <Card title="Email sender" icon="mail" sub="We School's own account for receipts and reminders (each school's emails use its own Integrations)."
              actions={<Button size="sm" icon="send" loading={testing} onClick={testEmail}>Save and send a test</Button>}>
              <div className="form-grid">
                <TextField label="SMTP host" value={v('email.smtp_host')} onChange={set('email.smtp_host')} placeholder="smtp.example.com" />
                <TextField label="Port" type="number" value={v('email.smtp_port')} onChange={set('email.smtp_port')} hint="587 (STARTTLS) or 465 (SSL)" />
                <TextField label="User" value={v('email.smtp_user')} onChange={set('email.smtp_user')} autoComplete="off" />
                <TextField label="Password" type="password" value={v('email.smtp_password')} onChange={set('email.smtp_password')} autoComplete="off" hint="Stored encrypted; leave as is to keep it" />
                <TextField className="span-2" label="From address" value={v('email.from_address')} onChange={set('email.from_address')} placeholder="We School <billing@weschool.example>" />
              </div>
            </Card>
          </div>
        )}
      </QueryState>
    </>
  );
}
