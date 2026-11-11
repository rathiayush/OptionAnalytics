#!/usr/bin/env bash
# Start / stop / check everything for OptionAnalytics on this Mac: the local LLM (Ollama), the .NET server and the UI.
#
#   ./run.sh start        LLM + server + UI   (then open http://localhost:5173)
#   ./run.sh stop         stop all three
#   ./run.sh status       what is running
#   ./run.sh llm          only the LLM (Ollama) and the 14B model, loaded and kept for 30 min
#   ./run.sh server       only the .NET server
#   ./run.sh ui           only the UI
#   ./run.sh logs         follow the server and UI logs (Ctrl+C to leave)
#   ./run.sh unload       free the model's memory (Ollama keeps running)
#
# Logs: /tmp/oa-server.log, /tmp/oa-ui.log. The server uses OptionAnalytics.Server/appsettings.Local.json - with real Dhan
# credentials in it the server connects to Dhan and starts its live feed.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OLLAMA="/Applications/Ollama.app/Contents/Resources/ollama"
MODEL="${OA_MODEL:-qwen2.5:14b}"
SERVER_LOG=/tmp/oa-server.log
UI_LOG=/tmp/oa-ui.log

# The project targets .NET 8: use the 8 installed in ~/.dotnet (Microsoft's dotnet-install script) ahead of any newer system .NET.
if [ -x "$HOME/.dotnet/dotnet" ]; then export DOTNET_ROOT="$HOME/.dotnet"; export PATH="$HOME/.dotnet:$PATH"; fi
export PATH="$PATH:/usr/local/share/dotnet"
# Node comes from nvm (a script does not read ~/.zshrc).
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

up() { curl -s -o /dev/null --max-time 2 "$1"; }
say() { printf '%s\n' "$*"; }

llm_start() {
  if ! up http://localhost:11434; then
    say "Starting Ollama…"
    open /Applications/Ollama.app
    for _ in $(seq 1 20); do up http://localhost:11434 && break; sleep 1; done
  fi
  if up http://localhost:11434; then
    say "Ollama is running (http://localhost:11434). Loading $MODEL…"
    "$OLLAMA" run "$MODEL" --keepalive 30m "Reply with the single word: ready" >/dev/null 2>&1 \
      && say "$MODEL loaded (stays in memory 30 min)." \
      || say "Could not load $MODEL - is it installed? (\"$OLLAMA\" list)"
  else
    say "Ollama did not start."
  fi
}

server_start() {
  if up http://localhost:5080/api/version; then say "Server already running (http://localhost:5080)."; return; fi
  say "Starting the server… (log: $SERVER_LOG)"
  ( cd "$ROOT/OptionAnalytics.Server" && nohup dotnet run --launch-profile http >"$SERVER_LOG" 2>&1 & )
  for _ in $(seq 1 60); do up http://localhost:5080/api/version && { say "Server is up (http://localhost:5080)."; return; }; sleep 1; done
  say "The server is not answering yet - see $SERVER_LOG"
}

ui_start() {
  if up http://localhost:5173; then say "UI already running (http://localhost:5173)."; return; fi
  command -v npm >/dev/null || { say "npm not found - install Node (see RUNNING.md)."; return; }
  say "Starting the UI… (log: $UI_LOG)"
  ( cd "$ROOT/optionanalytics.client" && nohup npm run dev >"$UI_LOG" 2>&1 & )
  for _ in $(seq 1 30); do up http://localhost:5173 && { say "UI is up (http://localhost:5173)."; return; }; sleep 1; done
  say "The UI is not answering yet - see $UI_LOG"
}

status() {
  for row in "LLM (Ollama)|http://localhost:11434" "Server (.NET)|http://localhost:5080/api/version" "UI (Vite)|http://localhost:5173"; do
    name="${row%%|*}"; url="${row##*|}"
    if up "$url"; then printf '  %-14s running   %s\n' "$name" "$url"; else printf '  %-14s off\n' "$name"; fi
  done
  if up http://localhost:11434; then
    say "Models loaded in memory:"; "$OLLAMA" ps 2>/dev/null | sed 's/^/  /'
    say "Models installed:"; "$OLLAMA" list 2>/dev/null | sed 's/^/  /'
  fi
}

stop_all() {
  say "Stopping the UI and the server…"
  pkill -f "vite" 2>/dev/null
  pkill -f "OptionAnalytics.Server" 2>/dev/null
  say "Freeing the model's memory (Ollama itself keeps running - quit it from the menu bar if you want)…"
  up http://localhost:11434 && "$OLLAMA" stop "$MODEL" >/dev/null 2>&1
  sleep 2
  status
}

case "${1:-}" in
  start)   llm_start; server_start; ui_start; say ""; say "Open http://localhost:5173" ;;
  stop)    stop_all ;;
  status)  status ;;
  llm)     llm_start ;;
  server)  server_start ;;
  ui)      ui_start ;;
  logs)    tail -n 30 -f "$SERVER_LOG" "$UI_LOG" ;;
  unload)  "$OLLAMA" stop "$MODEL" && say "$MODEL unloaded." ;;
  *)       sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
esac
