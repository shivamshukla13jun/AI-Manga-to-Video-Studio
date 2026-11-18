import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { securePost } from '@/lib/api';
import { useAuth, type AuthUser } from '@/stores/auth';

const loginSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});
const registerSchema = z
  .object({
    name: z.string().min(2, 'At least 2 characters'),
    email: z.string().email('Enter a valid email'),
    password: z.string().min(8, 'At least 8 characters'),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, { message: 'Passwords must match', path: ['confirmPassword'] });

type FormValues = { name?: string; email: string; password: string; confirmPassword?: string };

export const AuthPage = ({ mode }: { mode: 'login' | 'register' }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const setSession = useAuth((s) => s.setSession);
  const [busy, setBusy] = useState(false);
  const form = useForm<FormValues>({ resolver: zodResolver((mode === 'login' ? loginSchema : registerSchema) as any) });

  const onSubmit = form.handleSubmit(async (values) => {
    setBusy(true);
    try {
      if (mode === 'register') {
        await securePost('/api/auth/register', values);
        toast.success('Account created — signing you in');
      }
      // credentials travel through the RSA + AES-GCM payload encryption
      const data = await securePost<{ user: AuthUser; accessToken: string; refreshToken: string }>('/api/auth/login', {
        email: values.email,
        password: values.password,
      });
      setSession(data);
      navigate((location.state as any)?.from || '/', { replace: true });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  });

  const err = form.formState.errors;
  return (
    <div className="flex min-h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,#1d1838_0%,#0e0f12_60%)] p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-[#d946ef] text-lg font-black text-white">M</div>
          <h1 className="text-lg font-semibold">AI Manga-to-Video Studio</h1>
          <p className="text-xs text-muted">{mode === 'login' ? 'Sign in to your workspace' : 'Create your studio account'}</p>
        </div>
        <form onSubmit={onSubmit} className="panel flex flex-col gap-3 p-5">
          {mode === 'register' && (
            <Field label="Name" error={err.name?.message}>
              <Input autoComplete="name" {...form.register('name')} />
            </Field>
          )}
          <Field label="Email" error={err.email?.message}>
            <Input type="email" autoComplete="email" {...form.register('email')} />
          </Field>
          <Field label="Password" error={err.password?.message}>
            <Input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} {...form.register('password')} />
          </Field>
          {mode === 'register' && (
            <Field label="Confirm password" error={err.confirmPassword?.message}>
              <Input type="password" autoComplete="new-password" {...form.register('confirmPassword')} />
            </Field>
          )}
          <Button type="submit" variant="primary" loading={busy} className="mt-2">
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
          <p className="flex items-center justify-center gap-1 text-[10px] text-dim">
            <Lock className="size-3" /> Credentials are end-to-end encrypted (RSA-OAEP + AES-256-GCM)
          </p>
        </form>
        <p className="mt-4 text-center text-xs text-muted">
          {mode === 'login' ? (
            <>
              No account? <Link to="/register" className="text-accent-2 hover:underline">Create one</Link>
            </>
          ) : (
            <>
              Already registered? <Link to="/login" className="text-accent-2 hover:underline">Sign in</Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
};
