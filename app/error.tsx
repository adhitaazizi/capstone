'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-full gap-4 p-8">
      <h1 className="text-2xl font-bold text-[var(--text-primary)]">
        Something went wrong
      </h1>
      <p className="text-[var(--text-secondary)]">
        {error.message || 'An unexpected error occurred.'}
      </p>
      <button
        onClick={reset}
        className="mt-4 px-4 py-2 rounded-md bg-[var(--primary)] text-white hover:bg-[var(--primary-dark)] transition-colors"
      >
        Try again
      </button>
    </div>
  );
}
