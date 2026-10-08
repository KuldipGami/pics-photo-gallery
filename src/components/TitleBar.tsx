import { Search, X } from 'lucide-react'
import type { Ref } from 'react'
import { Logo } from './Logo'

interface Props {
  query: string
  onQuery(q: string): void
  placeholder: string
  inputRef: Ref<HTMLInputElement>
  version: string
}

export function TitleBar({ query, onQuery, placeholder, inputRef, version }: Props) {
  return (
    <header className="titlebar">
      <div className="brand">
        <Logo size={22} />
        <span>Pics</span>
        {version && (
          <span className="version-badge" title={`Pics version ${version}`}>
            v{version}
          </span>
        )}
      </div>
      <div className="search">
        <Search size={16} className="search-icon" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onQuery('')
              e.currentTarget.blur()
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
        />
        {query ? (
          <button className="icon-btn tiny search-clear" onClick={() => onQuery('')} title="Clear search">
            <X size={14} />
          </button>
        ) : (
          <kbd className="search-kbd">Ctrl F</kbd>
        )}
      </div>
    </header>
  )
}
