import { useStore } from '../store';
import { signOut } from '../api';

interface HeaderProps {
  title?: string;
  onBack?: () => void;
}

export default function Header({ title, onBack }: HeaderProps) {
  const { me, wsConnected } = useStore();

  return (
    <header className="flex items-center gap-3 px-4 h-12 bg-surface border-b border-slate-700 flex-shrink-0 safe-top">
      {onBack && (
        <button
          onClick={onBack}
          className="flex items-center justify-center min-h-touch min-w-touch -ml-2 text-slate-400 active:text-slate-100"
          aria-label="Go back"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}

      <span className="flex-1 font-semibold text-slate-100 truncate">
        {title ?? 'Session Manager'}
      </span>

      <div className="flex items-center gap-2">
        {/* WS connection indicator */}
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${wsConnected ? 'bg-green-500' : 'bg-slate-500'}`}
          title={wsConnected ? 'Relay connected' : 'Relay disconnected'}
          aria-hidden="true"
        />

        {me && (
          <button
            onClick={() => signOut()}
            className="text-xs text-slate-400 active:text-slate-100 min-h-touch flex items-center px-1"
            aria-label={`Sign out (${me.email})`}
          >
            {me.email.split('@')[0]}
          </button>
        )}
      </div>
    </header>
  );
}
