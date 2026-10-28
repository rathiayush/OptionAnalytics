import { DownOutlined, RightOutlined } from '@ant-design/icons'
import { useFold } from './useFold.js'

// A text block that folds to one line and opens again (foldText.js has which and why): the explanations under the
// charts, the checklist's reasons, the straddle / GEX reads. Folded, it shows `summary` - or, without one, the start of
// its own text, cut at the end of the line - and a click anywhere on that line opens it.

/** The small ▸ / ▾ button a fold opens and closes with. */
export function FoldButton({ open, onToggle, label, style }) {
  return (
    <button
      type="button" className="oa-fold-button" aria-expanded={open}
      aria-label={`${open ? 'Fold' : 'Open'}${label ? ` ${label}` : ''}`} title={open ? 'Fold' : 'Open'}
      onClick={(e) => { e.stopPropagation(); onToggle(!open) }} style={style}
    >
      {open ? <DownOutlined /> : <RightOutlined />}
    </button>
  )
}

/**
 * A block of text that folds to one line. `id` names it (its fold is remembered for the account); `summary` is what
 * the folded line says (default: the block's own text, cut); `defaultOpen` - the reads open, the explanations not.
 * `className` / `style` go on the block (an explanation keeps the `oa-note` class: Compact still hides it whole).
 */
export function FoldText({ id, summary, defaultOpen = false, label, className, style, children }) {
  const [open, setOpen] = useFold(id, defaultOpen)
  return (
    <div className={`oa-fold ${open ? 'oa-fold-open' : 'oa-fold-folded'}${className ? ` ${className}` : ''}`} style={style}>
      <FoldButton open={open} onToggle={setOpen} label={label} />
      {open
        ? <div className="oa-fold-body">{children}</div>
        : (
          <div
            className="oa-fold-body" role="button" tabIndex={0} title="Open"
            onClick={() => setOpen(true)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true) } }}
          >
            {summary ?? children}
          </div>
        )}
    </div>
  )
}
