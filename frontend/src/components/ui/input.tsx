import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '@/lib/utils';

const field =
  'w-full rounded-md border border-line-strong bg-panel-2 px-2.5 text-[13px] text-fg placeholder:text-dim transition-colors focus:border-accent focus:outline-none disabled:opacity-50';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(field, 'h-8', className)} {...props} />
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(field, 'min-h-20 py-2 leading-relaxed', className)} {...props} />
);
Textarea.displayName = 'Textarea';

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn('text-[11px] font-medium uppercase tracking-wide text-muted', className)} {...props} />
));
Label.displayName = 'Label';

export const Field = ({ label, hint, error, children, className }: { label: string; hint?: string; error?: string; children: React.ReactNode; className?: string }) => (
  <div className={cn('flex flex-col gap-1.5', className)}>
    <Label>{label}</Label>
    {children}
    {error ? <p className="text-[11px] text-danger">{error}</p> : hint ? <p className="text-[11px] text-dim">{hint}</p> : null}
  </div>
);

export const NativeSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select ref={ref} className={cn(field, 'h-8 pr-6', className)} {...props}>
      {children}
    </select>
  )
);
NativeSelect.displayName = 'NativeSelect';
