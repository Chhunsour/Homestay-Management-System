/** The status label with its owner-chosen colour. Used by list, detail and calendar. */
export function StatusChip({ label, color }: { label: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200 ring-inset">
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      {label}
    </span>
  );
}
