import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AuthUser {
  _id: string;
  name: string;
  email: string;
  role: 'user' | 'admin' | 'superadmin';
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  setSession: (s: { user: AuthUser; accessToken: string; refreshToken: string }) => void;
  setAccessToken: (t: string) => void;
  setUser: (u: AuthUser) => void;
  clear: () => void;
}

/** Tokens persist in localStorage so editing sessions survive a browser refresh. */
export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      setSession: ({ user, accessToken, refreshToken }) => set({ user, accessToken, refreshToken }),
      setAccessToken: (accessToken) => set({ accessToken }),
      setUser: (user) => set({ user }),
      clear: () => set({ user: null, accessToken: null, refreshToken: null }),
    }),
    { name: 'ams-auth' }
  )
);
