export type UserTextPart = { kind: 'text'; text: string } | { kind: 'file'; path: string; name: string }

/** DSH's explicit @path / @"path with spaces" references; ordinary text stays verbatim. */
export function userTextParts(text: string): UserTextPart[] {
  const parts: UserTextPart[] = []
  // Code spans/fences take precedence, so examples are never turned into actions.
  const tokens = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1|(`+)[^`\n]*?\2|(^|[\s(（])@(?:"([^"\r\n]+)"|([^\s"<>]+))/gm
  let offset = 0
  for (const match of text.matchAll(tokens)) {
    if (match[1] || match[2]) continue
    const path = match[4] ?? match[5], prefix = match[3] ?? ''
    if (!path || /[\u0000-\u001f\u007f]/u.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[/\\]/i.test(path)
      || !/[/\\]|\.[^./\\]+$/.test(path) || path.includes('@')) continue
    const start = match.index! + prefix.length
    if (start > offset) parts.push({ kind: 'text', text: text.slice(offset, start) })
    parts.push({ kind: 'file', path, name: path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) || path })
    offset = match.index! + match[0].length
  }
  if (offset < text.length) parts.push({ kind: 'text', text: text.slice(offset) })
  return parts
}

/** Same session-scoped resource address used by DSH's native file preview. */
export function sessionFileResource(sessionId: string, path: string): string {
  const encode = (segment: string) => encodeURIComponent(segment).replace(/%3A/gi, ':')
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return `dsh-resource://file/session/${encode(sessionId)}/${normalized.split('/').map(encode).join('/')}`
}
