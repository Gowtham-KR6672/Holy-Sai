import { useState } from 'react';
import { ApiError } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/hooks/useApi';
import {
  Badge, Banner, Button, Card, Checkbox, DataTable, Empty, ErrorState, Grid, InlineError, Modal, Page, PageHead, PageSkeleton, SelectField, Switch, TextField, useConfirm,
} from '@/components/ui';
import { fmt } from '@/lib/format';

/**
 * AI providers (new in the rebuild): the Super Admin connects Claude, Gemini, OpenAI, Groq or OpenRouter and chooses
 * which provider serves each AI feature. Keys are stored encrypted and never sent back to the browser.
 */

interface Provider {
  id: string; provider: string; label: string; model: string; visionModel: string | null; baseUrl: string | null; keyPreview: string;
  isEnabled: boolean; isDefault: boolean; purposes: string[]; timeoutSec: number; maxRetries: number;
  lastTestedAt: string | null; lastTestOk: boolean | null; lastTestMessage: string | null;
}
interface CatalogItem { id: string; label: string; defaultModel: string; baseUrl: string }
interface Purpose { id: string; label: string }
interface Data { providers: Provider[]; coverage: Record<string, string | null>; catalog: CatalogItem[]; purposes: Purpose[] }

const KEY_HINT: Record<string, string> = {
  claude: 'Starts with sk-ant- (console.anthropic.com → API keys).',
  gemini: 'Google AI Studio → Get API key.',
  openai: 'Starts with sk- (platform.openai.com → API keys).',
  groq: 'Starts with gsk_ (console.groq.com → API keys).',
  openrouter: 'Starts with sk-or- (openrouter.ai → Keys).',
};

const MODEL_HINT: Record<string, string> = {
  claude: 'e.g. claude-sonnet-5-5, claude-opus-5-5 or claude-haiku-5-5',
  gemini: 'e.g. gemini-2.5-flash or gemini-2.5-pro',
  openai: 'e.g. gpt-4.1-mini or gpt-4.1',
  groq: 'e.g. llama-3.3-70b-versatile',
  openrouter: 'e.g. openrouter/auto or anthropic/claude-sonnet-5-5',
};

const EMPTY = { provider: 'claude', label: '', apiKey: '', model: '', visionModel: '', baseUrl: '', purposes: [] as string[], isDefault: false, timeoutSec: '120', maxRetries: '2', isEnabled: true };

