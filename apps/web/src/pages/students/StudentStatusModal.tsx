import { useEffect, useState } from 'react';
import { useApiMutation } from '@/hooks/useApi';
import { Banner, Button, InlineError, Modal, SelectField, TextArea, TextField } from '@/components/ui';
import { todayKey } from '@/lib/format';

/**
 * Rebuild addition (school policy): a student who leaves keeps their record for the school's files, but their login —
 * and a parent's login when no other child is enrolled — is disabled. Re-enrolling restores those logins.
 * Calls PATCH /students/:id/status (students.archive).
 */
export function StudentStatusModal({ student, open, onClose }: {
  student: { id: string; fullName: string; status: string };
  open: boolean;
  onClose: () => void;
}) {
  const leaving = student.status === 'active';
  const [status, setStatus] = useState('discontinued');
  const [reason, setReason] = useState('');
  const [effectiveOn, setEffectiveOn] = useState(todayKey());
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (open) {
      setStatus('discontinued');
      setReason('');
      setEffectiveOn(todayKey());
      setTried(false);
    }
  }, [open]);

  const save = useApiMutation<{ status: string; reason?: string; effectiveOn?: string }>('patch', `/students/${student.id}/status`, {
    invalidate: ['/students', '/users', '/dashboard', '/parents'],
    success: leaving ? 'Marked as left — the student’s login is disabled' : 'Re-enrolled — logins restored',
    error: false,
    onSuccess: onClose,
  });
  const reasonNeeded = leaving && status !== 'graduated';
  const reasonError = tried && reasonNeeded && reason.trim().length < 3 ? 'Give the reason the student is leaving' : undefined;
  const submit = () => {
    setTried(true);
    if (reasonNeeded && reason.trim().length < 3) return;
    save.mutate(leaving
      ? { status, reason: reason.trim() || undefined, effectiveOn }
      : { status: 'active', reason: reason.trim() || undefined });
  };

  return (
    <Modal open={open} onClose={onClose} busy={save.isPending}
      title={leaving ? `${student.fullName} is leaving` : `Re-enrol ${student.fullName}`}
      foot={<>
        <Button onClick={onClose} disabled={save.isPending}>Cancel</Button>
        <Button variant={leaving ? 'danger' : 'teal'} loading={save.isPending} onClick={submit}>{leaving ? 'Mark as left' : 'Re-enrol student'}</Button>
      </>}>
      <div className="col g-3">
        {save.error && <InlineError error={save.error} />}
        {leaving ? (
          <>
            <SelectField label="Status" value={status} onChange={setStatus}
              options={[{ value: 'discontinued', label: 'Discontinued' }, { value: 'transferred', label: 'Transferred to another school' }, { value: 'graduated', label: 'Graduated' }]} />
            <TextField label="Effective date" type="date" value={effectiveOn} onChange={setEffectiveOn} />
            <TextArea label="Reason" required={reasonNeeded} value={reason} onChange={setReason} error={reasonError}
              placeholder={status === 'transferred' ? 'e.g. Family relocating to Bengaluru' : 'Reason for leaving'} />
            <Banner tone="warning" icon="lock">
              The student’s record stays in the school’s files. Their login is disabled, and so is the parent’s login when no other
              child is enrolled. GPS tracking stops. You can re-enrol the student later.
            </Banner>
          </>
        ) : (
          <>
            <TextArea label="Note" value={reason} onChange={setReason} placeholder="Optional — why the student is returning" />
            <Banner tone="neutral" icon="info">Logins that were disabled when the student left are restored, and tracking returns to its previous setting.</Banner>
          </>
        )}
      </div>
    </Modal>
  );
}
