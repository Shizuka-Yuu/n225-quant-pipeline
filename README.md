# 日経225株価・出来高データ収集・蓄積パイプライン (n225-quant-pipeline)

本ディレクトリは、日経225構成銘柄の終値および出来高を自動収集し、Cloudflare D1（SQLite）への蓄積およびGoogleスプレッドシート（GAS）への日次集計データの配信を行う独立したパイプラインのコード群です。

## ディレクトリ構成

```
n225-quant-pipeline/
├── README.md             # 本ファイル
├── python/               # GitHub Actions (Python) 関連
│   ├── requirements.txt  # 依存パッケージ
│   └── main.py           # スクレイピング & API 取得 & Workers 送信
├── workers/              # Cloudflare Workers API 関連
│   ├── src/
│   │   └── index.ts      # API エンドポイント & 集計ロジック
│   ├── schema.sql        # D1 データベーススキーマ
│   ├── wrangler.json     # Workers 設定ファイル
│   └── package.json      # npm 依存パッケージ
└── gas/                  # Google Apps Script 関連
    └── code.js           # スプレッドシート展開スクリプト (EMA動的計算)
```

## 全体フロー

1. **データ収集 (GitHub Actions / Python)**:
   - 毎日日本時間 16:30 に起動。
   - 日経サイトから現在の構成銘柄（225件）をスクレイピング。
   - Workers API に問い合わせ、既存の銘柄コード一覧を取得。
   - 既存銘柄 + 日経平均株価 (`^N225`) は直近5日分（`range=5d`）、新規銘柄は52週分（`range=1y`）の株価・出来高データを Yahoo Finance API から取得。
   - クレンジング後、Workers API へ送信。

2. **データ蓄積 & 集計 (Cloudflare Workers & D1)**:
   - 受け取ったデータを D1（`daily_prices` / `stocks`）に `INSERT OR REPLACE` で保存。
   - 送信後に集計 API を実行し、各銘柄の前取引日比（値上がり/値下がり）および52週新高値・新安値を営業日インデックス基準で判定・集計し、日次集計テーブル（`daily_metrics`）に保存。

3. **スプレッドシート展開 (Google Apps Script)**:
   - スプレッドシート側から Workers の API を呼び出して `daily_metrics`（日次集計データ）をフェッチ。
   - スプレッドシート側の短期・長期設定（例：19日、39日）を元に、GAS側でマクレラン・オシレーター（EMA）を動的計算。
   - スプレッドシートの `raw_data` シートの既存最新日付を確認し、重複を排除しながら新規日付分のデータを末尾に追記。
