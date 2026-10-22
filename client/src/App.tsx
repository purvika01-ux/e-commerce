import { Bot, Cpu, Database, Gift, LayoutDashboard, ListChecks, ScrollText, Sparkles, Users } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { api, type Health } from './api';
import { Customers } from './pages/Customers';
import { Decisions } from './pages/Decisions';
import { Offers } from './pages/Offers';
import { Overview } from './pages/Overview';
import { Rules } from './pages/Rules';
import { Badge, useAsync } from './ui';

type Tab = 'overview' | 'customers' | 'offers' | 'rules' | 'decisions';
const TABS: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'customers', label: 'Customers', icon: Users },
  { id: 'offers', label: 'Offers', icon: Gift },
  { id: 'rules', label: 'Rules', icon: ListChecks },
  { id: 'decisions', label: 'Decision log', icon: ScrollText },
];

const SUBTITLES: Record<Tab, string> = {
  overview: 'How offers are being decided and delivered',
  customers: 'Pick a synthetic shopper and get a personalised, validated offer',
  offers: 'Offer definitions, eligibility and budgets',
  rules: 'Business limits that every offer must respect',
  decisions: 'Full audit trail of every decision',
};

export default function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [openDecision, setOpenDecision] = useState<string | null>(null);
  const health = useAsync(() => api.get<Health>('/health'));
  const h = health.data;

  return (
    <div className="min-h-full">
      <div className="bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900">Demo system · all customer data is synthetic · no real purchases or discounts</div>
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 md:flex-row md:px-6">
        <nav className="md:w-56 md:shrink-0" aria-label="Main">
          <div className="mb-5 flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-600 text-white">
              <Sparkles size={18} />
            </span>
            <div>
              <p className="font-semibold leading-tight">Offerly AI</p>
              <p className="text-xs text-ink-500">Personalised offer engine</p>
            </div>
          </div>
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {TABS.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => setTab(t.id)}
                  aria-current={tab === t.id ? 'page' : undefined}
                  className={`relative flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition ${tab === t.id ? 'font-medium text-brand-700' : 'text-ink-700 hover:bg-slate-100'}`}
                >
                  {tab === t.id && <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-lg bg-brand-50 ring-1 ring-brand-100" />}
                  <t.icon size={16} className="relative" />
                  <span className="relative">{t.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-6 hidden space-y-2 rounded-xl border border-slate-200 bg-white p-3 text-xs md:block">
            <p className="font-semibold text-ink-700">System status</p>
            {health.error ? (
              <p className="text-rose-700">Server unreachable</p>
            ) : !h ? (
              <p className="text-ink-500">Checking…</p>
            ) : (
              <>
                <p className="flex items-center gap-1.5">
                  <Database size={13} /> Database <Badge tone={h.db.status === 'connected' ? 'green' : 'red'}>{h.db.status}</Badge>
                </p>
                <p className="flex items-center gap-1.5">
                  <Cpu size={13} /> AI <Badge tone={h.ai.mode === 'live' ? 'violet' : 'amber'}>{h.ai.mode === 'live' ? h.ai.model : 'fallback only'}</Badge>
                </p>
                <p className="flex items-center gap-1.5">
                  <Bot size={13} /> Telegram{' '}
                  <Badge tone={h.telegram.enabled ? 'green' : 'slate'}>{h.telegram.enabled ? `@${h.telegram.botUsername}` : 'not configured'}</Badge>
                </p>
              </>
            )}
          </div>
        </nav>

        <main className="min-w-0 flex-1">
          <header className="mb-5">
            <h1 className="text-xl font-semibold">{TABS.find((t) => t.id === tab)!.label}</h1>
            <p className="text-sm text-ink-500">{SUBTITLES[tab]}</p>
          </header>
          {h && h.ai.mode !== 'live' && tab === 'customers' && (
            <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Claude is not configured, so decisions use the deterministic fallback (still fully validated). Add <code>ANTHROPIC_API_KEY</code> to <code>server/.env</code> and restart to enable AI personalisation.
            </p>
          )}
          <motion.div key={tab} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
            {tab === 'overview' && (
              <Overview
                onOpenDecision={(id) => {
                  setOpenDecision(id);
                  setTab('decisions');
                }}
              />
            )}
            {tab === 'customers' && <Customers telegramEnabled={Boolean(h?.telegram.enabled)} />}
            {tab === 'offers' && <Offers />}
            {tab === 'rules' && <Rules />}
            {tab === 'decisions' && <Decisions openId={openDecision} onOpen={setOpenDecision} />}
          </motion.div>
        </main>
      </div>
    </div>
  );
}
