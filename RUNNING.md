# Running OptionAnalytics on this Mac

Everything here is copy-and-paste. Run each block in its own terminal tab, from anywhere (the commands use full paths).

| Part | Address |
|---|---|
| Server (.NET 11) | http://localhost:5080 |
| UI (Vite) | http://localhost:5173 (open this one) |
| Local LLM (Ollama) | http://localhost:11434 |

## 0. One command for everything
```bash
cd /Users/ayush/GitHub/OptionAnalytics && ./run.sh start
```
Also `./run.sh stop`, `status`, `llm`, `server`, `ui`, `logs`, `unload` (`./run.sh` alone lists them). Logs: `/tmp/oa-server.log`,
`/tmp/oa-ui.log`. The sections below are the same commands one at a time.

## 1. Start

### From VS Code (easiest)
Run and Debug panel (Cmd+Shift+D) -> **Server + Client** -> F5. Breakpoints work in C# and in the React code.
Start Ollama separately (section 1c) if you want the AI analysis.

### 1a. Server (.NET)
```bash
cd /Users/ayush/GitHub/OptionAnalytics/OptionAnalytics.Server && dotnet run --launch-profile http
```
Needs `OptionAnalytics.Server/appsettings.Local.json` (gitignored: Dhan login, cache folders). With real Dhan credentials in it the
server connects to Dhan and starts its live feed.

### 1b. UI (Vite dev server)
```bash
cd /Users/ayush/GitHub/OptionAnalytics/optionanalytics.client && npm run dev
```
First time only (or after `package.json` changes): `npm install` in the same folder.

### 1c. Local LLM (Ollama) - for "Analyse with AI"
```bash
open /Applications/Ollama.app
```
Or, as a terminal that stays open:
```bash
/Applications/Ollama.app/Contents/Resources/ollama serve
```
Check it is up and which models it has:
```bash
curl http://localhost:11434/api/tags
```

## 2. Use the AI analysis
Signal backtest page -> run a backtest (or open a finished run) -> **Analyse with AI** on the report, the Feature finder or
Compare all. The first answer after starting takes longer: the model loads into memory.

Chat with a model in the terminal (`/bye` to leave):
```bash
/Applications/Ollama.app/Contents/Resources/ollama run qwen2.5:14b
```
Analyse any report file from the terminal:
```bash
cd /Users/ayush/GitHub/OptionAnalytics && node llm/analyse.mjs path/to/report.txt
```

## 3. Stop

### Server and UI
Press Ctrl+C in the tab that runs it. If a tab is gone and something is still running:
```bash
pkill -f OptionAnalytics.Server
```
```bash
pkill -f vite
```

### LLM
Free the model's memory but keep Ollama running:
```bash
/Applications/Ollama.app/Contents/Resources/ollama stop qwen2.5:14b
```
Quit Ollama completely: menu bar icon -> Quit, or
```bash
pkill -f "ollama serve"
```

### Check that everything is off
```bash
curl -s -o /dev/null -w "server %{http_code}\n" --max-time 2 http://localhost:5080/api/version
curl -s -o /dev/null -w "ui %{http_code}\n" --max-time 2 http://localhost:5173
curl -s -o /dev/null -w "llm %{http_code}\n" --max-time 2 http://localhost:11434/api/tags
```
`000` means off, `200` means running.

## 4. Models
```bash
/Applications/Ollama.app/Contents/Resources/ollama list
```
```bash
/Applications/Ollama.app/Contents/Resources/ollama ps
```
```bash
/Applications/Ollama.app/Contents/Resources/ollama pull gemma3:27b
```
- `list` = installed, `ps` = loaded in memory now, `pull` = download one.
- `qwen2.5:14b` (9 GB) is the default and fits easily. `gemma3:27b` (16 GB) is the biggest that fits in 24 GB - close other heavy
  apps when you use it. The AI dialog's model picker lists whatever is installed.
- Default model: `Llm:Model` in `appsettings.Local.json`, e.g. `"Llm": { "Model": "gemma3:27b" }`.

## 5. Tests and checks
```bash
cd /Users/ayush/GitHub/OptionAnalytics && dotnet test OptionAnalytics.sln
```
```bash
cd /Users/ayush/GitHub/OptionAnalytics/optionanalytics.client && npm test && npm run lint && npx vite build
```
After any change to the strategy scanner, all of the second block must pass before committing (see CLAUDE.md).

## 6. Where the data lives
| What | Folder |
|---|---|
| Dhan cache (past days) | `/Users/ayush/optionanalytics-data/dhan-cache` |
| Order Flow days | `/Users/ayush/optionanalytics-data/order-flow` |
| Local settings and credentials | `OptionAnalytics.Server/appsettings.Local.json` (never commit) |

Both data folders are set in `appsettings.Local.json`. After copying cache files in, restart the server.

## 7. If something is wrong
| Problem | Fix |
|---|---|
| `npm: command not found` | Open a new terminal tab (nvm loads from `~/.zshrc`), or run `. ~/.nvm/nvm.sh` first. |
| `You must install or update .NET` | The project targets .NET 11; check `dotnet --list-runtimes` shows 11.0. |
| UI loads but the data is empty | The server is not running, or Vite's proxy port differs (it defaults to 5080; `BACKEND_URL` changes it). |
| "model server is not running" in the AI dialog | Start Ollama (1c). |
| Port already in use | Stop the old one (section 3), then start again. |

## 8. Background runs and the server scanner (scanner-runner)
Background backtests, the server scanner and the live strategy scan run as Node scripts the server starts. Locally they must be
built and placed next to the server, and the server needs Node's full path (VS Code does not load nvm):
```bash
cd /Users/ayush/GitHub/OptionAnalytics/optionanalytics.client && npm run build:runner
mkdir -p ../OptionAnalytics.Server/scanner-runner
cp dist-runner/*.mjs scanner-runner/package.json ../OptionAnalytics.Server/scanner-runner/
cd ../OptionAnalytics.Server/scanner-runner && npm install --omit=dev
```
Run it again whenever the scanner or backtest code changes. `appsettings.Local.json` needs
`"ScannerRunner": { "NodePath": "/Users/ayush/.nvm/versions/node/v26.13.0/bin/node" }` (change it if `node -v` changes). Restart the
server after either.

## 9. Local tools (the AI analysis) - settings
The "Analyse with AI" buttons exist only when the server says it runs locally. In `OptionAnalytics.Server/appsettings.Local.json` (never committed):
```json
"Environment": { "IsLocal": false, "LocalTools": true }
```
`LocalTools` follows `IsLocal` when it is not set - but `IsLocal: true` also makes OI Replay read past days from the stored database ONLY (never
Dhan), and with no database every day fails ("Stored data is not configured"). So on a machine with no database keep `IsLocal` false and set
`LocalTools` true. A deployment sets neither: the AI buttons and their endpoints do not exist there.

## 10. .NET version
The project targets **.NET 8** (`net8.0`). This Mac also has .NET 11 in `/usr/local/share/dotnet`, which has no 8 runtime, so .NET 8 is installed beside it in
`~/.dotnet` (`dotnet-install.sh --channel 8.0 --install-dir ~/.dotnet`). `./run.sh` and the VS Code launch / build task use it. In a plain terminal:
```bash
export DOTNET_ROOT="$HOME/.dotnet" PATH="$HOME/.dotnet:$PATH"
cd /Users/ayush/GitHub/OptionAnalytics/OptionAnalytics.Server && dotnet run --launch-profile http
```
