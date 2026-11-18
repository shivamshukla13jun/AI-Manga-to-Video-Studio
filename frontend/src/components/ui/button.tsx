import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors select-none disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg hover:bg-accent-2',
        secondary: 'bg-panel-3 text-fg border border-line-strong hover:bg-[#2b303a]',
        ghost: 'text-muted hover:text-fg hover:bg-panel-3',
        outline: 'border border-line-strong text-fg hover:bg-panel-3',
        danger: 'bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25',
        success: 'bg-ok/15 text-ok border border-ok/40 hover:bg-ok/25',
      },
      size: {
        xs: 'h-6 px-2 text-[11px]',
        sm: 'h-7 px-2.5 text-xs',
        md: 'h-8 px-3 text-[13px]',
        lg: 'h-10 px-4 text-sm',
        icon: 'h-7 w-7',
        'icon-sm': 'h-6 w-6',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  }
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
        {asChild ? (
          children
        ) : (
          <>
            {loading && <Loader2 className="animate-spin" />}
            {children}
          </>
        )}
      </Comp>
    );
  }
);
Button.displayName = 'Button';
