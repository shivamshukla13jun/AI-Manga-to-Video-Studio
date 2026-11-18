import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  AudioLines,
  BookOpen,
  Clapperboard,
  FileText,
  LayoutDashboard,
  LogOut,
  MonitorPlay,
  Settings,
  Sparkles,
} from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { api } from '@/lib/api';
import { useJobs } from '@/lib/queries';
import { useRealtimeBridge } from '@/lib/socket';
import { Tooltip } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/library', label: 'Manga Library', icon: BookOpen },
  { to: '/pdf', label: 'CBZ to PDF', icon: FileText },
  { to: '/story', label: 'AI Story Studio', icon: Sparkles },
  { to: '/video', label: 'Video Studio', icon: Clapperboard },
  { to: '/voice', label: 'Voice Studio', icon: AudioLines },
  { to: '/renders', label: 'Render Manager', icon: MonitorPlay },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export const AppShell = () => {
  useRealtimeBridge();
  const { user, clear } = useAuth();
  const navigate = useNavigate();
  const { data: jobs } = useJobs();
  const running = jobs?.filter((j) => ['queued', 'active', 'retrying'].includes(j.status)).length || 0;

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    clear();
    navigate('/login');
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex h-12 items-center gap-2 border-b border-line px-4">
          <div className="flex size-6 items-center justify-center rounded bg-gradient-to-br from-accent to-[#d946ef] text-[11px] font-black text-white">M</div>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold">Manga Studio</div>
            <div className="text-[10px] text-dim">AI manga-to-video</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 p-2">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
                  isActive ? 'bg-accent/15 text-fg' : 'text-muted hover:bg-panel-3 hover:text-fg'
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon className={cn('size-4', isActive && 'text-accent-2')} />
                  <span className="flex-1">{label}</span>
                  {to === '/renders' && running > 0 && (
                    <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white">{running}</span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2 border-t border-line p-3">
          <div className="flex size-7 items-center justify-center rounded-full bg-panel-3 text-xs font-semibold uppercase">{user?.name?.[0] || '?'}</div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-xs font-medium">{user?.name}</div>
            <div className="truncate text-[10px] text-dim">{user?.email}</div>
          </div>
          <Tooltip content="Sign out">
            <button onClick={logout} className="rounded p-1.5 text-muted hover:bg-panel-3 hover:text-fg" aria-label="Sign out">
              <LogOut className="size-3.5" />
            </button>
          </Tooltip>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
};
