import type {
  ReactNode,
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  ButtonHTMLAttributes,
} from 'react';

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('panel', className)}>{children}</section>;
}

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
      {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
    </header>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="panel px-6 py-12 text-center">
      <p className="text-base font-medium text-slate-900">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">{body}</p>
    </div>
  );
}

export function DataRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-5 py-3.5 last:border-b-0">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className="text-sm font-medium text-slate-900">{value}</dd>
    </div>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-sm bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-800 ring-1 ring-brand-200 ring-inset">
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Feedback                                                                    */
/* -------------------------------------------------------------------------- */

const ALERT_TONES = {
  error: 'border-red-200 bg-red-50 text-red-800',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  info: 'border-slate-200 bg-slate-50 text-slate-700',
} as const;

export function Alert({
  tone = 'info',
  children,
}: {
  tone?: keyof typeof ALERT_TONES;
  children: ReactNode;
}) {
  return (
    <p
      // Announced by screen readers as soon as it appears.
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx('rounded-sm border px-3 py-2 text-sm', ALERT_TONES[tone])}
    >
      {children}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Forms                                                                       */
/* -------------------------------------------------------------------------- */

export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL =
  'block w-full rounded-sm border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 ' +
  'placeholder:text-slate-400 focus:border-brand-600 focus:ring-1 focus:ring-brand-600 ' +
  'disabled:cursor-not-allowed disabled:bg-slate-50 aria-[invalid=true]:border-red-400';

export function TextInput({
  invalid,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...props}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${props.id}-error` : props['aria-describedby']}
      className={cx(CONTROL, className)}
    />
  );
}

export function SelectInput({
  invalid,
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      {...props}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${props.id}-error` : props['aria-describedby']}
      className={cx(CONTROL, className)}
    >
      {children}
    </select>
  );
}

export function TextArea({
  invalid,
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      {...props}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${props.id}-error` : props['aria-describedby']}
      className={cx(CONTROL, 'min-h-24 resize-y', className)}
    />
  );
}

/** Own label, so it is not wrapped in <Field>. */
export function Checkbox({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <div className="flex gap-2.5">
      <input
        {...props}
        type="checkbox"
        className="mt-0.5 size-4 rounded-xs border-slate-300 text-brand-700 focus:ring-brand-600"
      />
      <div>
        <label htmlFor={props.id} className="block text-sm font-medium text-slate-800">
          {label}
        </label>
        {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
      </div>
    </div>
  );
}

const BUTTON_VARIANTS = {
  primary:
    'bg-brand-700 text-white hover:bg-brand-800 disabled:bg-brand-700/50 disabled:cursor-not-allowed',
  secondary:
    'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:opacity-60',
  ghost: 'text-slate-700 hover:bg-slate-100 disabled:opacity-60',
} as const;

export function buttonStyles(variant: keyof typeof BUTTON_VARIANTS = 'primary'): string {
  return cx(
    'inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2 text-sm font-medium',
    'transition-colors',
    BUTTON_VARIANTS[variant],
  );
}

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON_VARIANTS }) {
  return <button {...props} className={cx(buttonStyles(variant), className)} />;
}
