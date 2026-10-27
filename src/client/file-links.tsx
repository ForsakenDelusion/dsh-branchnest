import { createContext, useContext, useState } from 'react'
import { userTextParts } from './file-references.ts'
import type { MessageFile } from '../model.ts'

export type OpenCanvasFile = (sessionId: string, path: string) => Promise<void>
export const CanvasFiles = createContext<OpenCanvasFile | undefined>(undefined)

export function MessageFiles({ files, sessionId }: { files: MessageFile[]; sessionId: string }) {
  const open = useContext(CanvasFiles)
  return <div className="pc-message-files">{files.map((file, i) => <FileLink key={i} name={file.name} path={file.path ?? file.name}
    onOpen={open && file.path ? () => open(sessionId, file.path!) : undefined}/>)}</div>
}

export function UserMessageText({ text, sessionId }: { text: string; sessionId: string }) {
  const open = useContext(CanvasFiles)
  return <div className="pc-user-text">{userTextParts(text).map((part, i) => part.kind === 'text' ? part.text
    : <FileLink key={i} name={part.name} path={part.path} onOpen={open ? () => open(sessionId, part.path) : undefined}/>)}</div>
}

export function FileLink({ name, path, onOpen }: { name: string; path: string; onOpen?: () => Promise<void> }) {
  const [error, setError] = useState(''), [opening, setOpening] = useState(false)
  const activate = async () => {
    if (!onOpen || opening) return
    setOpening(true); setError('')
    try { await onOpen() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setOpening(false) }
  }
  return <><button className="pc-file-link" type="button" title={path} aria-label={`打开文件 ${name}`} aria-busy={opening} disabled={!onOpen || opening} onClick={() => void activate()}>
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.15" aria-hidden="true"><path d="M9.5 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9.5 2Z"/><path d="M9 2v4h4M5.5 9h5M5.5 11.5H9"/></svg>
    <span>{name}</span>
  </button>{error && <span className="pc-file-error" role="alert">{error}</span>}</>
}
