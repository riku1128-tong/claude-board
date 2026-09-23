# Claude Code Task Board — 引き継ぎメモ（Claude Code 用）

このプロジェクトは Claude（チャット）で作成し、ここから Claude Code で続きを開発する。
最初に本ファイルと `README.md` を読み、`node server.mjs` で起動して http://localhost:8787 を確認してから作業を始めること。

## 目的

Claude Code が `~/.claude` 配下に記録しているタスク・セッションを、ブラウザのカンバン風ボードで可視化するローカル管理画面。
デザインの元イメージ: すりガラス調のレーン（進行中／判断待ち／エージェント待ち／保留／完了）＋左側に詳細パネル（付箋・履歴タブ、「エージェントに依頼」ボタン）。

## ファイル構成（依存パッケージなし / Node 18+）

```
claude-board/
├─ server.mjs      # HTTP サーバー + ~/.claude の読み取り。/api/state, /api/notes(POST), /api/events(SSE)
├─ index.html      # 画面（単一 HTML、CSS/JS 同梱。Google Fonts のみ外部）
├─ board-notes.json# 付箋・ブックマークの保存先（実行時に生成、ユーザーデータ）
├─ README.md       # 使い方
└─ HANDOFF.md      # このファイル
```

起動: `node server.mjs [--port 8787] [--dir <.claudeのパス>] [--active-minutes 10]`
環境変数 `CLAUDE_CONFIG_DIR` も参照。

## 読み取っているデータと実際の形式（確認済み）

すべて読み取り専用。Claude Code 側のファイルは書き換えない方針。

| 場所 | 形式 | 用途 |
| --- | --- | --- |
| `~/.claude/sessions/<pid>.json` | `{pid, sessionId, cwd, status:"busy"\|"idle", name, version, kind, startedAt, updatedAt}` | 起動中プロセス。`process.kill(pid,0)` で生存確認。busy→「エージェント稼働中」, idle→「あなたの入力待ち」 |
| `~/.claude/tasks/<sessionId>/<n>.json` | `{id, subject, description, activeForm, status:"pending"\|"in_progress"\|"completed", blocks:[], blockedBy:[], owner?, metadata?}` | TaskCreate/TaskUpdate のタスク。`.lock` ファイルは無視 |
| `~/.claude/todos/<sessionId>[-agent-<id>].json` | `[{content, status, activeForm, id?}]` | 旧 TodoWrite 形式 |
| `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` | 1行1JSON。`cwd`, `gitBranch`, `timestamp`, `type:"user"\|"assistant"\|"summary"`, `message.content`（文字列 or 配列: text / image / tool_use / tool_result） | プロジェクト名・cwd・ブランチ・最初の依頼文・最終更新。1行目が画像添付で数百KBになることがあるので先頭 2MB を読む |

- `<encoded-cwd>` は `/` と `:` を `-` に置換したもの（例 `-home-claude`, `C--Users-foo`）。`decodeProjectDir()` で復元しているが、パス中に元々 `-` があると崩れる。可能なら jsonl 内の `cwd` を優先（現状そうしている）。
- セッション状態の優先順位: sessions/ の生存プロセス → 直近 `--active-minutes` 分以内の更新なら最終行が tool_use/tool_result か否かで推定 → それ以外は idle。
- ユーザー最初のメッセージから `<system-reminder>…</system-reminder>` などのタグブロックは除去している。

## `/api/state` の返却形

```ts
{
  scannedAt, claudeDir, dirExists, activeMinutes,
  sessions: [{ id, cwd, project, branch, title, startedAt, lastAt, ageMin,
               state: "agent"|"you"|"idle", running, pid, name, version, lastText, size, taskCount }],
  tasks: [{ id: "<sessionId>:<taskId>", source: "tasks"|"todos"|"transcript", sessionId,
            subject, description, activeForm, status, owner, blocks, blockedBy, metadata,
            updatedAt, createdAt, blocked, blockerSubjects, session: {id, project, cwd, branch, state, title, lastAt} }],
  notes: { notes: { [taskId]: [{text, ts}] }, bookmarks: [taskId] }
}
```

## 画面（index.html）の構成

