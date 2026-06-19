CREATE TABLE IF NOT EXISTS stocks (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  industry TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_prices (
  code TEXT,
  date TEXT,
  close_price REAL NOT NULL,
  volume INTEGER NOT NULL,
  PRIMARY KEY (code, date)
);

CREATE INDEX IF NOT EXISTS idx_prices_date ON daily_prices(date);

CREATE TABLE IF NOT EXISTS daily_metrics (
  date TEXT PRIMARY KEY,
  nk225_close REAL,
  advances INTEGER NOT NULL,
  declines INTEGER NOT NULL,
  new_highs INTEGER NOT NULL,
  new_lows INTEGER NOT NULL
);
