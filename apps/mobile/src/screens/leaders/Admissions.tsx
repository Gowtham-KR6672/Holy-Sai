import { useState } from 'react';
import { Linking, View } from 'react-native';
import { useApiQuery, usePagedQuery, useRefresh } from '@/api/hooks';
import { useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import {
  Badge, Button, Card, Chips, Empty, ErrorState, Field, Kpi, KpiGrid, ListItem, Loading, Meter, Row, Screen, Sheet, StatusBadge, Txt,
} from '@/components/ui';
import { fmt } from '@/lib/format';
import { useNav } from '@/lib/navigation';
import { space } from '@/theme/theme';

interface Dashboard {
  kpis: { enquiries: number; qualified: number; qualifiedPct: number; visits: number; visitsThisWeek: number; applications: number; awaitingDocuments: number; offers: number; offersExpiring: number; admitted: number; target: number | null; conversion: number };
  funnel: { label: string; value: number }[];
  attention: { tone: string; icon: string; title: string; meta: string; lead?: string; route?: string }[];
}
interface Lead {
  id: string; code: string; parentName: string; phone: string; email: string | null; studentName: string; grade: string; source: string; stage: string;
  score: number; counsellor: string | null; nextAction: string | null; nextActionAt: string | null; overdue: boolean; campusName: string; createdAt: string;
}
const STAGES = ['New Lead', 'Contacted', 'Qualified', 'Visit Scheduled', 'Visit Completed', 'Application', 'Assessment', 'Offer', 'Enrolled'];

/** Admissions for the office: GET /admissions/dashboard and the leads list GET /enquiries (paged, q, stage, overdue). */
export default function AdmissionsScreen() {
  const user = useUser();
  const { t } = useI18n();
  const { openWeb } = useNav();
  const { refreshing, onRefresh } = useRefresh();
  const campus = user.campusId ? { campusId: user.campusId } : {};
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('All');
  const [overdue, setOverdue] = useState(false);
  const [lead, setLead] = useState<Lead | null>(null);
  const dash = useApiQuery<Dashboard>('/admissions/dashboard', campus);
  const leads = usePagedQuery<Lead>('/enquiries', { q: q || undefined, stage: stage === 'All' ? undefined : stage, overdue: overdue ? 'true' : undefined, sort: 'created', dir: 'desc', pageSize: 30, ...campus });
  const k = dash.data?.kpis;
  const top = Math.max(1, ...(dash.data?.funnel ?? []).map((f) => f.value));

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      {dash.error ? <Card><ErrorState error={dash.error} onRetry={() => void dash.refetch()} /></Card> : !k ? <Loading height={120} /> : (
        <>
          <KpiGrid>
            <Kpi icon="list" label={t('Enquiries')} value={fmt.n(k.enquiries)} foot={t('{n}% qualified', { n: Math.round(k.qualifiedPct) })} />
            <Kpi icon="mapPin" label={t('Campus visits')} value={fmt.n(k.visits)} foot={t('{n} this week', { n: k.visitsThisWeek })} />
            <Kpi icon="fileText" label={t('Applications')} value={fmt.n(k.applications)} tone="info" foot={t('{n} awaiting documents', { n: k.awaitingDocuments })} />
            <Kpi icon="graduation" label={t('Admitted')} value={fmt.n(k.admitted)} tone="success" foot={k.target ? t('of {n} target · {pct}% conversion', { n: k.target, pct: k.conversion }) : t('{pct}% conversion', { pct: k.conversion })} />
          </KpiGrid>
          {dash.data!.funnel.length > 0 && (
            <Card title={t('Admissions funnel')} icon="target">
              {dash.data!.funnel.map((f) => <Meter key={f.label} label={t(f.label)} value={(f.value / top) * 100} right={fmt.n(f.value)} />)}
            </Card>
          )}
          {dash.data!.attention.length > 0 && (
            <Card title={t('Needs attention')} icon="alert">
              {dash.data!.attention.slice(0, 6).map((a, i) => (
                <ListItem key={`${a.title}-${i}`} icon={a.icon} tone={a.tone === 'critical' ? 'critical' : a.tone === 'warning' ? 'warning' : 'info'} title={a.title} meta={a.meta}
                  onPress={a.route ? () => openWeb(a.route!) : undefined} />
              ))}
            </Card>
          )}
        </>
      )}

      <Txt variant="h3">{t('Leads')}</Txt>
      <Field label={t('Search')} placeholder={t('Search student, parent or reference')} value={search} onChangeText={setSearch}
        onSubmitEditing={() => setQ(search.trim())} onBlur={() => setQ(search.trim())} returnKeyType="search" autoCorrect={false} />
      <Chips items={[{ id: 'All', label: t('Any stage') }, ...STAGES.map((s) => ({ id: s, label: t(s) })), { id: 'Lost', label: t('Lost') }]} value={stage} onChange={setStage} />
      <Row gap={space.sm}>
        <Button size="sm" variant={overdue ? 'primary' : 'secondary'} icon="clock" label={t('Overdue follow-ups only')} onPress={() => setOverdue((v) => !v)} />
        {leads.data && <Txt variant="micro">{t('{n} leads', { n: leads.data.meta.total })}</Txt>}
      </Row>
      <Card flush>
        <View style={{ paddingHorizontal: space.lg }}>
          {leads.isLoading ? <Loading /> : leads.error ? <ErrorState error={leads.error} onRetry={() => void leads.refetch()} /> : leads.data?.rows.length ? leads.data.rows.map((l) => (
            <ListItem key={l.id} icon="user" tone={l.overdue ? 'critical' : undefined} title={`${l.studentName} · ${l.grade}`}
              meta={`${l.parentName} · ${t(l.source)} · ${l.counsellor ?? t('Unassigned')}${l.nextActionAt ? ` · ${t('next {date}', { date: fmt.dateShort(l.nextActionAt) })}` : ''}`}
              right={<StatusBadge value={l.stage} />} onPress={() => setLead(l)} />
          )) : <Empty icon="list" title={t('No leads match the current filters.')} />}
        </View>
      </Card>

      <Sheet visible={!!lead} onClose={() => setLead(null)} title={lead ? lead.studentName : ''} sub={lead ? `${lead.code} · ${lead.grade} · ${lead.campusName}` : undefined}
        footer={lead ? <Button label={t('Open in the web portal')} icon="external" onPress={() => { openWeb(`/leads?lead=${encodeURIComponent(lead.code)}`); setLead(null); }} /> : undefined}>
        {lead && (
          <>
            <Row gap={6} wrap><StatusBadge value={lead.stage} /><Badge label={t('Score {n}', { n: lead.score })} tone="brand" />{lead.overdue && <Badge label={t('Follow-up overdue')} tone="critical" />}</Row>
            <ListItem icon="user" title={lead.parentName} meta={[lead.phone, lead.email].filter(Boolean).join(' · ')} />
            <ListItem icon="target" title={t('Source')} meta={t(lead.source)} />
            <ListItem icon="users" title={t('Counsellor')} meta={lead.counsellor ?? t('Unassigned')} />
            {lead.nextAction ? <ListItem icon="clock" title={t('Next action')} meta={`${lead.nextAction}${lead.nextActionAt ? ` · ${fmt.dateTime(lead.nextActionAt)}` : ''}`} /> : null}
            <ListItem icon="calendar" title={t('Enquired')} meta={fmt.date(lead.createdAt)} />
            <Row gap={space.sm}>
              <Button size="sm" icon="phone" label={t('Call')} onPress={() => void Linking.openURL(`tel:${lead.phone}`)} />
              <Button size="sm" icon="message" label={t('WhatsApp')} onPress={() => void Linking.openURL(`https://wa.me/${lead.phone.replace(/[^0-9]/g, '')}`)} />
            </Row>
          </>
        )}
      </Sheet>
    </Screen>
  );
}
