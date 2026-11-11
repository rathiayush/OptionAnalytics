#!/usr/bin/env node
// Ask a LOCAL model (Ollama) to read a Signal backtest / Feature finder report and say what it shows.
//
//   node llm/analyse.mjs <report-file> [--model qwen2.5:14b] [--ask "extra question"]
//
// The report is any text the app produced: the Feature finder's report or CSV, a backtest result
// JSON (`{id}.result.json`), the trades CSV. Nothing leaves this machine - Ollama runs on
// http://localhost:11434. The model only INTERPRETS the numbers it is given; it never computes
// them, and its answer is a lead to test in the backtest, not a signal.
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--model' && args[args.indexOf(a) - 1] !== '--ask')
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
if (!file) {
  console.error('usage: node llm/analyse.mjs <report-file> [--model qwen2.5:14b] [--ask "question"]')
  process.exit(1)
}
const model = opt('--model', 'qwen2.5:14b')
const ask = opt('--ask', '')
const host = process.env.OLLAMA_HOST || 'http://localhost:11434'

// A 14B model on a 24 GB Mac holds ~16k tokens comfortably; ~4 characters a token, leave room for the answer.
const MAX_CHARS = 36000
let text = readFileSync(file, 'utf8')
let cut = ''
if (text.length > MAX_CHARS) {
  cut = `\n\n[The file is ${text.length} characters; only the first ${MAX_CHARS} are shown.]`
  text = text.slice(0, MAX_CHARS)
}

const system = [
  'You are a careful quantitative analyst reading a report from an index-options backtest tool (NIFTY / BANKNIFTY / SENSEX).',
  'Use ONLY the numbers in the report. Never invent a number, a feature or a result; if something is not in the report, say so.',
  'Be skeptical: a reading counts only if it holds in BOTH the earlier and the later days; few days or trades means "a hint, not proof".',
  'Remember charges and slippage, and that many minute rows on one day are not independent.',
  'Answer in this order: 1) what the report is, 2) what holds and why it might be real, 3) what looks like noise or overfitting, 4) ONE concrete rule to backtest next, using the readings named in the report, 5) what would make you drop it.',
  'Keep it under 350 words. This is research, not a trading signal.',
].join(' ')

const user = `${ask ? ask + '\n\n' : ''}Report (${file}):\n\n${text}${cut}`

const res = await fetch(`${host}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model,
    stream: true,
    options: { num_ctx: 16384, temperature: 0.2 },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }),
}).catch((e) => {
  console.error(`Cannot reach Ollama at ${host} (${e.message}). Start it with: /Applications/Ollama.app/Contents/Resources/ollama serve`)
  process.exit(2)
})
if (!res.ok) {
  console.error(`Ollama answered ${res.status}: ${await res.text()}`)
  process.exit(3)
}

const decoder = new TextDecoder()
let buffer = ''
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true })
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    const part = JSON.parse(line)
    if (part.message?.content) process.stdout.write(part.message.content)
  }
}
process.stdout.write('\n')
