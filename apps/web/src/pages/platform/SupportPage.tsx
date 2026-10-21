import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { Button, Lotus, Spinner } from '@/components/ui';

/**
 * /support#code=… — opened in a new tab by "Open school (support)" in the console. Exchanges the single-use code for
 * a one-hour session in the school as "We School Support", then shows the school's home page.
 */
export default function SupportPage() {
  const { startSupport } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('code');
    // Keep the code out of the history and the address bar.
    window.history.replaceState(null, '', '/support');
    if (!code) {
      setError('This support link is incomplete. Open the school again from the We School console.');
      return;
    }
    startSupport(code)
      .then((user) => navigate(user.role.homeRoute, { replace: true }))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open the school. Try again from the console.'));
  }, [startSupport, navigate]);

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', padding: 16 }}>
      <div className="col center g-3" style={{ maxWidth: 420, textAlign: 'center' }}>
        <Lotus size={48} />
        {error ? (
          <>
            <p className="t-bold">{error}</p>
            <Button variant="primary" onClick={() => window.location.assign('/platform')}>Back to the console</Button>
          </>
        ) : (
          <>
            <Spinner size={22} />
            <span className="t-sm t-muted">Opening the school for support…</span>
          </>
        )}
      </div>
    </div>
  );
}
