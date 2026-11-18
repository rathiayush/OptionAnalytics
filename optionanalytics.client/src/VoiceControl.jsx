import { AudioMutedOutlined, AudioOutlined, CloseOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { Tooltip } from 'antd'
import { useViewport } from './useScreen.js'
import { isTouchScreen, voiceHelpLines, voiceHint } from './voiceCommands.js'

// The VOICE pill: a small panel that floats at the top right while OI Replay's "Voice" tick is on - the mic state, what
// the browser is hearing now and the last command it carried out, so a glance says whether the right thing was heard.
// ⓘ lists the commands, ✕ turns Voice off. Over the cards AND the popups (VOICE_Z); below the header on a phone, where
// the ☰ and the status tags are in that row.

const DOT = { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 }
// ABOVE the quick-view popups (antd's modal, 1000): the mic button is how "close" is said on a phone, so a popup
// must never cover it. Under antd's tooltips (1070) so the pill's own ⓘ still opens over it.
export const VOICE_Z = 1060

export function VoiceControl({ supported, on, hold = true, asking = false, ready = false, listening, heard, last, error, onOff, onPress, onRelease }) {
  const viewport = useViewport()
  if (!on) return null
  const narrow = viewport.width <= 768
  const touch = isTouchScreen()
  const help = voiceHelpLines()
  return (
    <div
      aria-label="Voice commands"
      style={{
        position: 'fixed', top: narrow ? 64 : 10, right: 12, zIndex: VOICE_Z,
        maxWidth: narrow ? 'calc(100vw - 24px)' : 360, display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px', borderRadius: 8, fontSize: 12, color: '#fff',
        background: 'rgba(22,26,34,0.94)', border: `1px solid ${listening ? '#1677ff' : 'rgba(255,255,255,0.18)'}`,
        boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <Tooltip title={listening ? 'The microphone is open' : hold ? (touch ? 'The microphone is shut - hold the mic button to speak' : 'The microphone is shut - hold Ctrl to speak') : 'The microphone is starting'}>
          {listening ? <AudioOutlined style={{ color: '#1677ff' }} /> : <AudioMutedOutlined style={{ color: '#8c8c8c' }} />}
        </Tooltip>
        <span style={{ ...DOT, background: listening ? '#26a69a' : '#595959' }} />
      </span>
      <span style={{ minWidth: 0, flex: 1, lineHeight: 1.3 }}>
        {!supported ? (
          <span style={{ color: '#ff7875' }}>This browser has no speech recognition - use Chrome, Edge or Safari (not Firefox or Brave).</span>
        ) : error ? (
          <span style={{ color: '#ff7875' }}>{error}</span>
        ) : (
          <>
            <span style={{ display: 'block', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {voiceHint({ hold, touch, asking, listening, last })}
            </span>
            {heard && (
              <span style={{ display: 'block', color: '#8c8c8c', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                “{heard}”
              </span>
            )}
          </>
        )}
      </span>
      {hold && supported && !error && (
        <button
          type="button" aria-label="Hold to talk" title="Hold to talk" disabled={!ready}
          onPointerDown={(e) => { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* mouse */ } onPress?.() }}
          onPointerUp={() => onRelease?.()}
          onPointerCancel={() => onRelease?.()}
          onLostPointerCapture={() => onRelease?.()}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            width: touch ? 48 : 30, height: touch ? 48 : 30, borderRadius: '50%', flexShrink: 0, padding: 0,
            border: `1px solid ${listening ? '#1677ff' : 'rgba(255,255,255,0.25)'}`,
            background: listening ? '#1677ff' : '#1f2430', color: '#fff', fontSize: touch ? 22 : 15,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: ready ? 'pointer' : 'not-allowed', opacity: ready ? 1 : 0.5,
            // A long press on a phone must be a hold, not a text selection, a magnifier or a context menu.
            touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
          }}
        >
          <AudioOutlined />
        </button>
      )}
      <Tooltip
        placement="bottomRight"
        title={(
          <div style={{ maxWidth: 320, fontSize: 12 }}>
            {help.map((line) => <div key={line} style={{ marginBottom: 4 }}>{line}</div>)}
            <div style={{ marginTop: 6, color: '#bfbfbf' }}>
              {hold
                ? 'Hold Ctrl - or the round mic button, the only way on a phone - while you speak. The microphone is shut the rest of the time, and another key (Ctrl + C) closes it at once.'
                : 'The microphone is open the whole time Voice is ticked.'}
              {' '}The browser does the listening (Chrome sends the audio to Google's speech service, Safari to Apple's).
              Voice never places, changes or closes an order.
            </div>
          </div>
        )}
      >
        <InfoCircleOutlined style={{ color: '#8c8c8c', cursor: 'help', flexShrink: 0 }} />
      </Tooltip>
      <button
        type="button" aria-label="Turn voice off" title="Turn voice off" onClick={onOff}
        style={{ background: 'none', border: 'none', color: '#8c8c8c', cursor: 'pointer', padding: 0, lineHeight: 1, flexShrink: 0 }}
      >
        <CloseOutlined />
      </button>
    </div>
  )
}
