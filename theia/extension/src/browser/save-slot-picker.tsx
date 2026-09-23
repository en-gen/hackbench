/**
 * Save-slot dropdown: pick which save the next Start loads, and manage slots
 * in place. Each row carries its own actions (rename, duplicate, delete) as
 * icon buttons, the way VS Code's quick-pick items carry theirs; rename turns
 * the label into a text field with a save button.
 *
 * Stateless: the owner holds the slots and the selection and does the file
 * work, so what this shows is always what is on disk.
 */
import * as React from '@theia/core/shared/react'

export interface SaveSlotView {
  slot: number
  label?: string
  /** Chosen but never written: the game has not saved into it yet. */
  isNew?: boolean
}

export interface SaveSlotPickerProps {
  slots: SaveSlotView[]
  selected: number
  /** The slot the running game writes to; it cannot be deleted. */
  inUse?: number
  disabled?: boolean
  onSelect(slot: number): void
  onNew(): void
  onRename(slot: number, label: string): void
  onDuplicate(slot: number): void
  onDelete(slot: number): void
  /** Other .srm files in saves/, e.g. from another emulator. */
  foreign?: string[]
  onImport?(file: string): void
  /** Opening re-reads the list: a fallback should a folder watch miss a change. */
  onOpen?(): void
}

export const slotName = (s: { slot: number; label?: string }): string =>
  s.label ? `Save ${s.slot} · ${s.label}` : `Save ${s.slot}`

export function SaveSlotPicker(props: SaveSlotPickerProps): React.ReactElement {
  const { slots, selected, inUse, disabled } = props
  const [open, setOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<number | undefined>()
  const [draft, setDraft] = React.useState('')
  const root = React.useRef<HTMLDivElement>(null)
  const toggle = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) {
        setOpen(false)
        setEditing(undefined)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const close = (): void => {
    setOpen(false)
    setEditing(undefined)
    toggle.current?.focus()
  }
  const commitRename = (slot: number): void => {
    props.onRename(slot, draft)
    setEditing(undefined)
  }
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Escape' || !open) return
    e.stopPropagation()
    if (editing !== undefined) setEditing(undefined)
    else close()
  }

  const current = slots.find(s => s.slot === selected) ?? { slot: selected }

  return (
    <div className="hb-saves" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={toggle}
        className="hb-saves-toggle"
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Save slot"
        title="Save slot: which save the next Start loads"
        onClick={() => {
          if (open) return close()
          props.onOpen?.()
          setOpen(true)
        }}
      >
        <span className="codicon codicon-save" />
        <span className="hb-saves-current">{slotName(current)}</span>
        <span className="codicon codicon-chevron-down" />
      </button>
      {open && !disabled && (
        <div className="hb-saves-menu" role="group" aria-label="Save slots">
          {slots.map(s => (
            <div
              key={s.slot}
              className={`hb-saves-item${s.slot === selected ? ' hb-saves-selected' : ''}`}
              data-slot={s.slot}
            >
              {editing === s.slot ? (
                <>
                  <input
                    className="hb-saves-rename"
                    autoFocus
                    value={draft}
                    placeholder={`Save ${s.slot}`}
                    aria-label={`Label for save ${s.slot}`}
                    maxLength={80}
                    onChange={e => setDraft(e.currentTarget.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename(s.slot)
                    }}
                  />
                  <button
                    className="hb-saves-action"
                    title="Save label"
                    aria-label="Save label"
                    onClick={() => commitRename(s.slot)}
                  >
                    <span className="codicon codicon-save" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="hb-saves-pick"
                    aria-current={s.slot === selected}
                    onClick={() => {
                      // Close first: closing returns focus to the toggle, and
                      // a choice that restarts the game focuses the emulator,
                      // which must be the last word.
                      close()
                      props.onSelect(s.slot)
                    }}
                  >
                    <span className="codicon codicon-check hb-saves-check" />
                    <span className="hb-saves-name">{slotName(s)}</span>
                    {s.isNew && <span className="hb-saves-note">new</span>}
                  </button>
                  {!s.isNew && (
                    <>
                      <button
                        className="hb-saves-action"
                        title="Rename"
                        aria-label={`Rename save ${s.slot}`}
                        onClick={() => {
                          setDraft(s.label ?? '')
                          setEditing(s.slot)
                        }}
                      >
                        <span className="codicon codicon-edit" />
                      </button>
                      <button
                        className="hb-saves-action"
                        title="Duplicate"
                        aria-label={`Duplicate save ${s.slot}`}
                        onClick={() => props.onDuplicate(s.slot)}
                      >
                        <span className="codicon codicon-copy" />
                      </button>
                      <button
                        className="hb-saves-action"
                        disabled={s.slot === inUse}
                        title={s.slot === inUse ? 'In use by the running game' : 'Delete'}
                        aria-label={`Delete save ${s.slot}`}
                        onClick={() => props.onDelete(s.slot)}
                      >
                        <span className="codicon codicon-trash" />
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          ))}
          {props.foreign && props.foreign.length > 0 && (
            <div className="hb-saves-foreign" aria-label="Other save files">
              <div className="hb-saves-heading">Other save files</div>
              {props.foreign.map(file => (
                <div key={file} className="hb-saves-item" data-file={file}>
                  <span className="hb-saves-foreign-name" title={file}>
                    {file}
                  </span>
                  <button
                    className="hb-saves-action"
                    title="Import into the next free slot"
                    aria-label={`Import ${file}`}
                    onClick={() => props.onImport?.(file)}
                  >
                    <span className="codicon codicon-file-symlink-file" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            className="hb-saves-new"
            onClick={() => {
              close()
              props.onNew()
            }}
          >
            <span className="codicon codicon-add" />
            <span>New save</span>
          </button>
        </div>
      )}
    </div>
  )
}
