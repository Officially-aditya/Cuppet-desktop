import { useEffect } from 'react';

export function CommandResultEnhancement() {
  useEffect(() => {
    let scheduled = false;
    const rewrite = () => {
      scheduled = false;
      for (const result of document.querySelectorAll<HTMLElement>('.react-command-result')) {
        const text = result.querySelector<HTMLElement>(':scope > span');
        if (!text || text.textContent?.trim() !== 'Command completed.') continue;
        const label = result.querySelector<HTMLElement>(':scope > strong')?.textContent?.trim() || 'Command';
        text.textContent = `${label} finished with no additional output.`;
      }
    };
    const requestRewrite = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(rewrite);
    };
    requestRewrite();
    const observer = new MutationObserver(requestRewrite);
    observer.observe(document.getElementById('root') ?? document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
