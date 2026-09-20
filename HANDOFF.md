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
  - この環境には `tasks/` `todos/` が無く、transcript にも TodoWrite/TaskCreate が無いためタスクは 0 件。タスクのパーサ自体は未変更（Linux 側で確認済みの形式のまま）。
  - transcript(jsonl) で新たに確認した行種: `custom-title`(customTitle) / `agent-name` / `relocated`(relocatedCwd) / `last-prompt` / `attachment` / `queue-operation` / `file-history-snapshot` / `atis-latch` / `system`(subtype:stop_hook_summary)。`summary` 行はこのバージョンでは出ていない。
  - サイドカー: `projects/<enc>/<sessionId>/custom-title.json`、`projects/<enc>/<sessionId>.desktop-released.json`（`reason:"delete"` = デスクトップアプリで削除済み）。
- Windows 確認で直した点（server.mjs）:
  - `localhost` が `::1` に解決される環境で別アプリ（LM Studio 等が `0.0.0.0`/`[::]` を bind）に当たっていた → `127.0.0.1` と `::1` の両方に bind。片方が EADDRINUSE でも起動し、ログに注意を出す。`--host` で単一指定も可。
  - タイトル: 最初の依頼文が `<system-reminder>` で始まると弾かれ、後続の `</task-notification>` 等の残骸がタイトルになっていた → 制御タグを除去してから最初の非空ユーザー発話を採用。優先順は 稼働プロセスの name → custom-title → summary → 最初の依頼文。
  - cwd: `sessions/<pid>.json` の cwd は起動時のまま更新されないので、transcript の直近 `relocated`/`cwd` 行を優先（Desktop で「No folder」→フォルダ移動したセッションが scratch のままになっていた）。
  - ブランチ `HEAD`（git 管理外/detached）は空扱い。削除済みセッション（desktop-released reason=delete）は非表示。
  - `todos/*-agent-*.json` の owner: `projects/<enc>/<sessionId>/subagents/agent-<id>.jsonl` があれば `agent-name` 行 or 最初の依頼文で `サブエージェント …` と表示（**この環境には subagents ディレクトリが無く未検証**。無ければ従来通り `サブエージェント <id8>`）。
  - index.html: セッションカードの脚注は `pid` のみ表示（名前はタイトルに出るため重複回避）。

## 次にやると良いこと（優先順）

1. ~~**Windows 実機確認**~~ 済み（上記）。残: `todos/` `tasks/` があるマシンでのタスク表示確認
2. **サブエージェントの表示**: `agentLabel()` を実データ（`subagents/agent-*.jsonl`）で検証。パスや行形式が違えば修正
3. **セッション履歴タブ**: 詳細パネルにセッションの直近メッセージ（`lastText`）や TodoWrite 履歴を表示
4. **ウォッチャー化**: `fs.watch` で `tasks/` `sessions/` を監視し、SSE で即時プッシュ（現状は 5秒 tick）
5. **元イメージにあった機能**: 「エージェントに依頼」ボタン（Claude Code へ指示を送る手段があれば接続）、ファイル／HTML タブ
6. **パッケージ化**: `npx` で起動できるように `package.json` に `bin` を追加、`--open` でブラウザ自動起動

## 制約・注意

- 外部依存を増やさない方針（Node 標準モジュールのみ）
- `~/.claude` 配下は書き込まない。ユーザーデータは `board-notes.json` のみ
- `index.html` は単一ファイル維持（配布が楽）。外部リソースは Google Fonts のみ
