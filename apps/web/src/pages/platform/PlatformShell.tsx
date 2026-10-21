import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { ApiError, api } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { Button, Lotus, Modal, TextField, useToast } from '@/components/ui';
import '@/styles/platform.css';

const NAV = [
  { to: '/platform', label: 'Overview', end: true },
  { to: '/platform/schools', label: 'Schools' },
  { to: '/platform/payments', label: 'Payments' },
  { to: '/platform/plans', label: 'Plans' },
  { to: '/platform/gateways', label: 'Gateways' },
  { to: '/platform/settings', label: 'Settings' },
  { to: '/platform/admins', label: 'Admins' },
  { to: '/platform/audit', label: 'Audit trail' },
];

/** Layout of the We School console: brand, sections and the signed-in platform admin. */
export default function PlatformShell() {
  const { admin, logout } = useAuth();
  const navigate = useNavigate();
  const [pwOpen, setPwOpen] = useState(false);

  useEffect(() => {
    document.title = 'We School · Console';
  }, []);

  const signOut = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="wsc">
      <header className="wsc__bar">
        <NavLink to="/platform" className="wsc__brand" aria-label="We School console — overview">
          <Lotus size={28} />
          <span className="col">
            <span>We School</span>
            <small>Console</small>
          </span>
        </NavLink>
        <nav className="wsc__nav" aria-label="Console sections">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : undefined)}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="wsc__me">
          <span className="wsc__who t-sm">{admin?.fullName}</span>
          <Button variant="ghost" size="sm" icon="key" onClick={() => setPwOpen(true)}>Password</Button>
          <Button variant="ghost" size="sm" icon="logout" onClick={signOut}>Sign out</Button>
        </div>
      </header>
      <main className="wsc__main" id="main">
        <Outlet />
      </main>
      <ChangePassword open={pwOpen || !!admin?.mustChangePassword} forced={!!admin?.mustChangePassword} onClose={() => setPwOpen(false)} />
    </div>
  );
}

/** Platform admins change their own password here (forced after a temporary password). */
function ChangePassword({ open, forced, onClose }: { open: boolean; forced: boolean; onClose: () => void }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (f.newPassword !== f.confirm) {
      setErrors({ confirm: 'The two new passwords are different' });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await api.post('/platform/auth/change-password', { currentPassword: f.currentPassword, newPassword: f.newPassword });
      toast('Password changed — please sign in again', 'success');
      await logout();
      navigate('/login', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setErrors(Object.keys(err.fieldErrors).length ? err.fieldErrors : { currentPassword: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={forced ? () => undefined : onClose}
      title={forced ? 'Choose your password' : 'Change password'}
      sub={forced ? 'You signed in with a temporary password. Choose your own to continue.' : 'You will be signed out everywhere afterwards.'}
      busy={busy}
      foot={<>{!forced && <Button onClick={onClose} disabled={busy}>Cancel</Button>}<Button variant="primary" icon="check" loading={busy} onClick={save}>Change password</Button></>}
    >
      <div className="form-grid">
        <TextField className="span-2" label="Current password" type="password" required value={f.currentPassword} onChange={(v) => setF((x) => ({ ...x, currentPassword: v }))} error={errors.currentPassword} autoComplete="current-password" />
        <TextField label="New password" type="password" required value={f.newPassword} onChange={(v) => setF((x) => ({ ...x, newPassword: v }))} error={errors.newPassword} hint="At least 10 characters with upper case, lower case and a number" autoComplete="new-password" />
        <TextField label="Repeat new password" type="password" required value={f.confirm} onChange={(v) => setF((x) => ({ ...x, confirm: v }))} error={errors.confirm} autoComplete="new-password" />
      </div>
    </Modal>
  );
}
