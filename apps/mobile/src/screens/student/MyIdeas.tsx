import { useState } from 'react';
import { ApiError } from '@/api/client';
import { useApiMutation, useApiQuery, useRefresh } from '@/api/hooks';
import { useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { Badge, Banner, Button, Card, Empty, ErrorState, Field, Kpi, KpiGrid, Loading, Row, Screen, Select, Sheet, StatusBadge, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';
import { space } from '@/theme/theme';

interface MyIdea {
  id: string; title: string; problem: string | null; category: string | null; status: string; submittedOn: string; reviewedBy: string | null;
  ageDays: number; projectId: string | null; projectCode: string | null; projectStage: number | null;
}
const AREAS = ['Robotics & electronics', 'Software & apps', 'Environment & sustainability', 'Health & wellbeing', 'Community & social', 'Other'];
const MENTOR = ['Yes, please assign one', 'I already have one in mind', 'Not yet'];

/** What the student should expect next, in their own words (as on the web page). */
function nextStep(idea: MyIdea): { text: string; vars?: Record<string, string> } {
  if (idea.projectId) return { text: 'This became a project — open it to see your milestones.' };
  switch (idea.status) {
    case 'Submitted':
      return { text: idea.ageDays > 7 ? 'Still waiting for a teacher. Ask your class teacher if it has been a while.' : 'Waiting for a teacher to pick it up. Usually within a week.' };
    case 'Under Review': return { text: '{name} is reading it now.', vars: { name: idea.reviewedBy ?? 'A teacher' } };
    case 'Accepted': return { text: 'Accepted. A mentor will be assigned so you can start building.' };
    case 'Declined': return { text: 'Not taken forward this time. Ask your teacher what would make it stronger.' };
    default: return { text: '' };
  }
}

/** My Ideas: GET /me/ideas, POST /me/ideas { title, problem, category, wantsMentor }. */
export default function MyIdeasScreen() {
  const user = useUser();
  const { t } = useI18n();
  const { refreshing, onRefresh } = useRefresh();
  const [open, setOpen] = useState(false);
  const q = useApiQuery<MyIdea[]>(user.studentId ? '/me/ideas' : null);

  if (!user.studentId) return <Screen><Card><Empty icon="user" title={t('No student record is linked to this account')} sub={t('Please contact the school office.')} /></Card></Screen>;
  const ideas = q.data ?? [];
  const waiting = ideas.filter((i) => i.status === 'Submitted' || i.status === 'Under Review').length;

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <Txt variant="small">{t('Have an idea for something to build, fix or improve? Submit it here — a teacher reviews it within a week.')}</Txt>
      <Button label={t('Submit an idea')} icon="lightbulb" variant="primary" onPress={() => setOpen(true)} block />
      {q.isLoading ? <Loading /> : q.error ? <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card> : !ideas.length ? (
        <Card><Empty icon="lightbulb" title={t('You have not submitted an idea yet')} sub={t('It does not have to be finished or perfect — describe the problem and a teacher will help you shape it.')} /></Card>
      ) : (
        <>
          <KpiGrid>
            <Kpi icon="lightbulb" label={t('Ideas submitted')} value={ideas.length} />
            <Kpi icon="clock" label={t('Waiting for review')} value={waiting} tone={waiting ? 'warning' : undefined} />
            <Kpi icon="check" label={t('Accepted')} value={ideas.filter((i) => i.status === 'Accepted').length} tone="success" />
            <Kpi icon="rocket" label={t('Became projects')} value={ideas.filter((i) => i.projectId).length} tone="success" />
          </KpiGrid>
          {ideas.map((i) => {
            const next = nextStep(i);
            return (
              <Card key={i.id} title={i.title} sub={`${t(i.category ?? 'Other')} · ${t('submitted {date}', { date: fmt.date(i.submittedOn) })}`} right={<StatusBadge value={i.status} />}>
                {i.problem ? <Txt variant="body">{i.problem}</Txt> : null}
                <Row gap={6} wrap>
                  {['Idea', 'Review', 'Mentor', 'Project'].map((step, idx) => {
                    const done = idx === 0 || (idx === 1 && i.status !== 'Submitted') || (idx === 2 && !!i.projectId) || (idx === 3 && !!i.projectId);
                    const active = (idx === 1 && i.status === 'Submitted') || (idx === 2 && i.status === 'Accepted' && !i.projectId);
                    return <Badge key={step} label={t(step)} tone={done ? 'success' : active ? 'warning' : 'neutral'} />;
                  })}
                </Row>
                {next.text ? <Txt variant="small">{t(next.text, next.vars ? { name: t(next.vars.name) } : undefined)}</Txt> : null}
                {i.projectCode ? <Txt variant="micro">{t('Project {code}', { code: i.projectCode })}</Txt> : null}
              </Card>
            );
          })}
        </>
      )}
      {open && <SubmitIdea onClose={() => setOpen(false)} />}
    </Screen>
  );
}

function SubmitIdea({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [v, setV] = useState({ title: '', problem: '', category: '', wantsMentor: MENTOR[0] });
  const [err, setErr] = useState<Record<string, string>>({});
  const save = useApiMutation<typeof v>('post', '/me/ideas', { invalidate: ['/me/ideas'], success: 'Idea submitted — a teacher will review it', onSuccess: onClose });

  const submit = () => {
    const e: Record<string, string> = {};
    if (v.title.trim().length < 4) e.title = t('Give the idea a short title');
    if (v.problem.trim().length < 10) e.problem = t('Describe it in a sentence or two');
    if (!v.category) e.category = t('Area is required');
    setErr(e);
    if (Object.keys(e).length) return;
    save.mutate(v, {
      onError: (x) => { if (x instanceof ApiError) setErr(Object.fromEntries(Object.entries(x.fieldErrors).map(([k, m]) => [k, t(m)]))); },
    });
  };

  return (
    <Sheet visible onClose={onClose} title={t('Submit an idea')} sub={t('A teacher reads every idea, usually within a week.')}
      footer={<><Button label={t('Cancel')} onPress={onClose} /><Button label={t('Submit idea')} variant="primary" loading={save.isPending} onPress={submit} /></>}>
      <Field label={t('Idea title')} required maxLength={160} placeholder={t('What are you trying to make or solve?')} value={v.title} onChangeText={(x) => setV({ ...v, title: x })} error={err.title} />
      <Field label={t('Describe it')} required multiline maxLength={1000} placeholder={t('What problem does it solve, and how might it work?')} value={v.problem} onChangeText={(x) => setV({ ...v, problem: x })} error={err.problem} />
      <Select label={t('Area')} required value={v.category} options={AREAS.map((a) => ({ value: a, label: t(a) }))} onChange={(x) => setV({ ...v, category: x })} error={err.category} />
      <Select label={t('Would you like a mentor?')} value={v.wantsMentor} options={MENTOR.map((a) => ({ value: a, label: t(a) }))} onChange={(x) => setV({ ...v, wantsMentor: x })} />
      <Banner tone="neutral" icon="info">{t('It is submitted in your name. You can see the teacher’s decision on this page.')}</Banner>
      <Txt variant="micro" style={{ marginBottom: space.sm }}> </Txt>
    </Sheet>
  );
}
