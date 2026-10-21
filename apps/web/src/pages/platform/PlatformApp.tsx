import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PageSkeleton } from '@/components/ui';
import PlatformShell from './PlatformShell';

const OverviewPage = lazy(() => import('./OverviewPage'));
const SchoolsPage = lazy(() => import('./SchoolsPage'));
const SchoolPage = lazy(() => import('./SchoolPage'));
const AdminsPage = lazy(() => import('./AdminsPage'));
const AuditPage = lazy(() => import('./AuditPage'));
const PlansPage = lazy(() => import('./PlansPage'));
const PaymentsPage = lazy(() => import('./PaymentsPage'));
const GatewaysPage = lazy(() => import('./GatewaysPage'));
const SettingsPage = lazy(() => import('./SettingsPage'));

/** The We School console, mounted at /platform/*. */
export default function PlatformApp() {
  return (
    <Routes>
      <Route element={<PlatformShell />}>
        <Route index element={<Lazy><OverviewPage /></Lazy>} />
        <Route path="schools" element={<Lazy><SchoolsPage /></Lazy>} />
        <Route path="schools/:id" element={<Lazy><SchoolPage /></Lazy>} />
        <Route path="admins" element={<Lazy><AdminsPage /></Lazy>} />
        <Route path="audit" element={<Lazy><AuditPage /></Lazy>} />
        <Route path="plans" element={<Lazy><PlansPage /></Lazy>} />
        <Route path="payments" element={<Lazy><PaymentsPage /></Lazy>} />
        <Route path="gateways" element={<Lazy><GatewaysPage /></Lazy>} />
        <Route path="settings" element={<Lazy><SettingsPage /></Lazy>} />
        <Route path="*" element={<Navigate to="/platform" replace />} />
      </Route>
    </Routes>
  );
}

function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>;
}
