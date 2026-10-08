import { Check, Copy, ScanText } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fold } from '../lib/search'
import './photo-text.css'

interface Props {
  /** The text Lumen read in the photo (lines separated by \n), or null: nothing is shown. */
  text: string | null
  /** The current search, to highlight its words in the text. */
  query?: string
  onToast(text: string): void
}

const COLLAPSED_LINES = 8

/** Character ranges of the line where a search word starts a word ("recei" in "Receipt"). */
function matches(line: string, words: string[]) {
  if (!words.length) return []
  let folded = ''
  const at: number[] = [] // folded index -> line index
  for (let i = 0; i < line.length; i++) {
    for (const c of fold(line[i])) {
      folded += c
      at.push(i)
    }
  }
  const ranges: [number, number][] = []
  for (const w of words) {
    for (let s = folded.indexOf(w); s >= 0; s = folded.indexOf(w, s + 1)) {
      if (s > 0 && /[\p{L}\p{N}]/u.test(folded[s - 1])) continue
      ranges.push([at[s], at[s + w.length - 1] + 1])
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([...r])
  }
  return merged
}

function Line({ line, words }: { line: string; words: string[] }) {
  const ranges = matches(line, words)
  if (!ranges.length) return <div>{line}</div>
  const parts = []
  let from = 0
  ranges.forEach(([s, e], i) => {
    if (s > from) parts.push(line.slice(from, s))
    parts.push(<mark key={i}>{line.slice(s, e)}</mark>)
    from = e
  })
  parts.push(line.slice(from))
  return <div>{parts}</div>
}

/** "Text in this photo" for the details panel: what Windows' text recognition read, selectable and copyable. */
export function PhotoText({ text, query = '', onToast }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    setExpanded(false)
    setCopied(false)
  }, [text])
  if (!text) return null
  const lines = text.split('\n')
  const words = [...new Set(fold(query).match(/[\p{L}\p{N}]+/gu) ?? [])].filter((w) => w.length > 1)
  const long = lines.length > COLLAPSED_LINES
  // Collapsed: the first lines, and any further down with a search word in them.
  const shown = !long || expanded ? lines : lines.filter((line, i) => i < COLLAPSED_LINES || matches(line, words).length > 0)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      onToast('Text copied')
    } catch {
      onToast("Couldn't copy the text")
    }
  }

  return (
    <div className="info-row photo-text-row">
      <ScanText size={18} />
      <div className="info-grow">
        <div className="photo-text-head">
          <div className="info-primary">Text in this photo</div>
          <button className="btn ghost photo-text-copy" onClick={copy} title="Copy all the text">
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="photo-text">
          {shown.map((line, i) => (
            <Line key={i} line={line} words={words} />
          ))}
        </div>
        {long && (
          <button className="link" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show less' : `Show all ${lines.length} lines`}
          </button>
        )}
      </div>
    </div>
  )
}