- トップバー: ボード／ブックマーク切替、検索(Ctrl K)、セッション絞り込み、完了の表示切替、テーマ切替、凡例、接続状態チップ
- 「セッション」帯: 稼働中を先頭に横スクロール。クリックで絞り込み
- レーン: 進行中 / ブロック中(blockedBy 未完了あり) / 待機中 / 完了
- 左パネル: 状態・担当・セッション・プロジェクト(cwd)・ブランチ・待ち先・更新時刻、タブ「付箋／説明／データ」
- 更新: SSE(`/api/events`) 5秒 tick + 15秒フォールバックポーリング。付箋入力中はパネルを再描画しない
- テーマ: CSS カスタムプロパティを `:root` / `prefers-color-scheme` / `[data-theme]` の3段で定義

## 現在の状態

- 実データ（このセッション自身の `~/.claude`）で起動確認済み。セッション帯に「エージェント稼働中」、タスク3件がレーンに出ることを確認。
- **Windows 実機確認済み（2026-09-20, Windows 11 / Claude Code 2.1.275 / Node 25）**: `~/.claude` 検出・`sessions/<pid>.json` の pid 生存判定（`process.kill(pid,0)`）・busy/idle → 稼働中/入力待ち の判定は正しく動いた。稼働 5 セッションを表示。
  - 当初 `tasks/` `todos/` が無くタスク 0 件だったが、原因は Claude 5 系モデルではタスクツールが既定で無効なこと。`~/.claude/settings.json` に `{"env":{"CLAUDE_CODE_ENABLE_TODO_TOOLS":"1"}}` を置いて有効化し、`tasks/<sessionId>/1.json` `2.json`（形式は上表どおり）が生成され、進行中 / ブロック中レーンに出ることを確認済み。
  - transcript(jsonl) で新たに確認した行種: `custom-title`(customTitle) / `agent-name` / `relocated`(relocatedCwd) / `last-prompt` / `attachment` / `queue-operation` / `file-history-snapshot` / `atis-latch` / `system`(subtype:stop_hook_summary)。`summary` 行はこのバージョンでは出ていない。
  - サイドカー: `projects/<enc>/<sessionId>/custom-title.json`、`projects/<enc>/<sessionId>.desktop-released.json`（`reason:"delete"` = デスクトップアプリで削除済み）。
- Windows 確認で直した点（server.mjs）:
  - `localhost` が `::1` に解決される環境で別アプリ（LM Studio 等が `0.0.0.0`/`[::]` を bind）に当たっていた → `127.0.0.1` と `::1` の両方に bind。片方が EADDRINUSE でも起動し、ログに注意を出す。`--host` で単一指定も可。
  - タイトル: 最初の依頼文が `<system-reminder>` で始まると弾かれ、後続の `</task-notification>` 等の残骸がタイトルになっていた → 制御タグを除去してから最初の非空ユーザー発話を採用。優先順は 稼働プロセスの name → custom-title → summary → 最初の依頼文。
  - cwd: `sessions/<pid>.json` の cwd は起動時のまま更新されないので、transcript の直近 `relocated`/`cwd` 行を優先（Desktop で「No folder」→フォルダ移動したセッションが scratch のままになっていた）。
  - ブランチ `HEAD`（git 管理外/detached）は空扱い。削除済みセッション（desktop-released reason=delete）は非表示。
  - `todos/*-agent-*.json` の owner: `projects/<enc>/<sessionId>/subagents/agent-<id>.jsonl` があれば `agent-name` 行 or 最初の依頼文で `サブエージェント …` と表示（**この環境には subagents ディレクトリが無く未検証**。無ければ従来通り `サブエージェント <id8>`）。
  - index.html: セッションカードの脚注は `pid` のみ表示（名前はタイトルに出るため重複回避）。
  - セッション詳細パネル: セッションカード／セレクトで選ぶと左に状態・cwd・ブランチ・pid・開始/最終更新・直近の発話・付箋（`sess:<id>` キー）を表示。閉じるボタンの svg サイズ未指定バグも修正。
  - 完了タスクの保持: `--done-days`（既定 7、0 で無制限）より古い完了は `/api/state` から省く。`~/.claude/tasks/` 自体は Claude Code の `cleanupPeriodDays`（既定 30 日）で pending も含めて削除される。`status: deleted` はファイル即削除。`tasks/<session>/` には `.lock` `.highwatermark` の隠しファイルがある（無視）。