export default function AiProvidersPage() {
  const confirm = useConfirm();
  const q = useApiQuery<Data>('/admin/ai-providers');
  const [edit, setEdit] = useState<Provider | 'new' | null>(null);
  const [f, setF] = useState(EMPTY);
  const save = useApiMutation<typeof f>(edit && edit !== 'new' ? 'patch' : 'post', edit && edit !== 'new' ? `/admin/ai-providers/${edit.id}` : '/admin/ai-providers', {
    invalidate: ['/admin/ai-providers'], error: false,
    body: (v) => ({
      ...(edit === 'new' ? { provider: v.provider } : {}),
      label: v.label || undefined, apiKey: v.apiKey.trim() || undefined, model: v.model || undefined,
      visionModel: v.visionModel, baseUrl: v.baseUrl, purposes: v.purposes, isDefault: v.isDefault,
      timeoutSec: Number(v.timeoutSec) || 120, maxRetries: Number(v.maxRetries) || 0,
      ...(edit !== 'new' ? { isEnabled: v.isEnabled } : {}),
    }),
    onSuccess: () => setEdit(null),
  });
  const test = useApiMutation<string>('post', (id) => `/admin/ai-providers/${id}/test`, { invalidate: ['/admin/ai-providers'] });
  const toggle = useApiMutation<{ id: string; isEnabled: boolean }>('patch', (v) => `/admin/ai-providers/${v.id}`, { invalidate: ['/admin/ai-providers'], body: (v) => ({ isEnabled: v.isEnabled }), success: false });
  const remove = useApiMutation<string>('delete', (id) => `/admin/ai-providers/${id}`, { invalidate: ['/admin/ai-providers'] });

  if (q.isLoading) return <Page><PageSkeleton /></Page>;
  if (q.error || !q.data) return <Page><PageHead title="AI providers" /><ErrorState error={q.error} onRetry={() => q.refetch()} /></Page>;
  const d = q.data;
  const catalog = (id: string) => d.catalog.find((c) => c.id === id);
  const err = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const open = (p: Provider | 'new') => {
    setEdit(p);
    save.reset();
    setF(p === 'new' ? EMPTY : {
      provider: p.provider, label: p.label, apiKey: '', model: p.model, visionModel: p.visionModel ?? '', baseUrl: p.baseUrl ?? '',
      purposes: p.purposes, isDefault: p.isDefault, timeoutSec: String(p.timeoutSec), maxRetries: String(p.maxRetries), isEnabled: p.isEnabled,
    });
  };
  const keyMissing = edit === 'new' && f.apiKey.trim().length < 8;

  return (
    <Page>
      <PageHead
        title="AI providers"
        sub="Connect one or more AI services and choose which one powers each feature. Every AI output is a suggestion that a named person reviews."
        actions={<Button variant="primary" icon="plus" onClick={() => open('new')}>Connect provider</Button>}
      />
      {d.providers.length === 0 && (
        <div className="mb-4">
          <Banner tone="warning" icon="sparkle">No AI provider is connected yet. The Co-Pilot, School Knowledge AI, Paper Correction, report comments and WhatsApp AI stay unavailable until one is connected.</Banner>
        </div>
      )}
      <Grid cols="g-main">
        <Card icon="sparkle" title="Connected providers" sub={`${d.providers.length} connected`} flush>
          {d.providers.length === 0 ? (
            <Empty icon="sparkle" title="Nothing connected" sub="Claude, Gemini, OpenAI, Groq and OpenRouter are supported." action={<Button variant="primary" icon="plus" onClick={() => open('new')}>Connect provider</Button>} />
          ) : (
            <DataTable rows={d.providers} rowKey={(r) => r.id}
              columns={[
                { key: 'name', label: 'Provider', render: (r) => (
                  <>
                    <span className="t-bold">{r.label}</span> {r.isDefault && <Badge tone="info">Default</Badge>}
                    <div className="t-micro t-muted">{catalog(r.provider)?.label ?? r.provider} · {r.model}{r.visionModel ? ` · vision ${r.visionModel}` : ''} · key {r.keyPreview}</div>
                  </>
                ) },
                { key: 'features', label: 'Features', render: (r) => (r.purposes.length
                  ? <span className="row g-1 wrap">{r.purposes.map((p) => <span key={p} className="tag">{d.purposes.find((x) => x.id === p)?.label ?? p}</span>)}</span>
                  : <span className="t-xs t-muted">{r.isDefault ? 'All features without their own provider' : 'None assigned'}</span>) },
                { key: 'test', label: 'Connection', render: (r) => (
                  <div className="col">
                    {r.lastTestOk == null ? <Badge>Not tested</Badge> : <Badge tone={r.lastTestOk ? 'success' : 'critical'}>{r.lastTestOk ? 'Working' : 'Failed'}</Badge>}
                    {r.lastTestMessage && <span className="t-micro t-muted t-clip" style={{ maxWidth: 260 }} title={r.lastTestMessage}>{r.lastTestMessage}</span>}
                    {r.lastTestedAt && <span className="t-micro t-faint">{fmt.dateTime(r.lastTestedAt)}</span>}
                  </div>
                ) },
                { key: 'on', label: 'Enabled', render: (r) => <Switch checked={r.isEnabled} onChange={(v) => toggle.mutate({ id: r.id, isEnabled: v })} label={r.isEnabled ? 'On' : 'Off'} /> },
                { key: 'actions', label: '', className: 'num', render: (r) => (
                  <div className="row g-2 end wrap">
                    <Button size="sm" icon="activity" loading={test.isPending && test.variables === r.id} onClick={() => test.mutate(r.id)}>Test</Button>
                    <Button size="sm" icon="edit" onClick={() => open(r)}>Edit</Button>
                    <Button size="sm" variant="danger" icon="trash" aria-label={`Remove ${r.label}`} onClick={async () => {
                      if (await confirm({ title: `Remove ${r.label}?`, body: 'Features using it switch to the default provider, or become unavailable if none is left.', confirmLabel: 'Remove', danger: true })) remove.mutate(r.id);
                    }} />
                  </div>
                ) },
              ]} />
          )}
        </Card>
        <Card icon="layers" title="Feature coverage" sub="Which provider answers each feature">
          <div className="col g-2">
            {d.purposes.map((p) => {
              const pid = d.coverage[p.id];
              const prov = d.providers.find((x) => x.id === pid);
              return (
                <div key={p.id} className="row between g-2">
                  <span className="t-sm">{p.label}</span>
                  {prov ? <Badge tone="success">{prov.label}</Badge> : <Badge tone="warning">Not available</Badge>}
                </div>
              );
            })}
          </div>
          <p className="t-xs t-muted mt-4">A feature uses the provider assigned to it; otherwise the default provider; otherwise any enabled provider.</p>
        </Card>
      </Grid>
      <div className="mt-4">
        <Banner tone="neutral" icon="shield">Student work, names and records are sent to the provider you choose when a feature is used. Make sure the school's consent and data-processing arrangements cover this. Keys are encrypted at rest and never shown again.</Banner>
      </div>

      <Modal open={!!edit} onClose={() => setEdit(null)} size="wide" busy={save.isPending}
        title={edit === 'new' ? 'Connect an AI provider' : `Edit ${edit?.label ?? ''}`}
        sub="The connection is tested as soon as you save."
        foot={<><Button onClick={() => setEdit(null)} disabled={save.isPending}>Cancel</Button><Button variant="primary" icon="save" loading={save.isPending} disabled={keyMissing} onClick={() => save.mutate(f)}>Save and test</Button></>}>
        {save.error && !Object.keys(err).length && <div className="mb-4"><InlineError error={save.error} /></div>}
        <div className="formsection">
          <div className="formsection__title">Provider</div>
          <div className="form-grid">
            <SelectField label="Service" required value={f.provider} disabled={edit !== 'new'} onChange={(v) => setF((x) => ({ ...x, provider: v, model: '' }))}
              options={d.catalog.map((c) => ({ value: c.id, label: c.label }))} />
            <TextField label="Display name" value={f.label} onChange={set('label')} placeholder={catalog(f.provider)?.label} />
            <TextField className="span-2" label="API key" type="password" autoComplete="new-password" name="ai-api-key" required={edit === 'new'} value={f.apiKey} onChange={set('apiKey')} error={err.apiKey}
              placeholder={edit !== 'new' && edit ? `set (${edit.keyPreview}) — type to replace` : ''} hint={KEY_HINT[f.provider]} />
            <TextField label="Model" value={f.model} onChange={set('model')} placeholder={catalog(f.provider)?.defaultModel} hint={MODEL_HINT[f.provider]} />
            <TextField label="Vision model (reading handwriting)" value={f.visionModel} onChange={set('visionModel')} placeholder="Same as model" hint="Used by Paper Correction to read answer sheets." />
            <TextField className="span-2" label="Base URL" value={f.baseUrl} onChange={set('baseUrl')} placeholder={catalog(f.provider)?.baseUrl} hint="Leave empty for the provider's standard address." />
          </div>
        </div>
        <div className="formsection">
          <div className="formsection__title">Features</div>
          <div className="grid g-2col g-2">
            {d.purposes.map((p) => (
              <Checkbox key={p.id} checked={f.purposes.includes(p.id)} label={p.label}
                onChange={(v) => setF((x) => ({ ...x, purposes: v ? [...x.purposes, p.id] : x.purposes.filter((y) => y !== p.id) }))} />
            ))}
          </div>
          <div className="mt-3"><Switch checked={f.isDefault} onChange={set('isDefault')} label="Default provider (used by features without their own provider)" /></div>
          {edit !== 'new' && <div className="mt-2"><Switch checked={f.isEnabled} onChange={set('isEnabled')} label="Enabled" /></div>}
        </div>
        <div className="formsection">
          <div className="formsection__title">Reliability</div>
          <div className="form-grid">
            <TextField label="Timeout (seconds)" type="number" min={10} max={900} value={f.timeoutSec} onChange={set('timeoutSec')} />
            <TextField label="Retries for temporary failures" type="number" min={0} max={5} value={f.maxRetries} onChange={set('maxRetries')} />
          </div>
        </div>
      </Modal>
    </Page>
  );
}
