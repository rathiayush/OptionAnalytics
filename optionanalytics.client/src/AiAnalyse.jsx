// "Analyse with AI" - one button for every run's report (Signal backtest page run or background run, Feature finder page
// run or background run, Compare all, a background run's row in the list). `buildText` (it may be async) makes the report's text (llmAnalysis.js); a LOCAL model reads it
// (server: LlmAnalysisService) and the answer shows in a dialog. It only interprets the numbers it is given - a lead to
// backtest, not a signal - and feeds no strategy, alert or order. Nothing is polled: the model server is asked once, when
// the dialog opens, and the analysis runs when the button is pressed.
import { CopyOutlined, RobotOutlined } from '@ant-design/icons'
import { Alert, Button, Input, Modal, Select, Space, Spin, Typography, message } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { llmAnalyse, llmStatus } from './llmAnalysis.js'
import { useAuth } from './shared.jsx'

const { Text } = Typography

const QUESTIONS = [
  'What stands out, and what is probably noise?',
  'Why might the losing days have lost?',
  'Is this likely overfitted? What would you check?',
  'Suggest one change to the rule or the levels to backtest next.',
]

// `questions` - the quick questions offered (default QUESTIONS); `defaultAsk` - asked on the first answer (a caller can ask for plain words).
export function AiAnalyse({ buildText, title = 'AI analysis', disabled = false, size = 'small', label = 'Analyse with AI', questions = QUESTIONS, defaultAsk = '' }) {
  const auth = useAuth()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState(null)
  const [model, setModel] = useState('')
  const [ask, setAsk] = useState(defaultAsk)
  const [state, setState] = useState({ phase: 'idle' })
  const abort = useRef(null)

  const run = async (question = ask) => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    let text = ''
    try { text = await buildText() } catch (e) { setState({ phase: 'error', error: `The report could not be read: ${e.message}` }); return }
    if (!text) { setState({ phase: 'error', error: 'There is no report to analyse yet.' }); return }
    setState({ phase: 'running', started: Date.now(), chars: text.length })
    try {
      const answer = await llmAnalyse(text, { ask: question, model, signal: controller.signal })
      setState({ phase: 'done', answer })
    } catch (e) {
      if (controller.signal.aborted) return
      setState({ phase: 'error', error: e.message })
    }
  }

  const start = async () => {
    setOpen(true)
    setState({ phase: 'checking' })
    let s
    try { s = await llmStatus() } catch (e) { setState({ phase: 'error', error: e.message }); return }
    setStatus(s)
    if (!s.enabled || !s.available) { setState({ phase: 'error', error: s.reason ?? 'The model server is not available.' }); return }
    setModel((m) => m || s.defaultModel)
    await run(ask)
  }

  const close = () => { abort.current?.abort(); setOpen(false) }
  useEffect(() => () => abort.current?.abort(), [])

  const copy = async () => {
    try { await navigator.clipboard.writeText(state.answer.text); message.success('Copied') } catch { message.error('Could not copy') }
  }

  // The AI analysis is a local model: on a real deployment (Environment:IsLocal off) there is no button at all.
  if (auth?.user?.isLocal !== true) return null

  return (
    <>
      <Button size={size} icon={<RobotOutlined />} onClick={start} disabled={disabled}>{label}</Button>
      <Modal
        open={open} onCancel={close} footer={null} width={760} title={title} destroyOnClose
        styles={{ body: { maxHeight: '70vh', overflowY: 'auto' } }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Read by a local model on this machine - nothing is sent anywhere. It only interprets the numbers in the report and can be wrong:
            treat what it says as something to backtest, never as a signal.
          </Text>
          {status?.available && (
            <Space wrap size={[8, 8]} style={{ width: '100%' }}>
              {status.models.length > 1 && (
                <Select size="small" value={model} onChange={setModel} style={{ width: 190 }} aria-label="Model" options={status.models.map((m) => ({ value: m, label: m }))} />
              )}
              <Select
                size="small" placeholder="Quick question" style={{ width: 260, maxWidth: '100%' }} aria-label="Quick question" allowClear
                onChange={(q) => { setAsk(q ?? '') }} value={questions.includes(ask) ? ask : undefined}
                options={questions.map((q) => ({ value: q, label: q }))}
              />
            </Space>
          )}
          {status?.available && (
            <Space.Compact style={{ width: '100%' }}>
              <Input size="small" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Or ask your own question about this report" maxLength={1000} onPressEnter={() => run()} />
              <Button size="small" type="primary" onClick={() => run()} disabled={state.phase === 'running'}>Ask</Button>
            </Space.Compact>
          )}
          {(state.phase === 'checking' || state.phase === 'running') && (
            <Space>
              <Spin size="small" />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {state.phase === 'checking' ? 'Checking the model server…' : `The model is reading ${Math.round(state.chars / 1000)}k characters - the first answer loads the model into memory and can take a minute or two.`}
              </Text>
            </Space>
          )}
          {state.phase === 'error' && <Alert type="warning" showIcon message={state.error} />}
          {state.phase === 'done' && (
            <>
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55, fontSize: 13 }}>{state.answer.text}</div>
              <Space size={12}>
                <Text type="secondary" style={{ fontSize: 12 }}>{state.answer.model} · {state.answer.seconds}s</Text>
                <Button size="small" icon={<CopyOutlined />} onClick={copy}>Copy</Button>
              </Space>
            </>
          )}
        </Space>
      </Modal>
    </>
  )
}
