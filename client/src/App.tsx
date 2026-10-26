import { Bot, Cpu, Database, Gift, LayoutDashboard, ListChecks, LogOut, Menu, ScrollText, Sparkles, Users, X } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, UNAUTHENTICATED_EVENT, type Health } from './api';
import { ToastProvider, useDialogFocus } from './overlays';
import { Customers } from './pages/Customers';
import { Decisions } from './pages/Decisions';
import { Login } from './pages/Login';
import { Offers } from './pages/Offers';
import { Overview } from './pages/Overview';
import { Rules } from './pages/Rules';
import { Badge, ErrorState, Spinner, useAsync } from './ui';

type Tab = 'overview' | 'customers' | 'offers' | 'rules' | 'decisions';
const TABS: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'customers', label: 'Customers', icon: Users },
  { id: 'offers', label: 'Offers', icon: Gift },
  { id: 'rules', label: 'Business rules', icon: ListChecks },
  { id: 'decisions', label: 'Decision log', icon: ScrollText },
];

type AuthState =
  | { state: 'checking' }
  | { state: 'signed_out'; expired?: boolean }
  | { state: 'ready'; user: string | null }
  | { state: 'error'; error: ApiError };

/** Checks the session first; shows the sign-in screen when the server requires a login. */
export default function App() {
  const [auth, setAuth] = useState<AuthState>({ state: 'checking' });

  const check = useCallback(async () => {
    try {
      const me = await api.get<{ authRequired: boolean; user: { username: string } | null }>('/auth/me');
      setAuth({ state: 'ready', user: me.user?.username ?? null });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuth({ state: 'signed_out' });
      else setAuth({ state: 'error', error: e instanceof ApiError ? e : new ApiError(0, 'ERROR', String(e)) });
    }
  }, []);

  useEffect(() => {
    void check();
    const onExpired = () => setAuth({ state: 'signed_out', expired: true });
    window.addEventListener(UNAUTHENTICATED_EVENT, onExpired);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onExpired);
  }, [check]);

  async function logout() {
    await api.post('/auth/logout', {}).catch(() => undefined);
    setAuth({ state: 'signed_out' });
  }

  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        {auth.state === 'checking' && (
          <div className="grid min-h-full place-items-center">
            <Spinner label="Starting Offerly AI…" />
          </div>
        )}
        {auth.state === 'error' && (
          <div className="mx-auto max-w-md p-8">
            <ErrorState error={auth.error} onRetry={check} />
          </div>
        )}
        {auth.state === 'signed_out' && <Login onSignedIn={check} notice={auth.expired ? 'Your session has ended. Please sign in again.' : undefined} />}
        {auth.state === 'ready' && <Shell user={auth.user} onLogout={logout} />}
      </ToastProvider>
    </MotionConfig>
  );
}

