export default function Loading() {
  return (
    <div className="flex flex-col items-center justify-center min-h-full gap-4 p-8">
      <div className="w-10 h-10 border-4 border-[var(--border)] border-t-[var(--primary)] rounded-full animate-spin" />
      <p className="text-[var(--text-secondary)]">Loading...</p>
    </div>
  );
}
