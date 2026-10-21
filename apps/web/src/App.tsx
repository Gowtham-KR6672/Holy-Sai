import { lazy, Suspense, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { AppShell, Protected } from '@/layouts/AppShell';
import { SchoolContextProvider } from '@/layouts/SchoolContext';
import { Banner, LotusArt, PageSkeleton } from '@/components/ui';
import { APP_ROUTES } from '@/pages/registry';
import LoginPage from '@/pages/core/LoginPage';
import NotFoundPage from '@/pages/core/NotFoundPage';
import SupportPage from '@/pages/platform/SupportPage';

const PlatformApp = lazy(() => import('@/pages/platform/PlatformApp'));


function Splash() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)' }} aria-busy="true">
      <div className="col center g-3">
        <LotusArt className="splash__lotus" />
        <span className="t-sm t-muted">Opening We School…</span>
      </div>
    </div>
  );
}

/** School pages: a school user or a support session (We School admins are sent to their console). */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status, mode } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Splash />;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (mode === 'platform') return <Navigate to="/platform" replace />;
  return <>{children}</>;
}

/** The We School console: platform admins only. */
function RequirePlatform({ children }: { children: React.ReactNode }) {
  const { status, mode } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Splash />;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (mode !== 'platform') return <HomeRedirect />;
  return <>{children}</>;
}

/** Why the last session ended, when the school (not the user) ended it: suspended, or the subscription ended. */
function SessionEndedNotice() {
  const [reason] = useState(() => {
    try {
      const r = sessionStorage.getItem('we.ended');
      sessionStorage.removeItem('we.ended');
      return r;
    } catch {
      return null;
    }
  });
  if (!reason) return null;
  return (
    <div role="alert" style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 50, maxWidth: 'min(560px, calc(100vw - 32px))' }}>
      <Banner tone="critical" icon="lock">{reason}</Banner>
    </div>
  );
}

function HomeRedirect() {
  const { user, mode } = useAuth();
  if (mode === 'platform') return <Navigate to="/platform" replace />;
  return <Navigate to={user?.role.homeRoute ?? '/login'} replace />;
}

export default function App() {
  const { status } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={status === 'loading' ? <Splash /> : status === 'authenticated' ? <HomeRedirect /> : <><SessionEndedNotice /><LoginPage /></>} />
      <Route path="/support" element={<SupportPage />} />
      <Route path="/platform/*" element={<RequirePlatform><Suspense fallback={<Splash />}><PlatformApp /></Suspense></RequirePlatform>} />
      <Route
        element={
          <RequireAuth>
            <SchoolContextProvider>
              <AppShell />
            </SchoolContextProvider>
          </RequireAuth>
        }
      >
        <Route index element={<HomeRedirect />} />
        {APP_ROUTES.map((r) => (
          <Route
            key={r.path}
            path={r.path}
            element={
              <Protected perm={r.perm}>
                <Suspense fallback={<div className="page"><PageSkeleton /></div>}>{r.element}</Suspense>
              </Protected>
            }
          />
        ))}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
