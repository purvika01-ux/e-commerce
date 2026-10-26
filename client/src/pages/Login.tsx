import { AlertTriangle, LockKeyhole, LogIn, ShieldCheck, Sparkles, Workflow } from 'lucide-react';
import { motion } from 'motion/react';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { Button, Field, inputClass } from '../ui';

const POINTS = [
  { icon: Sparkles, title: 'AI that stays inside the lines', text: 'Claude chooses and words offers only from what your business rules allow.' },
  { icon: ShieldCheck, title: 'Every decision is independently checked', text: 'A separate validator re-checks each offer before anything reaches Telegram.' },
  { icon: Workflow, title: 'A full audit trail', text: 'See the candidates, the AI attempts, every validation run and the delivery result.' },
];

export function Login({ onSignedIn, notice }: { onSignedIn: () => void; notice?: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { username: username.trim(), password });
      onSignedIn();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      setError(
        apiErr?.status === 429
          ? 'Too many sign-in attempts. Please wait and try again later.'
          : apiErr?.status === 403
            ? 'Sign-in was blocked by a security check. Reload the page and try again.'
            : apiErr?.status === 401
              ? 'Incorrect username or password.'
              : (apiErr?.message ?? 'Sign-in failed. Please try again.'),
      );
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full lg:grid-cols-[1.1fr_1fr]">
      {/* Brand panel */}
      <section className="relative hidden overflow-hidden border-r border-line lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="pointer-events-none absolute -top-40 -left-32 h-[28rem] w-[28rem] rounded-full bg-accent/10 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -right-24 bottom-0 h-[24rem] w-[24rem] rounded-full bg-ai/10 blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-2.5">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-accent to-ai text-accent-ink">
            <Sparkles size={20} aria-hidden />
          </span>
          <span className="text-lg font-semibold text-ink">Offerly AI</span>
        </div>
        <div className="relative max-w-lg">
          <h1 className="text-4xl leading-tight font-semibold tracking-tight text-ink">
            The right offer for each customer — <span className="bg-gradient-to-r from-accent to-ai bg-clip-text text-transparent">safely.</span>
          </h1>
          <ul className="mt-10 space-y-6">
            {POINTS.map((p, i) => (
              <motion.li key={p.title} className="flex gap-4" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.08 }}>
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-surface text-accent">
                  <p.icon size={18} aria-hidden />
                </span>
                <div>
                  <p className="font-medium text-ink">{p.title}</p>
                  <p className="mt-0.5 text-sm text-ink-3">{p.text}</p>
                </div>
              </motion.li>
            ))}
          </ul>
        </div>
        <p className="relative text-[0.78rem] text-ink-3">Hackathon demo · all customer data is synthetic · no real purchases or discounts.</p>
      </section>

      {/* Form */}
      <main className="flex items-center justify-center px-5 py-12">
        <motion.form
          onSubmit={submit}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="w-full max-w-sm"
          aria-labelledby="login-title"
          noValidate
        >
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-accent to-ai text-accent-ink">
              <Sparkles size={18} aria-hidden />
            </span>
            <span className="font-semibold text-ink">Offerly AI</span>
          </div>
          <span className="mb-4 grid h-11 w-11 place-items-center rounded-xl border border-line bg-surface text-accent">
            <LockKeyhole size={20} aria-hidden />
          </span>
          <h2 id="login-title" className="text-2xl font-semibold tracking-tight text-ink">
            Sign in
          </h2>
          <p className="mt-1 text-sm text-ink-3">Manage offers, business rules and decisions.</p>

          {notice && !error && (
            <p className="mt-6 rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-2.5 text-sm text-warn-ink" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="mt-6 flex items-center gap-2 rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-sm text-bad-ink" role="alert">
              <AlertTriangle size={15} aria-hidden /> {error}
            </p>
          )}

          <div className="mt-6 space-y-4">
            <Field label="Username" htmlFor="login-user">
              <input id="login-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required maxLength={64} className={inputClass} />
            </Field>
            <Field label="Password" htmlFor="login-pass">
              <input id="login-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required maxLength={128} className={inputClass} />
            </Field>
          </div>
          <Button type="submit" busy={busy} disabled={!username || !password} icon={<LogIn size={16} aria-hidden />} className="mt-6 w-full py-2.5!">
            Sign in
          </Button>
          <p className="mt-6 text-center text-[0.75rem] text-ink-3">Sessions end after 60 minutes of inactivity.</p>
        </motion.form>
      </main>
    </div>
  );
}
