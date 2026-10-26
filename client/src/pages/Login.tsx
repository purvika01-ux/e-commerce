import { AlertTriangle, LogIn, Sparkles } from 'lucide-react';
import { motion } from 'motion/react';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { Button } from '../ui';

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
    <div className="flex min-h-full flex-col">
      <div className="bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900">Demo system · all customer data is synthetic · no real purchases or discounts</div>
      <main className="grid flex-1 place-items-center px-4 py-10">
        <motion.form
          onSubmit={submit}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
          aria-labelledby="login-title"
        >
          <div className="mb-6 flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-600 text-white">
              <Sparkles size={18} />
            </span>
            <div>
              <h1 id="login-title" className="font-semibold leading-tight">
                Offerly AI
              </h1>
              <p className="text-xs text-ink-500">Sign in to manage offers and rules</p>
            </div>
          </div>
          {notice && !error && (
            <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
              {notice}
            </p>
          )}
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-ink-700">Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
              maxLength={64}
              className="w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="mb-4 block text-sm">
            <span className="mb-1 block text-ink-700">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              maxLength={128}
              className="w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          {error && (
            <p className="mb-3 flex items-center gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">
              <AlertTriangle size={14} /> {error}
            </p>
          )}
          <Button type="submit" busy={busy} disabled={!username || !password} icon={<LogIn size={16} />}>
            Sign in
          </Button>
        </motion.form>
      </main>
    </div>
  );
}
