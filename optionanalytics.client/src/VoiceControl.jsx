import { AudioMutedOutlined, AudioOutlined, CloseOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { Tooltip } from 'antd'
import { FAB_Z } from './quickViews.js'
import { useViewport } from './useScreen.js'
import { voiceHelpLines } from './voiceCommands.js'

// The VOICE pill: a small panel that floats at the top right while OI Replay's "Voice" tick is on - the mic state, what
// the browser is hearing now and the last command it carried out, so a glance says whether the right thing was heard.
// ⓘ lists the commands, ✕ turns Voice off. Over the cards, under the popups (FAB_Z); below the header on a phone, where
// the ☰ and the status tags are in that row.

const DOT = { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 }

export function VoiceControl({ supported, on, listening, heard, last, error, onOff }) {
  const viewport = useViewport()
  if (!on) return null
  const narrow = viewport.width <= 768
  const help = voiceHelpLines()
  return (
    <div
      aria-label="Voice commands"
      style={{
        position: 'fixed', top: narrow ? 64 : 10, right: 12, zIndex: FAB_Z,
        maxWidth: narrow ? 'calc(100vw - 24px)' : 360, display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px', borderRadius: 8, fontSize: 12, color: '#fff',
        background: 'rgba(22,26,34,0.94)', border: `1px solid ${listening ? '#1677ff' : 'rgba(255,255,255,0.18)'}`,
        boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {listening ? <AudioOutlined style={{ color: '#1677ff' }} /> : <AudioMutedOutlined style={{ color: '#8c8c8c' }} />}
        <span style={{ ...DOT, background: listening ? '#26a69a' : '#595959' }} />
      </span>
      <span style={{ minWidth: 0, flex: 1, lineHeight: 1.3 }}>
        {!supported ? (
          <span style={{ color: '#ff7875' }}>This browser cannot listen - Chrome or Safari can.</span>
        ) : error ? (
          <span style={{ color: '#ff7875' }}>{error}</span>
        ) : (
          <>
            <span style={{ display: 'block', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {last || (listening ? 'Listening…' : 'Starting…')}
            </span>
            {heard && (
              <span style={{ display: 'block', color: '#8c8c8c', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                “{heard}”
              </span>
            )}
          </>
        )}
      </span>
      <Tooltip
        placement="bottomRight"
        title={(
          <div style={{ maxWidth: 320, fontSize: 12 }}>
            {help.map((line) => <div key={line} style={{ marginBottom: 4 }}>{line}</div>)}
            <div style={{ marginTop: 6, color: '#bfbfbf' }}>
              The browser does the listening (Chrome sends the audio to Google's speech service, Safari to Apple's) and only
              while this is on. Voice never places, changes or closes an order.
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
