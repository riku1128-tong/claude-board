# Claude Code Task Board

Claude Code が実際に持っているタスク・セッションを、ローカルのボード画面で可視化します。
依存パッケージなし（Node.js 18 以上だけ）。

## 起動

```bash
cd claude-board
node server.mjs
# → http://localhost:8787 をブラウザで開く
```

オプション:

```bash
node server.mjs --port 9000                 # ポート変更
node server.mjs --dir "C:\Users\you\.claude" # .claude の場所を指定（既定: ~/.claude または CLAUDE_CONFIG_DIR）
node server.mjs --active-minutes 30         # 何分以内の更新を「稼働中」とみなすか（プロセス情報が無い場合の補助）
node server.mjs --done-days 30              # 完了タスクを何日分表示するか（既定 7、0 で無制限）
```

Windows は PowerShell / コマンドプロンプトから同じコマンドで動きます。

### 困ったとき

- **`node` が見つからない**: Node.js を PATH に通すか、フルパスで起動してください。Claude デスクトップアプリ同梱の node でも動きます（例: `& "C:\Program Files\Bionic\resources\app\.webpack-bionic\bin\node.exe" server.mjs`）。
- **`http://localhost:8787` を開くと別のアプリの画面や 404 が出る**: 他のプロセスが同じポートを使っています（起動ログに「注意: … は別のプロセスが使用中です」と出ます）。`--port 8790` などで回避してください。サーバーは `127.0.0.1` と `::1` の両方に bind するので、片方だけ空いていれば `http://127.0.0.1:8787` / `http://[::1]:8787` で直接開くこともできます。
- **セッションは出るのにタスクが 0 件**: Claude Code のタスクツール（TaskCreate 等）は Claude 5 系モデルでは既定で無効です。`~/.claude/settings.json` に次を書くと全セッションで有効になり、`~/.claude/tasks/<sessionId>/<n>.json` が作られてボードに流れてきます（設定変更は起動中のセッションにも反映されます）。

  ```json
  { "env": { "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" } }
  ```

  それでも 0 件なら、Claude Code がまだタスクを作っていないだけです（3 ステップ以上の作業を頼むと自動で作ります）。

## 読み取っているもの（すべて読み取り専用）

| 場所 | 内容 |
| --- | --- |
| `~/.claude/sessions/<pid>.json` | 起動中の Claude Code プロセス（busy / idle）→ セッション帯の「エージェント稼働中」「あなたの入力待ち」 |
| `~/.claude/tasks/<session>/*.json` | TaskCreate / TaskUpdate で作られたタスク（進行中・待機中・ブロック中・完了） |
| `~/.claude/todos/*.json` | 旧 TodoWrite 形式のタスク |
| `~/.claude/projects/**/*.jsonl` | セッション記録 → プロジェクト名 / cwd / ブランチ / 最初の依頼文 / 最終更新 |

タスクの状態はボードから変更しません（Claude Code 側が正）。
完了タスクは既定で直近 7 日分だけ表示します（`--done-days`）。ファイル自体は Claude Code の `cleanupPeriodDays`（既定 30 日、未完了も含む）で自動削除され、`deleted` にしたタスクは即時に消えます。
付箋とブックマークだけは `board-notes.json`（このフォルダ内）に保存されます。

## 画面

- **セッション帯**: 稼働中セッションが先頭。クリックでそのセッションのタスクだけに絞り込み
- **レーン**: 進行中 / ブロック中（blockedBy が未完了）/ 待機中 / 完了
- **詳細パネル**: 説明・担当（サブエージェント名）・cwd・ブランチ・待ち先・生データ・付箋
- 5 秒ごとに自動更新。`Ctrl K` で検索、右上で完了の表示切替・ダークモード
