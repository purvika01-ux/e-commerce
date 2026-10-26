import { Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
const STORAGE_KEY = 'offerly-theme';
const CHANGE_EVENT = 'offerly-theme-change';

/** The theme public/theme-init.js applied before render (dark if it could not run). */
const current = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

function apply(theme: Theme) {
  // Switch every colour at once: without this, elements with colour transitions fade at their own pace.
  const freeze = document.createElement('style');
  freeze.textContent = '*,*::before,*::after{transition:none!important}';
  document.head.appendChild(freeze);
  document.documentElement.dataset.theme = theme;
  void getComputedStyle(document.body).color; // apply the new colours while transitions are off
  requestAnimationFrame(() => requestAnimationFrame(() => freeze.remove()));
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage blocked (private window): the choice lasts until the page reloads.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Shared theme state: every toggle on the page stays in sync. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(current);
  useEffect(() => {
    const sync = () => setTheme(current());
    window.addEventListener(CHANGE_EVENT, sync);
    return () => window.removeEventListener(CHANGE_EVENT, sync);
  }, []);
  const toggle = useCallback(() => apply(current() === 'dark' ? 'light' : 'dark'), []);
  return [theme, toggle];
}

/** Icon button that switches between light and dark. The icon shows the theme you will switch to. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, toggle] = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-2 ring-1 ring-inset ring-line transition-colors hover:bg-surface-3 hover:text-ink ${className}`}
    >
      {theme === 'dark' ? <Sun size={17} aria-hidden /> : <Moon size={17} aria-hidden />}
    </button>
  );
}
