# TOPIX Quant Pipeline

本ディレクトリは、TOPIX構成銘柄（約2,000銘柄）の終値および出来高を自動収集し、Cloudflare D1（SQLite）への蓄積およびGoogleスプレッドシート（GAS）への日次集計データの配信を行う独立したデータパイプラインのコード群です。

## ディレクトリ構成

```
topix-quant-pipeline/
├── README.md             # 本ファイル
├── python/               # GitHub Actions (Python) 関連
│   ├── requirements.txt  # 依存パッケージ
│   └── main.py           # JPXマスタ取得 & Yahoo Finance API 取得 & Workers 送信
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
   - JPX公式サイトからTOPIXの最新構成銘柄マスタ（CSV）を取得・比較。
   - Workers API に問い合わせ、既存の登録済み銘柄コード一覧を取得。
   - 既存銘柄 + TOPIX指数 (`^TOPIX`) は Yahoo Finance の一括 quote API (`v7/finance/quote`) で当日分のみを高速取得。
   - 新規銘柄は個別で52週分（`range=1y`）の株価・出来高データを取得。
   - クレンジング後、Workers API へ送信。

2. **データ蓄積 & 集計 (Cloudflare Workers & D1)**:
   - 受け取ったデータを D1（`topix_prices` / `topix_stocks`）に `INSERT OR REPLACE` で保存。
   - 不要になった銘柄（最新マスタに含まれない銘柄）は、`topix_stocks` 上で `is_active = 0`（論理削除）としてフラグを更新。
   - 送信後に集計 API を実行し、前取引日比（値上がり/値下がり/変わらず）、52週新高値・新安値、および全体の合計出来高を集計し、日次集計テーブル（`topix_metrics`）に保存。

3. **スプレッドシート展開 (Google Apps Script)**:
   - スプレッドシート側から Workers の API を呼び出して `topix_metrics`（日次集計データ）をフェッチ。
   - スプレッドシート側の短期・長期間設定を元に、GAS側でマクレラン・オシレーター（EMA）を動的計算。
   - 指定シート（例：`topix_raw_data`）に、重複を排除しながら新規日付分のデータを末尾に追記。
