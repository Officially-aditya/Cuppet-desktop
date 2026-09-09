import { useEffect } from 'react';

export function Toast({ message, onClear }: { message: string | null; onClear: () => void }) {
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(onClear, 4500);
    return () => window.clearTimeout(timer);
  }, [message, onClear]);
  if (!message) return null;
  return <div className="toast react-toast" role="status">{message}</div>;
}
