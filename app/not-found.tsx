export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-full gap-4 p-8">
      <h1 className="text-6xl font-bold text-[var(--text-primary)]">404</h1>
      <p className="text-lg text-[var(--text-secondary)]">
        This page could not be found.
      </p>
      <a
        href="/"
        className="mt-4 px-4 py-2 rounded-md bg-[var(--primary)] text-white hover:bg-[var(--primary-dark)] transition-colors"
      >
        Go back home
      </a>
    </div>
  );
}
