-- TOPIX銘柄マスター
CREATE TABLE IF NOT EXISTS topix_stocks (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT NOT NULL,
  weight REAL NOT NULL,                 -- 個別銘柄のウエイト (例: 0.030673)
  new_index_group TEXT NOT NULL,        -- ニューインデックス区分 (例: "TOPIX Core30")
  is_active INTEGER NOT NULL DEFAULT 1, -- 1: 有効, 0: 除外
  last_updated TEXT NOT NULL            -- マスタの最終更新日 (YYYY-MM-DD)
);

-- TOPIX日次株価データ
CREATE TABLE IF NOT EXISTS topix_prices (
  code TEXT,
  date TEXT,
  close_price REAL NOT NULL,
  volume INTEGER NOT NULL,
  PRIMARY KEY (code, date)
);

CREATE INDEX IF NOT EXISTS idx_topix_prices_date ON topix_prices(date);

-- TOPIX日次集計データ (マクレランオシレーター等の計算用)
CREATE TABLE IF NOT EXISTS topix_metrics (
  date TEXT PRIMARY KEY,
  topix_close REAL,          -- TOPIX指数の終値
  advances INTEGER NOT NULL, -- 値上がり銘柄数
  declines INTEGER NOT NULL, -- 値下がり銘柄数
  unchanged INTEGER NOT NULL, -- 変わらず銘柄数
  new_highs INTEGER NOT NULL, -- 52週新高値数
  new_lows INTEGER NOT NULL,  -- 52週新安値数
  total_volume INTEGER NOT NULL -- 全構成銘柄の総出来高
);
