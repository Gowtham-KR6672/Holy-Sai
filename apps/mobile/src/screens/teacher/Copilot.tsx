import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ApiError, api, errorMessage } from '@/api/client';
import { useApiQuery, useInvalidate, usePagedQuery, useRefresh } from '@/api/hooks';
import { useI18n } from '@/i18n/I18nProvider';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Toast';
import { Banner, Button, Card, Empty, ErrorState, Field, ListItem, Loading, Screen, Select, StatusBadge, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';
import { colors, radius, space } from '@/theme/theme';

type DraftType = 'lesson' | 'worksheet' | 'quiz' | 'comment' | 'message' | 'brief';
interface Ctx {
  actions: { id: DraftType; label: string; icon: string; desc: string }[];
  sections: { id: string; gradeLevel: number; label: string; campus: string }[];
  subjects: { id: string; code: string; name: string }[];
  grades: number[];
  topics: string[];
  lessonLengths: number[];
  provider: { name: string; kind: string; description: string };
}
interface DraftRow { id: string; type: DraftType; status: string; createdAt: string; title: string; classLabel: string | null; warnings: number }
const TYPE_LABEL: Record<DraftType, string> = { lesson: 'Lesson plan', worksheet: 'Worksheet', quiz: 'Quiz', comment: 'Report comments', message: 'Parent message', brief: 'Weekly brief' };

/**
 * AI Teacher Co-Pilot: GET /copilot/context, POST /copilot/drafts (generate), GET /copilot/drafts (history).
 * Every draft is reviewed and approved by the teacher before use (see the draft screen).
 */
export default function CopilotScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const invalidate = useInvalidate();
  const { refreshing, onRefresh } = useRefresh();
  const ctx = useApiQuery<Ctx>('/copilot/context', undefined, { staleTime: 5 * 60_000 });
  const drafts = usePagedQuery<DraftRow>('/copilot/drafts', { page: 1, pageSize: 10, sort: 'created', dir: 'desc' });
  const [action, setAction] = useState<DraftType | null>(null);
  const [form, setForm] = useState({ grade: '', subjectId: '', topic: '', customTopic: '', sectionId: '', lessonMinutes: '40' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = ctx.data;

  useEffect(() => {
    if (!c) return;
    setForm((f) => ({
      ...f,
      grade: f.grade || String(c.grades[0] ?? ''),
      subjectId: f.subjectId || c.subjects[0]?.id || '',
      topic: f.topic || c.topics[0] || '',
      lessonMinutes: String(c.lessonLengths?.[0] ?? 40),
    }));
  }, [c]);

  const sections = useMemo(() => (c?.sections ?? []).filter((s) => String(s.gradeLevel) === form.grade), [c, form.grade]);
  const needsSection = action === 'comment' || action === 'brief';
  const topic = form.topic === '__other' ? form.customTopic.trim() : form.topic;

  const generate = async () => {
    if (!action) return;
    if (!form.grade || !form.subjectId || topic.length < 2 || (needsSection && !form.sectionId)) {
      setError(t('Choose a grade, subject and topic{section}.', { section: needsSection ? t(' and a class section') : '' }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.postLong<{ id: string }>('/copilot/drafts', {
        type: action, grade: Number(form.grade), subjectId: form.subjectId, topic, sectionId: form.sectionId || undefined, lessonMinutes: Number(form.lessonMinutes),
      });
      toast(t('Draft generated — review before publishing'), 'success');
      void invalidate('/copilot/drafts');
      router.push(`/draft/${r.data.id}`);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 503 ? t('No AI provider is connected yet. Ask the administrator to connect one.') : t(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <Txt variant="small">{t('Drafts the routine work so teaching time goes to teaching. Every output is reviewed, edited and approved by a named teacher before it reaches a student or a parent.')}</Txt>
      <Card title={t('What do you need?')} icon="sparkle">
        {ctx.isLoading ? <Loading height={100} /> : ctx.error || !c ? <ErrorState error={ctx.error} onRetry={() => void ctx.refetch()} /> : (
          <View style={styles.grid}>
            {c.actions.filter((a) => a.id !== 'message').map((a) => {
              const on = action === a.id;
              return (
                <Pressable key={a.id} onPress={() => { setAction(a.id); setError(null); }} style={[styles.action, on && styles.actionOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
                  <Icon name={a.icon} size={18} color={colors.brand} />
                  <Txt variant="small" weight="bold" color={colors.text}>{t(a.label)}</Txt>
                  <Txt variant="micro" numberOfLines={3}>{t(a.desc)}</Txt>
                </Pressable>
              );
            })}
          </View>
        )}
      </Card>

      {action && c && (
        <Card title={t('Context')} sub={t('The Co-Pilot only uses this class, this curriculum and the approved question bank.')}>
          {error && <Banner tone="critical" icon="alert">{error}</Banner>}
          <Select label={t('Grade')} value={form.grade} options={c.grades.map((g) => ({ value: String(g), label: t('Grade {n}', { n: g }) }))} onChange={(v) => setForm({ ...form, grade: v, sectionId: '' })} />
          <Select label={t('Subject')} value={form.subjectId} options={c.subjects.map((s) => ({ value: s.id, label: s.name }))} onChange={(v) => setForm({ ...form, subjectId: v })} />
          <Select label={t('Topic')} value={form.topic} options={[...c.topics.map((x) => ({ value: x, label: x })), { value: '__other', label: t('Other topic…') }]} onChange={(v) => setForm({ ...form, topic: v })} />
          {form.topic === '__other' && <Field label={t('Your topic')} value={form.customTopic} onChangeText={(v) => setForm({ ...form, customTopic: v })} />}
          {(needsSection || sections.length > 0) && (
            <Select label={t('Class section')} required={needsSection} value={form.sectionId} options={sections.map((s) => ({ value: s.id, label: `${s.label} · ${s.campus}` }))} onChange={(v) => setForm({ ...form, sectionId: v })} />
          )}
          {action === 'lesson' && c.lessonLengths?.length ? (
            <Select label={t('Lesson length')} value={form.lessonMinutes} options={c.lessonLengths.map((m) => ({ value: String(m), label: t('{n} minutes', { n: m }) }))} onChange={(v) => setForm({ ...form, lessonMinutes: v })} />
          ) : null}
          <Button label={t('Generate draft')} icon="sparkle" variant="primary" loading={busy} onPress={() => void generate()} block />
          {busy && <Txt variant="micro" center>{t('Drafting can take up to a minute.')}</Txt>}
          <Txt variant="micro">{t('Generator: {name}', { name: c.provider.description })}</Txt>
        </Card>
      )}

      <Card title={t('Recent drafts')} icon="clock">
        {drafts.isLoading ? <Loading height={80} /> : drafts.error ? <ErrorState error={drafts.error} onRetry={() => void drafts.refetch()} /> : drafts.data?.rows.length ? drafts.data.rows.map((d) => (
          <ListItem key={d.id} icon="fileText" title={d.title} meta={`${t(TYPE_LABEL[d.type] ?? d.type)}${d.classLabel ? ` · ${d.classLabel}` : ''} · ${fmt.relative(d.createdAt)}`}
            right={<StatusBadge value={d.status} />} onPress={() => router.push(`/draft/${d.id}`)} />
        )) : <Empty icon="sparkle" title={t('No drafts yet')} sub={t('Pick a task above to create your first draft.')} />}
      </Card>
      <Txt variant="micro">{t('Parent messages and other drafts that need a student are created from the web portal.')}</Txt>
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  action: { width: '48%', flexGrow: 1, gap: 4, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  actionOn: { borderColor: colors.brand, backgroundColor: colors.brandTint },
});