## トークン消費セクション（2026-09-21）

- `/api/state.usage.tokens = { h5:[{t,fable,other,cached}×20], d7:[…×7], hits:[{t,type,resetsAt}], models:{model:tokens} }`
- transcript を **前回位置から差分読み**（`tokenCache`、追記前提・縮んだら全読み）。assistant 行は content ブロックごとに複数行に分かれ `message.usage` が重複するので `message.id` で重複排除。`model === "<synthetic>"` は制限ヒット等の擬似メッセージなので除外し、`quotaLimits.status === "rejected"` を「制限に当たった」印に使う
- 色: Fable `--c-fable` / その他 `--c-other`（light #3f6fe8/#d99a2b, dark #6a8ff2/#bd8a2c。dataviz の validate_palette.js で CVD 検証済み）
- **使用率 % のメーターは作って消した（経緯）**: ① セッション内 cron で `get_usage` → POST は 1 回あたりキャッシュ読取 ~1M トークンで本末転倒。② ターミナル claude の statusLine（`rate_limits`）はトークン消費ゼロだが、値は「そのセッションが最後に受けた API 応答」で止まり、他セッションの消費を反映しない（実測: ファイルは 60 秒ごとに書かれるが値は不変）。③ モデル別の週間枠（Fable）は statusLine に来ない。→ 古い数字は誤情報になるので、ユーザー判断で % 表示自体を廃止。`~/.claude` 外に % を書く経路も無い
- **起動元**: `sessions/<pid>.json` と transcript の `entrypoint`（`claude-desktop` / `claude-vscode` / `cli`）を `session.entrypoint` として返し、カードと詳細に「Desktop / VS Code / ターミナル」バッジを出す。VS Code 拡張・ターミナルも同じ `~/.claude` に書くので追加対応は不要。ただし VS Code は `name` をフォルダ名から自動生成（`nameSource:"derived"`、例 `riku1-29`）するので、`name` は `nameSource === "user"` のときだけタイトルに使う
- 画面の既定テーマはダーク（`localStorage` の `ccb:theme` があればそちら優先。右上のボタンで切替）
- **配色（2026-09-24 刷新）: オレンジ×ブラック。** 紫（`--l-agent:#8b5cf6` / `--tile-purple`）と青アクセントは廃止。トークンは `:root`（ライト＝温かいオフホワイト）と `[data-theme="dark"]` / `prefers-color-scheme:dark`（ほぼ黒 #0b0b0d）の 3 段。アクセント `--accent` は dark #ff7a18 / light #d2620d。状態色は エージェント稼働中・進行中＝オレンジ、あなたの入力待ち・待機中＝シアン `--l-you`、完了＝緑、ブロック＝赤 #ff4d61（オレンジと分離するため赤寄り）。タイル変数は意味のある名前に改名（`tile-blue→tile-run` / `tile-amber→tile-wait` / `tile-purple→tile-sess`、JS の `tileFor()` も対応）。グラフは Fable=オレンジ / その他=ティール（dark #e07316,#00a8ba / light #c2570b,#0089a8、dataviz の validate_palette.js で両モード ALL PASS）。接続チップの固定色は `color-mix()` でトークン化
- Windows 自動起動: タスクスケジューラ `ClaudeBoard`（ログオン時、`wscript start-hidden.vbs "<node.exe>"` → `node server.mjs --tailscale`）。`.vbs` は ANSI で読まれるため ASCII のみで書くこと
- **外出先から**: `--tailscale` で `os.networkInterfaces()` から 100.64.0.0/10 の IPv4 を検出して追加 bind（60 秒ごとに再検出）。`--host` はカンマ区切りで複数可。2026-09-22 に iPhone から http://ricktong:8787 で表示確認済み（Windows ファイアウォールの追加ルールは不要だった）。認証は Tailscale のログインに委ねている（ボード自体に認証は無い）ので、`--host 0.0.0.0` での公開は不可

## サービスと支出の台帳（2026-09-21）