/** Tab state lives in the URL hash so the back button and bookmarks work (e.g. #/offers). */
function useHashTab(): [Tab, (t: Tab) => void] {
  const read = (): Tab => {
    const t = window.location.hash.replace(/^#\/?/, '').split('/')[0] as Tab;
    return TABS.some((x) => x.id === t) ? t : 'overview';
  };
  const [tab, setTab] = useState<Tab>(read);
  useEffect(() => {
    const onHash = () => setTab(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = (t: Tab) => {
    if (t !== tab) window.location.hash = `/${t}`;
    window.scrollTo({ top: 0 });
  };
  return [tab, go];
}

function Shell({ user, onLogout }: { user: string | null; onLogout: () => void }) {
  const [tab, setTab] = useHashTab();
  const [openDecision, setOpenDecision] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const health = useAsync(() => api.get<Health>('/health'));

  const menuRef = useDialogFocus(menuOpen, () => setMenuOpen(false));

  useEffect(() => setMenuOpen(false), [tab]);

  const nav = (
    <SideNav
      tab={tab}
      onTab={setTab}
      health={health.data}
      healthError={Boolean(health.error)}
      user={user}
      onLogout={onLogout}
    />
  );

  return (
    <div className="min-h-full">
      {/* Mobile / tablet top bar */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-canvas/85 px-4 py-3 backdrop-blur lg:hidden">
        <Brand />
        <button onClick={() => setMenuOpen(true)} className="rounded-lg p-2 text-ink-2 hover:bg-surface-3" aria-label="Open navigation" aria-expanded={menuOpen}>
          <Menu size={20} aria-hidden />
        </button>
      </div>
      <AnimatePresence>
        {menuOpen && (
          <motion.div className="fixed inset-0 z-40 bg-[#050812b3] lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMenuOpen(false)}>
            <motion.div
              ref={menuRef}
              className="flex h-full w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-line bg-canvas p-4"
              initial={{ x: -32 }}
              animate={{ x: 0 }}
              exit={{ x: -32, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
            >
              <div className="mb-4 flex justify-end">
                <button onClick={() => setMenuOpen(false)} className="rounded-lg p-2 text-ink-3 hover:bg-surface-3" aria-label="Close navigation">
                  <X size={18} aria-hidden />
                </button>
              </div>
              <div className="min-h-0 flex-1">{nav}</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mx-auto flex max-w-[1400px] gap-8 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <aside className="sticky top-8 hidden h-[calc(100vh-4rem)] w-60 shrink-0 lg:block">{nav}</aside>
        <main className="min-w-0 flex-1">
          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
              {tab === 'overview' && (
                <Overview
                  onOpenDecision={(id) => {
                    setOpenDecision(id);
                    setTab('decisions');
                  }}
                />
              )}
              {tab === 'customers' && <Customers telegramEnabled={Boolean(health.data?.telegram.enabled)} aiLive={health.data?.ai.mode === 'live'} />}
              {tab === 'offers' && <Offers />}
              {tab === 'rules' && <Rules />}
              {tab === 'decisions' && <Decisions openId={openDecision} onOpen={setOpenDecision} />}
            </motion.div>
          </AnimatePresence>
          <footer className="mt-12 border-t border-line pt-5 pb-2 text-[0.75rem] text-ink-3">
            Demo system · all customer data is synthetic · no real purchases or discounts. Engagement figures come from classmates using synthetic profiles and are descriptive, not causal.
          </footer>
        </main>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-accent to-ai text-accent-ink shadow-[0_8px_24px_-10px_#2dd4bf]">
        <Sparkles size={18} aria-hidden />
      </span>
      <div>
        <p className="text-[0.95rem] leading-tight font-semibold text-ink">Offerly AI</p>
        <p className="text-[0.72rem] text-ink-3">Personalised offer engine</p>
      </div>
    </div>
  );
}

function SideNav({ tab, onTab, health, healthError, user, onLogout }: { tab: Tab; onTab: (t: Tab) => void; health: Health | null; healthError: boolean; user: string | null; onLogout: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="hidden lg:block">
        <Brand />
      </div>
      <nav aria-label="Main" className="mt-6 lg:mt-8">
        <ul className="space-y-1">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <li key={t.id}>
                <button
                  onClick={() => onTab(t.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${active ? 'font-medium text-ink' : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2'}`}
                >
                  {active && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-xl bg-surface-2 ring-1 ring-line-strong" transition={{ type: 'spring', stiffness: 420, damping: 36 }} />}
                  {active && <span className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-accent" aria-hidden />}
                  <t.icon size={17} className={`relative ${active ? 'text-accent' : ''}`} aria-hidden />
                  <span className="relative">{t.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="mt-auto space-y-3 pt-8">
        <div className="rounded-2xl border border-line bg-surface p-3.5 text-[0.78rem]">
          <p className="mb-2.5 font-medium text-ink-2">System status</p>
          {healthError ? (
            <p className="text-bad-ink">Server unreachable</p>
          ) : !health ? (
            <p className="text-ink-3">Checking…</p>
          ) : (
            <ul className="space-y-2">
              <li className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-ink-3">
                  <Database size={13} aria-hidden /> Database
                </span>
                <Badge tone={health.db.status === 'connected' ? 'good' : 'bad'}>{health.db.status}</Badge>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-ink-3">
                  <Cpu size={13} aria-hidden /> AI
                </span>
                <Badge tone={health.ai.mode === 'live' ? 'violet' : 'warn'}>{health.ai.mode === 'live' ? (health.ai.model ?? 'live') : 'fallback only'}</Badge>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-ink-3">
                  <Bot size={13} aria-hidden /> Telegram
                </span>
                {!health.telegram.enabled ? (
                  <Badge tone="neutral">off</Badge>
                ) : health.telegram.status === 'polling' ? (
                  <Badge tone="good">@{health.telegram.botUsername}</Badge>
                ) : health.telegram.status === 'failed' ? (
                  <Badge tone="bad">down · retrying</Badge>
                ) : (
                  <Badge tone="warn">{health.telegram.status}</Badge>
                )}
              </li>
              {health.telegram.lastError && health.telegram.status === 'failed' && <li className="text-bad-ink">{health.telegram.lastError.message}</li>}
            </ul>
          )}
        </div>
        {user ? (
          <div className="flex items-center justify-between gap-2 rounded-2xl border border-line bg-surface px-3.5 py-2.5 text-[0.78rem]">
            <span className="min-w-0 truncate text-ink-3">
              Signed in as <b className="font-medium text-ink-2">{user}</b>
            </span>
            <button onClick={onLogout} className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 whitespace-nowrap text-ink-2 hover:bg-surface-3 hover:text-ink">
              <LogOut size={13} aria-hidden /> Sign out
            </button>
          </div>
        ) : (
          <p className="px-1 text-[0.75rem] text-warn-ink">Admin login is off (local only).</p>
        )}
      </div>
    </div>
  );
}
