export function SourceAction({ title, quote, onClick }: { title: string; quote?: string; onClick(): void }) {
  return <button className="pc-source-action" aria-label={`返回来源：${title}`} title={`来源 · ${title}${quote ? `\n${quote}` : ''}`} onClick={onClick}>
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M6.5 3 2.5 7l4 4M3 7h6a4 4 0 0 1 4 4v2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  </button>
}
