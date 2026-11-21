import React, { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import { authApi } from './api/client';

const Layout = lazy(() => import('./components/Layout'));
const SettingsLayout = lazy(() => import('./components/SettingsLayout'));
const DraftedPolls = lazy(() => import('./pages/DraftedPolls'));
const ActivePolls = lazy(() => import('./pages/ActivePolls'));
const VotingHistory = lazy(() => import('./pages/VotingHistory'));
const SettingsRegions = lazy(() => import('./pages/SettingsRegions'));
const SettingsVerificationProviders = lazy(() => import('./pages/SettingsVerificationProviders'));
const SettingsSecurity = lazy(() => import('./pages/SettingsSecurity'));
const SettingsNotifications = lazy(() => import('./pages/SettingsNotifications'));
const SettingsGeoBlocking = lazy(() => import('./pages/SettingsGeoBlocking'));
const Dashboard = lazy(() => import('./pages/Workspace'));
const SecurityLogs = lazy(() => import('./pages/SecurityLogs'));
const PollDetails = lazy(() => import('./pages/PollDetails'));
const Insights = lazy(() => import('./pages/Insights'));
const Profiles = lazy(() => import('./pages/Profiles'));
const Members = lazy(() => import('./pages/Members'));
const Positions = lazy(() => import('./pages/Positions'));
const Platform = lazy(() => import('./pages/Platform'));
const MessagesList = lazy(() => import('./pages/MessagesList'));
const Channels = lazy(() => import('./pages/Channels'));
const MessageEditor = lazy(() => import('./pages/MessageEditor'));
const Tickets = lazy(() => import('./pages/Tickets'));
const TicketDetail = lazy(() => import('./pages/TicketDetail'));
const ShieldDashboard = lazy(() => import('./pages/ShieldDashboard'));
const AdminUsers = lazy(() => import('./pages/AdminUsers'));
const AccountSecurity = lazy(() => import('./pages/AccountSecurity'));
const Invitations = lazy(() => import('./pages/Invitations'));
const VerifyEmail = lazy(() => import('./pages/VerifyEmail'));
const ConfirmEmailChange = lazy(() => import('./pages/ConfirmEmailChange'));
const ActivateAccount = lazy(() => import('./pages/ActivateAccount'));
const RecoverAccount = lazy(() => import('./pages/RecoverAccount'));
const Reviews = lazy(() => import('./pages/Reviews'));
const Units = lazy(() => import('./pages/Units'));
const Tasks = lazy(() => import('./pages/Tasks'));
const Events = lazy(() => import('./pages/Events'));
const Collective = lazy(() => import('./pages/Collective'));
const InboxPage = lazy(() => import('./pages/Inbox'));
const Contribution = lazy(() => import('./pages/Contribution'));
const Decisions = lazy(() => import('./pages/Decisions'));

type AuthStatus = 'checking' | 'authenticated' | 'guest';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="min-h-screen bg-[var(--background)] text-[var(--text)] flex items-center justify-center p-6"
        >
          <div className="max-w-md w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 space-y-4 text-center">
            <h1 className="text-lg font-semibold">
              გვერდის ჩატვირთვის შეცდომა / Unexpected interface error
            </h1>
            <p className="text-sm text-[var(--muted)]">
              სცადეთ გვერდის განახლება. / Please reload the console.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
            >
              განახლება / Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function RequireAdmin({ children, status }: { children: React.ReactNode; status: AuthStatus }) {
  if (status === 'checking') {
    return (
      <div
        role="status"
        className="min-h-screen bg-[var(--background)] text-[var(--text)] flex items-center justify-center"
      >
        მიმდინარეობს უსაფრთხო სესიის შემოწმება… / Checking secure session…
      </div>
    );
  }
  if (status !== 'authenticated') {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking');

  useEffect(() => {
    authApi.me()
      .then(response => {
        sessionStorage.setItem('admin_csrf', response.csrfToken);
        sessionStorage.setItem('admin_user', JSON.stringify(response.user));
        setAuthStatus('authenticated');
      })
      .catch(() => setAuthStatus('guest'));
  }, []);

  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Suspense
          fallback={
            <div
              role="status"
              className="min-h-screen bg-[var(--background)] text-[var(--text)] flex items-center justify-center"
            >
              იტვირთება უსაფრთხო კონსოლი… / Loading secure console…
            </div>
          }
        >
          <Routes>
            {/* Login route */}
            <Route path="/login" element={<Login onLogin={() => setAuthStatus('authenticated')} />} />
            <Route path="/activate" element={<ActivateAccount />} />
            <Route path="/recover" element={<RecoverAccount />} />
            <Route path="/verify-email" element={<VerifyEmail />} />
            <Route path="/verify-email-change" element={<ConfirmEmailChange />} />

            {/* Protected admin routes */}
            <Route
              path="/"
              element={
                <RequireAdmin status={authStatus}>
                  <Layout />
                </RequireAdmin>
              }
            >
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="reviews" element={<Reviews />} />
              <Route path="units" element={<Units />} />
              <Route path="members" element={<Members />} />
              <Route path="positions" element={<Positions />} />
              <Route path="platform/:section?" element={<Platform />} />
              <Route path="tasks" element={<Tasks />} />
              <Route path="events" element={<Events />} />
              <Route path="approvals" element={<Collective />} />
              <Route path="inbox" element={<InboxPage />} />
              <Route path="contribution" element={<Contribution />} />
              <Route path="decisions" element={<Decisions />} />
              <Route path="create-poll" element={<Navigate to="/decisions?create=1" replace />} />
              <Route path="drafts" element={<DraftedPolls />} />
              <Route path="active" element={<ActivePolls />} />
              <Route path="polls/:id" element={<PollDetails />} />
              <Route path="polls/:id/edit" element={<Navigate to="/decisions?view=draft" replace />} />
              <Route path="history" element={<VotingHistory />} />
              <Route path="insights" element={<Insights />} />
              <Route path="profiles" element={<Profiles />} />
              <Route path="messages" element={<MessagesList />} />
              <Route path="channels" element={<Channels />} />
              <Route path="messages/create" element={<MessageEditor />} />
              <Route path="messages/:id/edit" element={<MessageEditor />} />
              <Route path="logs" element={<SecurityLogs />} />
              <Route path="shield" element={<ShieldDashboard />} />
              <Route path="admin-users" element={<AdminUsers />} />
              <Route path="account" element={<AccountSecurity />} />
              <Route path="invitations" element={<Invitations />} />
              <Route path="tickets" element={<Tickets />} />
              <Route path="tickets/:id" element={<TicketDetail />} />

              <Route path="settings" element={<SettingsLayout />}>
                <Route index element={<Navigate to="/settings/security" replace />} />
                <Route path="regions" element={<SettingsRegions />} />
                <Route path="verification-providers" element={<SettingsVerificationProviders />} />
                <Route path="security" element={<SettingsSecurity />} />
                <Route path="notifications" element={<SettingsNotifications />} />
                <Route path="geo-blocking" element={<SettingsGeoBlocking />} />
              </Route>
            </Route>

            {/* fallback */}
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
