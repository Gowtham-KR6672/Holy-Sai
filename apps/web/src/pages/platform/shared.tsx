import { Badge, Banner, Button, Modal, useToast } from '@/components/ui';

export interface SchoolRow {
  id: string;
  code: string;
  name: string;
  status: string;
  currency: string;
  country: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: string;
  subscription: { status: string; endsOn: string | null; daysLeft: number | null; planCode: string | null } | null;
}

const STATUS: Record<string, { tone: string; label: string }> = {
  active: { tone: 'success', label: 'Active' },
  suspended: { tone: 'critical', label: 'Suspended' },
  provisioning: { tone: 'info', label: 'Setting up' },
  failed: { tone: 'warning', label: 'Set-up failed' },
};

export function SchoolStatus({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: 'neutral', label: status };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Shows a temporary password once (it is not stored anywhere readable). */
export function TemporaryPassword({ open, onClose, title, email, password, note }: {
  open: boolean; onClose: () => void; title: string; email: string; password: string; note?: string;
}) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`Sign-in: ${email}\nTemporary password: ${password}`);
      toast('Copied', 'success', 'copy');
    } catch {
      toast('Copy is not available here — select the password instead', 'warning');
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={title} foot={<><Button icon="copy" onClick={copy}>Copy</Button><Button variant="primary" onClick={onClose}>Done</Button></>}>
      <div className="col g-3">
        <Banner tone="warning" icon="key">This password is shown only now. Share it privately; it must be changed at the first sign-in.</Banner>
        <div className="col g-1">
          <span className="t-xs t-muted">Sign-in (email)</span>
          <span className="t-bold">{email}</span>
        </div>
        <div className="col g-1">
          <span className="t-xs t-muted">Temporary password</span>
          <span className="wsc__secret">{password}</span>
        </div>
        {note && <p className="t-sm t-muted">{note}</p>}
      </div>
    </Modal>
  );
}
