import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as SliderPrimitive from '@radix-ui/react-slider';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------- Dialog
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { title: string; description?: string; wide?: boolean }
>(({ className, children, title, description, wide, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-strong bg-panel shadow-2xl',
        wide ? 'max-w-4xl' : 'max-w-lg',
        className
      )}
      {...props}
    >
      <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
        <div>
          <DialogPrimitive.Title className="text-sm font-semibold">{title}</DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="mt-0.5 text-xs text-muted">{description}</DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          )}
        </div>
        <DialogPrimitive.Close className="rounded p-1 text-muted hover:bg-panel-3 hover:text-fg" aria-label="Close">
          <X className="size-4" />
        </DialogPrimitive.Close>
      </div>
      <div className="max-h-[75vh] overflow-y-auto p-4">{children}</div>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = 'DialogContent';

export const DialogFooter = ({ children }: { children: React.ReactNode }) => (
  <div className="-mx-4 -mb-4 mt-4 flex justify-end gap-2 border-t border-line px-4 py-3">{children}</div>
);

// ------------------------------------------------------------------ Tabs
export const Tabs = TabsPrimitive.Root;
export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List ref={ref} className={cn('flex items-center gap-0.5 border-b border-line', className)} {...props} />
));
TabsList.displayName = 'TabsList';
export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-xs font-medium text-muted transition-colors hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg [&_svg]:size-3.5',
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';
export const TabsContent = TabsPrimitive.Content;

// ---------------------------------------------------------------- Slider
export const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root ref={ref} className={cn('relative flex h-4 w-full touch-none select-none items-center', className)} {...props}>
    <SliderPrimitive.Track className="relative h-1 grow overflow-hidden rounded-full bg-line-strong">
      <SliderPrimitive.Range className="absolute h-full bg-accent" />
    </SliderPrimitive.Track>
    {(props.value || props.defaultValue || [0]).map((_, i) => (
      <SliderPrimitive.Thumb key={i} className="block size-3 rounded-full border-2 border-accent bg-fg shadow focus:outline-none" />
    ))}
  </SliderPrimitive.Root>
));
Slider.displayName = 'Slider';

// ---------------------------------------------------------------- Switch
export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn('inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-line-strong bg-panel-3 transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent', className)}
    {...props}
  >
    <SwitchPrimitive.Thumb className="block size-3 translate-x-0.5 rounded-full bg-fg transition-transform data-[state=checked]:translate-x-3" />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';

// -------------------------------------------------------------- Checkbox
export const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn('flex size-3.5 shrink-0 items-center justify-center rounded-sm border border-line-strong bg-panel-2 data-[state=checked]:border-accent data-[state=checked]:bg-accent', className)}
    {...props}
  >
    <CheckboxPrimitive.Indicator>
      <Check className="size-3 text-white" strokeWidth={3} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = 'Checkbox';

// -------------------------------------------------------------- Progress
export const Progress = ({ value, className, tone = 'accent' }: { value: number; className?: string; tone?: 'accent' | 'ok' | 'danger' | 'warn' }) => (
  <ProgressPrimitive.Root className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-panel-3', className)} value={value}>
    <ProgressPrimitive.Indicator
      className={cn('h-full transition-[width] duration-300', { accent: 'bg-accent', ok: 'bg-ok', danger: 'bg-danger', warn: 'bg-warn' }[tone])}
      style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
    />
  </ProgressPrimitive.Root>
);

// --------------------------------------------------------------- Tooltip
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = ({ content, children, side = 'top' }: { content: React.ReactNode; children: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) => (
  <TooltipPrimitive.Root delayDuration={300}>
    <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content side={side} sideOffset={6} className="z-50 rounded border border-line-strong bg-panel-3 px-2 py-1 text-[11px] text-fg shadow-lg">
        {content}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>
);

// --------------------------------------------------------- Dropdown menu
export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;
export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownPrimitive.Portal>
    <DropdownPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn('z-50 min-w-40 rounded-md border border-line-strong bg-panel-2 p-1 shadow-xl', className)}
      {...props}
    />
  </DropdownPrimitive.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';
export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Item> & { danger?: boolean }
>(({ className, danger, ...props }, ref) => (
  <DropdownPrimitive.Item
    ref={ref}
    className={cn(
      'flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-xs outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-panel-3 data-[disabled]:opacity-40 [&_svg]:size-3.5',
      danger ? 'text-danger' : 'text-fg',
      className
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = 'DropdownMenuItem';
export const DropdownMenuSeparator = () => <DropdownPrimitive.Separator className="my-1 h-px bg-line" />;

// --------------------------------------------------------------- Popover
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn('z-50 w-72 rounded-md border border-line-strong bg-panel-2 p-3 shadow-xl', className)}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = 'PopoverContent';

// ----------------------------------------------------------------- Badge
const BADGE_TONES = {
  neutral: 'bg-panel-3 text-muted border-line-strong',
  accent: 'bg-accent/15 text-accent-2 border-accent/40',
  ok: 'bg-ok/12 text-ok border-ok/35',
  warn: 'bg-warn/12 text-warn border-warn/35',
  danger: 'bg-danger/12 text-danger border-danger/35',
  info: 'bg-info/12 text-info border-info/35',
} as const;
export type BadgeTone = keyof typeof BADGE_TONES;
export const Badge = ({ tone = 'neutral', className, children }: { tone?: BadgeTone; className?: string; children: React.ReactNode }) => (
  <span className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide [&_svg]:size-3', BADGE_TONES[tone], className)}>
    {children}
  </span>
);
