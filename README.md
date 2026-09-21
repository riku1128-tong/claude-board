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
node server.mjs --tailscale                 # Tailscale の私設ネットワークからも開けるようにする（下記）
```

Windows は PowerShell / コマンドプロンプトから同じコマンドで動きます。

### スマホや外出先から見る（Tailscale）

ボードはローカルサーバーなので、そのままでは同じ PC からしか開けません。**Tailscale**（無料の私設ネットワーク）を PC とスマホに入れて同じアカウントでログインし、`--tailscale` を付けて起動すると、Tailscale の IPv4（100.64.0.0/10）でも待ち受けます。スマホから `http://<PC名>:8787` で開けます。インターネットには一切公開されず、Tailscale にログインした自分の端末だけが到達できます。

- 起動時に Tailscale が未接続でも、60 秒ごとに探して見つかり次第 bind します（ログオン時の自動起動向け）
- LAN や公開 IP には bind しません。それでも公開したい場合は `--host 0.0.0.0` を明示してください（非推奨。ボードには全セッションの内容と支出が出ます）
- スマホのログインは PC と同じプロバイダ（Google なら Google）を選ばないと別の tailnet になります

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

## トークン消費（グラフ）

ボード最上段の「トークン消費」は、セッション記録（`~/.claude/projects/**/*.jsonl`）の `message.usage` をローカルで集計したものです。設定不要・トークン消費なしで、数字は記録そのものなので正確です。

- **直近 5 時間（15 分ごと）／直近 7 日（日ごと）**: 新規トークン（入力＋キャッシュ作成＋出力）を Fable とその他のモデルで積み上げ表示。キャッシュ読取はホバーで確認できます
- **制限**: レート制限に当たった時刻に赤い点線。見出しには「5時間制限に到達 · リセット HH:MM」または「直近 24 時間で N 回制限に到達」が出ます（記録の `quotaLimits` から）

**使用率（%）のメーターは意図的にありません。** Claude Code がローカルに残す % は、ターミナルのステータスラインに来る `rate_limits` だけで、これは「そのセッションが最後に受け取った API 応答」の値です。他のセッションの消費は反映されず、更新には API 呼び出し（＝トークン消費）が必要なので、古い数字を出すくらいなら出さない方針にしました。正確な % はアプリの使用量パネルで確認してください。


## サービスと支出（台帳）

Claude 経由で使った外部サービスと課金を記録する台帳です（`board-spend.json`、このフォルダ内・`.gitignore` 済み）。サービス別の合計、明細、追加フォームがボードに出ます。

- **年月単位で管理**します。右上のセレクトで月を選ぶと、その月の合計・サービス別内訳・明細に切り替わり（既定は今月、「全期間」も可）、「月別推移」に月ごとの購入・従量・合計が並びます
- 画面のフォームで追加、行末のゴミ箱で削除。金額を空で登録すると「要確認」になります。「月額」にチェックすると、その月から毎月同額が発生するものとして各月に計上されます（サブスク用。解約したら API で `until` を入れる）
- 従量課金（メーター）は日別の記録から月ごとに集計されます
- API: `GET /api/spend` で一覧、`POST /api/spend` に `{"service","amount"|null,"currency":"USD"|"JPY","note","sessionId","source"}` で追加、`{"update":"<id>", …}` で修正、`{"delete":"<id>"}` で削除。`recurring:"monthly"` と `until` で月額サブスクを表現
- `sessionId` を入れるとボード上でプロジェクト名・セッション名と紐づきます
- Claude Code のセッションから自動で記録させるには `~/.claude/CLAUDE.md` に記録ルールを書きます（このリポジトリの HANDOFF.md に例）。記録自体は curl 1 回で、Claude のトークンはほぼ使いません


### 従量課金の実測（メーター）

API の従量課金（TypeSafe など）は「購入」というイベントが無く、使った分だけじわじわ増えるので台帳には向きません。代わりに **各プロジェクトが API 応答の `usage` を 1 行ずつ `usage.jsonl` に追記**し、ボードがそれを日別に集計してコストを見積もります（トークン消費なし・無人・リアルタイム）。

`board-meters.json`（このフォルダ内、`.gitignore` 済み）:

```json
{ "meters": [ { "service": "TypeSafe (Jev)", "file": "C:\path\to\project\usage.jsonl", "pricePerMInput": 0.042, "pricePerMOutput": 0, "currency": "USD" } ] }
```

`usage.jsonl` の 1 行: `{"ts":"2026-09-21T12:00:00Z","input_tokens":1702,"output_tokens":122}`（`requests` を付ければ集計済みの行として扱う）。コスト = 入力トークン × `pricePerMInput` / 1e6 ＋ 出力トークン × `pricePerMOutput` / 1e6。TypeSafe の Usage 画面が出す「Estimated」と同じ式です（あの画面は Cookie ログイン専用で無人取得できないため、ローカルで同じ計算をしています）。


## 画面

- **セッション帯**: 稼働中セッションが先頭。クリックでそのセッションのタスクだけに絞り込み
- **レーン**: 進行中 / ブロック中（blockedBy が未完了）/ 待機中 / 完了
- **詳細パネル**: 説明・担当（サブエージェント名）・cwd・ブランチ・待ち先・生データ・付箋
- 5 秒ごとに自動更新。`Ctrl K` で検索、右上で完了の表示切替・ダークモード