- `board-spend.json = { entries:[{ id, ts, service, amount|null, currency, note, sessionId, status:"confirmed"|"unconfirmed", source:"user"|"agent"|"scan"|"manual" }] }`。`/api/state.spend` で返し、各 entry に `project` `sessionTitle` を付ける（sessionId から解決）
- `POST /api/spend`: 追加 / `{update:id,…}` / `{delete:id}`。amount null は「要確認」
- 記録ルールは `~/.claude/CLAUDE.md`（ユーザーのグローバル設定）に追記済み: 有料サービスの購入・チャージ・新規サービス利用（0 円含む）が起きたらセッション内で curl POST する。JSON は Windows の引数文字化け回避のためファイル経由。`sessionId` は `CLAUDE_CODE_SESSION_ID`
- 初期データは transcript 全走査で洗い出した（ユーザー申告 4 件 + 検出 5 件）。走査の要点: `message.content` のテキストだけを対象に「購入|チャージ|クレジット|api key|$d」等で grep。tool_result やシステムプロンプトは "aws" "stripe"（ハムスターの縞）等のノイズが多いので除外
- 画面: 「サービスと支出」セクション（折りたたみ可、`ccb:spend`）。フォーム入力中は refresh でボードを再描画しない
- **年月単位**（2026-09-21 ユーザー要望）: `spendMonth`（既定 今月 / `all`）で台帳 entry（`ts` の月）とメーター（`meters[].months`）を絞る。`recurring:"monthly"` の entry は `ledgerByMonth()` が ts の月から `until`（無ければ今月）まで各月に展開（明細では「継続」行、削除不可）。「月別推移」は全期間の月ごとの購入・従量・合計

## 従量メーター（2026-09-21）

- `board-meters.json = { meters:[{ service, file, pricePerMInput, pricePerMOutput, currency }] }`（gitignore）。`readMeters()` が各 `usage.jsonl` を差分読み（`meterCache`）して日別 `{requests,input,output,cost}` を集計、`/api/state.spend.meters[]` に `today / month / total / days(30)` で返す
- 行形式 `{ts, input_tokens, output_tokens, requests?}`。`requests` 省略時は 1 行 = 1 リクエスト。console のバックフィル行は `requests` 付き
- 記録側の例: `jev_test_action/jev.mjs` の `logUsage()`（API 応答の `usage` を `appendFile` で追記、失敗は握りつぶす）。9/21 分は console の `/api/usage?granularity=day` の値でバックフィル済み
- **console.typesafe.ai/api/usage は Cookie 認証のみ**（Bearer / x-api-key は 401）。公式に使用量 API は無い。画面の Spend は「入力トークン × $0.042/M」の見積なので、ローカル集計と一致する（実測: 9/21 $0.0419 で一致）
- 画面: 支出セクションに「従量課金（実測・見積）」表（今日／今月／累計＋日別ミニバー）。台帳の合計とは別枠（二重計上しない）

## 次にやると良いこと（優先順）

1. ~~**Windows 実機確認**~~ 済み（上記）。残: `todos/` `tasks/` があるマシンでのタスク表示確認
2. **サブエージェントの表示**: `agentLabel()` を実データ（`subagents/agent-*.jsonl`）で検証。パスや行形式が違えば修正
3. ~~**セッション履歴タブ**~~ 済み（2026-09-22）: `GET /api/session/<id>/messages?n=20` が transcript 末尾 4MB から user/assistant を抽出。同じ `message.id` の行を結合、tool_result だけの user 行は前の assistant に `results` として畳み、本文なしのツール呼び出しだけの assistant ターンは次のターンに結合（`tmap` → `tools: "Bash ×3, Read"`）。制御タグ除去は `cleanPrompt()`。画面は `chatLog()` が 10 秒キャッシュで遅延取得。残: TodoWrite 履歴の表示
4. **ウォッチャー化**: `fs.watch` で `tasks/` `sessions/` を監視し、SSE で即時プッシュ（現状は 5秒 tick）
5. **元イメージにあった機能**: 「エージェントに依頼」ボタン（Claude Code へ指示を送る手段があれば接続）、ファイル／HTML タブ
6. **パッケージ化**: `npx` で起動できるように `package.json` に `bin` を追加、`--open` でブラウザ自動起動

## 制約・注意

- 外部依存を増やさない方針（Node 標準モジュールのみ）
- `~/.claude` 配下は書き込まない。ユーザーデータは `board-notes.json` のみ
- `index.html` は単一ファイル維持（配布が楽）。外部リソースは Google Fonts のみ
