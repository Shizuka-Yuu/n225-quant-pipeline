import os
import sys
import time
import datetime
import re
import csv
import requests
from bs4 import BeautifulSoup
from yahooquery import Ticker

# 設定
JPX_TOPIX_URL = "https://www.jpx.co.jp/english/markets/indices/topix/index.html"
JPX_CSV_URL = "https://www.jpx.co.jp/automation/english/markets/indices/topix/files/topixweight_e.csv"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# 環境変数の読み込み (TOPIX専用Workersのエンドポイントを設定)
WORKERS_API_URL = os.environ.get("TOPIX_WORKERS_API_URL")
WORKERS_API_TOKEN = os.environ.get("TOPIX_WORKERS_API_TOKEN")

# ロギング設定 (UTF-8強制)
if sys.platform.startswith('win'):
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# Yahoo Finance アクセス用のグローバルセッション
yahoo_session = requests.Session()

def get_headers(auth=False):
    headers = {"User-Agent": USER_AGENT}
    if auth and WORKERS_API_TOKEN:
        headers["Authorization"] = f"Bearer {WORKERS_API_TOKEN}"
    return headers

def init_yahoo_session():
    """Yahoo Finance のクッキーセッションを初期化する"""
    print("Yahoo Finance セッションの初期化を開始します (Cookie取得)...")
    try:
        # fc.yahoo.com へのアクセスによりセッション内にクッキー (B等) が設定される
        res = yahoo_session.get("https://fc.yahoo.com", headers={"User-Agent": USER_AGENT}, timeout=10)
        print(f"取得したCookie: {yahoo_session.cookies.get_dict()}")
        return True
    except Exception as e:
        print(f"Yahoo Finance セッションの初期化に失敗しました (Cookie取得エラー): {e}")
        return False

def scrape_jpx_update_date():
    """JPXのTOPIXページから更新日を取得する"""
    print("JPX公式サイトからTOPIXマスタの更新日を取得中...")
    try:
        res = requests.get(JPX_TOPIX_URL, headers=get_headers())
        res.raise_for_status()
        html = res.text
    except Exception as e:
        print(f"JPXページの取得に失敗しました: {e}")
        return None

    # 英語版ページの 'Last Update: June 3, 2026' または日本語版 '更新日：2026年6月3日' を探す
    months_map = {
        'january': '01', 'february': '02', 'march': '03', 'april': '04', 'may': '05', 'june': '06',
        'july': '07', 'august': '08', 'september': '09', 'october': '10', 'november': '11', 'december': '12',
        'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04', 'jun': '06', 'jul': '07', 'aug': '08', 'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12'
    }

    # 日本語の更新日パターン
    jp_match = re.search(r"更新日[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日", html)
    if jp_match:
        return f"{jp_match.group(1)}-{int(jp_match.group(2)):02d}-{int(jp_match.group(3)):02d}"

    # 英語の Last Update パターン
    en_match = re.search(r"Last Update\s*:\s*([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})", html, re.IGNORECASE)
    if en_match:
        month_name = en_match.group(1).lower()
        month = months_map.get(month_name, '01')
        day = int(en_match.group(2))
        year = en_match.group(3)
        return f"{year}-{month}-{day:02d}"

    # 代替のY-M-Dパターン
    alt_match = re.search(r"(\d{4})[-/](\d{2})[-/](\d{2})", html)
    if alt_match:
        return f"{alt_match.group(1)}-{alt_match.group(2)}-{alt_match.group(3)}"

    print("警告: JPXページから更新日を抽出できませんでした。本日日付を基準とします。")
    return datetime.date.today().strftime("%Y-%m-%d")

def download_and_parse_topix_master():
    """JPXからTOPIXの構成ウエイトCSVをダウンロードして解析する"""
    print(f"JPXからTOPIX構成銘柄マスタCSVをダウンロード中: {JPX_CSV_URL}")
    try:
        res = requests.get(JPX_CSV_URL, headers=get_headers())
        res.raise_for_status()
        csv_bytes = res.content
    except Exception as e:
        print(f"TOPIXマスタCSVのダウンロードに失敗しました: {e}")
        # ローカルのサンプルファイルへのフォールバックを試みる
        fallback_path = os.path.join("private", "topixweight_j.csv")
        if os.path.exists(fallback_path):
            print(f"ローカルのサンプルファイル {fallback_path} から読み込みます。")
            with open(fallback_path, "rb") as f:
                csv_bytes = f.read()
        else:
            print("エラー: フォールバックするサンプルファイルも見つかりません。")
            sys.exit(1)

    # 文字コードの自動判定デコード
    csv_text = None
    for encoding in ["utf-8", "cp932", "shift_jis", "latin-1"]:
        try:
            csv_text = csv_bytes.decode(encoding)
            break
        except UnicodeDecodeError:
            continue

    if not csv_text:
        print("エラー: CSVのデコードに失敗しました。")
        sys.exit(1)

    # CSVパース処理
    reader = csv.reader(csv_text.strip().splitlines())
    stocks = []
    csv_date = None

    # 東証33業種 (日本語) の判定用
    industries_jp = {"水産・農林業", "鉱業", "建設業", "食料品", "繊維製品", "パルプ・紙", "化学", "医薬品", "石油・石炭製品", "ゴム製品", "ガラス・土石製品", "鉄鋼", "非鉄金属", "金属製品", "機械", "電気機器", "輸送用機器", "精密機器", "その他製品", "電気・ガス業", "陸運業", "海運業", "空運業", "倉庫・運輸関連業", "情報・通信業", "卸売業", "小売業", "銀行業", "証券、商品先物取引業", "保険業", "その他金融業", "不動産業", "サービス業"}

    for row in reader:
        if not row or len(row) < 5:
            continue

        # 各要素から特性をベースに列の役割を自動判別
        code_idx = -1
        date_idx = -1
        weight_idx = -1

        for idx, val in enumerate(row):
            val_clean = val.strip()
            if re.match(r"^\d{4}$", val_clean):
                code_idx = idx
            elif re.match(r"^\d{8}$", val_clean):
                date_idx = idx
            elif "%" in val_clean or re.match(r"^\d+\.\d+%$", val_clean):
                weight_idx = idx

        # 4桁の銘柄コードが見つからない行はヘッダーや説明行としてスキップ
        if code_idx == -1:
            continue

        code = row[code_idx].strip()

        # 日付の抽出 (YYYYMMDD ➔ YYYY-MM-DD)
        if date_idx != -1:
            raw_date = row[date_idx].strip()
            csv_date = f"{raw_date[0:4]}-{raw_date[4:6]}-{raw_date[6:8]}"

        # ウエイトの抽出 (例: 3.0673% ➔ 0.030673)
        weight = 0.0
        if weight_idx != -1:
            try:
                weight = float(row[weight_idx].replace("%", "").strip()) / 100.0
            except ValueError:
                pass

        # 残りの列を分類 (銘柄名、業種、ニューインデックス区分)
        name = ""
        industry = ""
        category = ""

        remaining_indices = [i for i in range(len(row)) if i not in {code_idx, date_idx, weight_idx}]
        for idx in remaining_indices:
            val_clean = row[idx].strip()
            # ニューインデックス区分判定
            if any(k in val_clean for k in ["TOPIX", "Core", "Large", "Mid", "Small"]):
                category = val_clean
            # 業種判定
            elif val_clean in industries_jp or (len(val_clean) < 15 and industry == ""):
                industry = val_clean
            else:
                name = val_clean

        # 判定が漏れた場合のデフォルト割り当て
        unused = [row[idx].strip() for idx in remaining_indices if row[idx].strip() not in {name, industry, category}]
        if not name and unused:
            name = unused.pop(0)
        if not industry and unused:
            industry = unused.pop(0)
        if not category and unused:
            category = unused.pop(0)

        stocks.append({
            "code": code,
            "name": name,
            "industry": industry,
            "weight": weight,
            "new_index_group": category
        })

    print(f"CSVから合計 {len(stocks)} 銘柄をパースしました。 (CSV内基準日: {csv_date})")
    return stocks, csv_date

def get_existing_active_codes():
    """Workersから現在DBにアクティブとして登録されている銘柄一覧を取得する"""
    if not WORKERS_API_URL:
        print("WORKERS_API_URL が設定されていないため、既存銘柄チェックをスキップします。")
        return set()

    url = f"{WORKERS_API_URL.rstrip('/')}/api/topix/stocks"
    print(f"Workers から登録済みのアクティブ銘柄一覧を取得中: {url}")
    try:
        res = requests.get(url, headers=get_headers(auth=True))
        res.raise_for_status()
        codes = res.json()
        print(f"DB内の登録済み銘柄数: {len(codes)}")
        return set(codes)
    except Exception as e:
        print(f"既存銘柄一覧の取得に失敗しました (初回起動として処理します): {e}")
        return set()

def fetch_yahoo_quotes_batch(codes):
    """複数銘柄の当日データを yahooquery を用いて一括取得する"""
    symbols = [f"{code}.T" if not code.startswith("^") else code for code in codes]
    
    try:
        # Tickerインスタンス生成 (内部で自動でクッキー・Crumbをハンドリングする)
        t = Ticker(symbols)
        price_data = t.price
        
        records = []
        for symbol, quote in price_data.items():
            if not isinstance(quote, dict):
                continue
                
            code = symbol.replace('.T', '')
            
            close_price = quote.get('regularMarketPrice')
            volume = quote.get('regularMarketVolume', 0)
            market_time_str = quote.get('regularMarketTime') # 例: '2026-06-19 15:30:00'
            
            if close_price is None or not market_time_str:
                continue
                
            # 日付文字列 (YYYY-MM-DD) の抽出
            dt = market_time_str.split(' ')[0]
            
            records.append({
                "code": code,
                "date": dt,
                "close_price": float(close_price),
                "volume": int(volume)
            })
        return records
    except Exception as e:
        print(f"yahooquery 一括取得エラー: {e}")
        return []

def fetch_yahoo_chart_individual(code, range_str):
    """単一銘柄の過去履歴データを v8/finance/chart を用いて個別取得する"""
    symbol = code if code.startswith("^") else f"{code}.T"
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range={range_str}&interval=1d"
    
    try:
        # クッキー付きのグローバルセッションを使用
        res = yahoo_session.get(url, headers=get_headers())
        res.raise_for_status()
        data = res.json()
        
        result = data.get('chart', {}).get('result', [])
        if not result:
            return []
            
        res_data = result[0]
        timestamps = res_data.get('timestamp', [])
        indicators = res_data.get('indicators', {})
        quote = indicators.get('quote', [{}])[0]
        
        close_prices = quote.get('close', [])
        volumes = quote.get('volume', [])
        adjclose = indicators.get('adjclose', [{}])[0].get('adjclose', [])
        
        records = []
        for i in range(len(timestamps)):
            ts = timestamps[i]
            dt = datetime.datetime.fromtimestamp(ts, datetime.timezone(datetime.timedelta(hours=9))).strftime('%Y-%m-%d')
            
            close_price = None
            if i < len(adjclose) and adjclose[i] is not None:
                close_price = adjclose[i]
            elif i < len(close_prices) and close_prices[i] is not None:
                close_price = close_prices[i]
                
            volume = volumes[i] if i < len(volumes) else 0
            if volume is None:
                volume = 0
                
            if close_price is None:
                continue
                
            records.append({
                "code": code,
                "date": dt,
                "close_price": float(close_price),
                "volume": int(volume)
            })
        return records
    except Exception as e:
        print(f"Yahoo Finance Chart API 個別取得エラー ({symbol}): {e}")
        return []

def fetch_nikkei_topix_close():
    """日経新聞マーケットデータから本物のTOPIX現在値（終値）をスクレイピングする"""
    print("日経新聞マーケットデータから本物のTOPIX終値を取得中...")
    url = "https://www.nikkei.com/marketdata/quote/TOPX/"
    try:
        res = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=10)
        res.raise_for_status()
        soup = BeautifulSoup(res.text, 'html.parser')
        
        # 'IndicatorSummary_value' を含むクラスを持つ span を曖昧検索
        span = soup.find(class_=lambda x: x and 'IndicatorSummary_value' in x)
        if span:
            val_str = span.text.replace(',', '').strip()
            close_val = float(val_str)
            print(f"日経から本物のTOPIX終値を取得しました: {close_val}")
            return close_val
        else:
            print("警告: 日経ページからTOPIX現在値の要素が見つかりませんでした。")
            return None
    except Exception as e:
        print(f"日経からのTOPIX現在値取得に失敗しました: {e}")
        return None

def send_to_workers(endpoint, data):
    """Workers APIへデータをPOST送信する"""
    if not WORKERS_API_URL:
        print(f"WORKERS_API_URL 未設定のため送信をスキップします。データ件数: {len(data)}")
        return True
        
    url = f"{WORKERS_API_URL.rstrip('/')}{endpoint}"
    print(f"Workers へ送信中 ({endpoint})... 件数: {len(data)}")
    
    try:
        res = requests.post(url, json=data, headers=get_headers(auth=True))
        res.raise_for_status()
        print(f"送信成功: {res.text}")
        return True
    except Exception as e:
        print(f"Workers への送信に失敗しました ({endpoint}): {e}")
        if 'res' in locals() and res is not None:
            print(f"レスポンス: {res.text}")
        return False

def calculate_metrics(prices):
    """取得した株価データから、ローカルで値上がり・値下がり、新高値・新安値、総出来高を計算する"""
    print("時系列データから TOPIX メトリクスの計算を開始します...")
    from collections import defaultdict
    
    # 1. 銘柄ごとの株価リスト
    stock_data = defaultdict(list)
    for p in prices:
        stock_data[p["code"]].append(p)
        
    # 日付でソート
    for code in stock_data:
        stock_data[code].sort(key=lambda x: x["date"])
        
    # 2. TOPIX指数の日程リスト
    if "^TPX" not in stock_data:
        print("警告: 指数データ (^TPX) が見つかりません。")
        return []
        
    topix_prices = stock_data["^TPX"]
    topix_dates = [p["date"] for p in topix_prices]
    topix_close_map = {p["date"]: p["close_price"] for p in topix_prices}
    
    # 各銘柄の日付インデックスとデータのマップを作成 (高速化用)
    stock_date_map = {}
    for code, p_list in stock_data.items():
        stock_date_map[code] = {
            p["date"]: (idx, p["close_price"], p["volume"]) 
            for idx, p in enumerate(p_list)
        }
        
    metrics_list = []
    
    for d_idx, target_date in enumerate(topix_dates):
        advances = 0
        declines = 0
        unchanged = 0
        new_highs = 0
        new_lows = 0
        total_volume = 0
        
        # 52週 (365日) 前の日付文字列
        target_dt = datetime.datetime.strptime(target_date, "%Y-%m-%d")
        past_365_dt = target_dt - datetime.timedelta(days=365)
        past_365_str = past_365_dt.strftime("%Y-%m-%d")
        
        for code, date_map in stock_date_map.items():
            if code == "^TPX":
                continue
                
            if target_date not in date_map:
                continue
                
            idx, current_price, volume = date_map[target_date]
            total_volume += volume
            
            # 前日比
            p_list = stock_data[code]
            if idx > 0:
                prev_price = p_list[idx - 1]["close_price"]
                if current_price > prev_price:
                    advances += 1
                elif current_price < prev_price:
                    declines += 1
                else:
                    unchanged += 1
                    
            # 52週新高値・新安値
            past_prices = []
            lookback_idx = idx - 1
            while lookback_idx >= 0:
                p_prev = p_list[lookback_idx]
                if p_prev["date"] < past_365_str:
                    break
                if p_prev["close_price"] is not None:
                    past_prices.append(p_prev["close_price"])
                lookback_idx -= 1
                
            if past_prices:
                max_price = max(past_prices)
                min_price = min(past_prices)
                if current_price >= max_price:
                    new_highs += 1
                if current_price <= min_price:
                    new_lows += 1
                    
        metrics_list.append({
            "date": target_date,
            "topix_close": topix_close_map.get(target_date),
            "advances": advances,
            "declines": declines,
            "unchanged": unchanged,
            "new_highs": new_highs,
            "new_lows": new_lows,
            "total_volume": total_volume
        })
        
    print(f"メトリクス計算完了。計算日数: {len(metrics_list)}")
    return metrics_list

def main():
    print("=== TOPIX データ収集パイプライン開始 ===")
    
    # 0. Yahoo Finance セッションの初期化 (Cookie確保)
    init_yahoo_session()
    
    # 1. JPXからマスタ日付および構成銘柄マスタの取得
    web_update_date = scrape_jpx_update_date()
    stocks, csv_date = download_and_parse_topix_master()
    master_date = csv_date if csv_date else web_update_date
    
    # 各銘柄マスタレコードに日付を追加
    for s in stocks:
        s["last_updated"] = master_date
        
    # 2. Workersから既存の登録済みアクティブ銘柄を取得
    existing_codes = get_existing_active_codes()
    
    # テスト制限用の環境変数がある場合、取得数を切り詰める
    max_stocks_env = os.environ.get("TOPIX_MAX_STOCKS")
    if max_stocks_env:
        try:
            limit = int(max_stocks_env)
            print(f"[TEST MODE] TOPIX_MAX_STOCKS={limit} が検出されました。処理対象銘柄を制限します。")
            stocks = stocks[:limit]
        except ValueError:
            pass
            
    # 新規銘柄・既存銘柄の選別 (TOPIX指数の代理として 1306 も判定対象に含める)
    # ※ 既存判定はD1に ^TPX があるかどうかで行う
    target_codes = [s["code"] for s in stocks]
    target_codes.append("1306")
    
    new_stocks = []
    existing_stocks = []
    
    for code in target_codes:
        check_code = "^TPX" if code == "1306" else code
        if check_code in existing_codes:
            existing_stocks.append(code)
        else:
            new_stocks.append(code)
            
    print(f"銘柄判別結果: 既存アクティブ={len(existing_stocks)}件, 新規/過去データなし={len(new_stocks)}件")
    
    prices = []
    
    # 3. データの取得 (ハイブリッドアプローチ)
    
    # A) 新規銘柄: 過去1年 (1y) の履歴データを個別に取得 (1306もここに入れば 1306.T として1yが取得される)
    if new_stocks:
        print(f"新規銘柄 ({len(new_stocks)} 件) の過去1年分の履歴データを個別取得します...")
        for idx, code in enumerate(new_stocks):
            print(f"[{idx+1}/{len(new_stocks)}] Code: {code} (新規/過去なし ➔ range=1y) ... ", end="", flush=True)
            records = fetch_yahoo_chart_individual(code, "1y")
            if records:
                prices.extend(records)
                print(f"成功 ({len(records)} 件)")
            else:
                print("失敗 (またはデータなし)")
            time.sleep(1.5) # レートリミット回避
            
    # B) 既存銘柄: 最新日の当日の値を一括取得 (200件ずつのバッチ)
    # ※ 初回実行時は既存銘柄リストが空のため、この処理は実質スキップされます。
    targets_quote = list(existing_stocks)
    
    if targets_quote:
        print(f"既存銘柄および指数 ({len(targets_quote)} 件) の当日データを一括(バッチ)取得します...")
        chunk_size = 200
        for i in range(0, len(targets_quote), chunk_size):
            chunk = targets_quote[i:i + chunk_size]
            print(f"バッチ取得中 ({i+1} 〜 {min(i + chunk_size, len(targets_quote))} / {len(targets_quote)} 件) ... ", end="", flush=True)
            records = fetch_yahoo_quotes_batch(chunk)
            if records:
                prices.extend(records)
                print(f"成功 ({len(records)} 件)")
            else:
                print("失敗")
            time.sleep(1.5) # レートリミット回避
            
    print(f"時系列データの取得完了。総レコード数: {len(prices)}")
    
    if not prices:
        print("エラー: 取得できた株価データが 0 件です。処理を中断します。")
        sys.exit(1)
        
    # 4. 動的ETFスケーリング & シンボル変換 (1306 ➔ ^TPX)
    etf_records = [p for p in prices if p["code"] == "1306"]
    if etf_records:
        # 1306.T は2026年4月1日に1:10の株式分割を行いました。
        # Yahoo Financeの過去データが未調整（3000円台）のままになっているため、
        # 権利落ち日（2026-03-30）より前の価格を10分の1に遡及調整します。
        for p in prices:
            if p["code"] == "1306" and p["date"] < "2026-03-30":
                p["close_price"] = round(p["close_price"] / 10.0, 4)
                
        # 調整後の最新データから比率を計算
        etf_records_updated = [p for p in prices if p["code"] == "1306"]
        
        # 当日の本物のTOPIX現在値を日経からスクレイピング
        topix_real_close = fetch_nikkei_topix_close()
        
        # 1306の最新終値を取得して比率を算出
        etf_records_sorted = sorted(etf_records_updated, key=lambda x: x["date"])
        etf_latest_close = etf_records_sorted[-1]["close_price"]
        
        default_ratio = 9.41347  # TOPIX4044 / ETF429.7 ≒ 9.413
        if topix_real_close and etf_latest_close > 0:
            ratio = topix_real_close / etf_latest_close
            print(f"動的スケーリング比率を算出しました: {ratio:.6f} (TOPIX:{topix_real_close} / ETF:{etf_latest_close})")
        else:
            ratio = default_ratio
            print(f"警告: 比率を自動算出できなかったため、デフォルト値 {ratio} を使用します。")
            
        # 1306 のデータを比率でスケーリングし、コードを ^TPX に書き換える
        for p in prices:
            if p["code"] == "1306":
                p["close_price"] = round(p["close_price"] * ratio, 2)
                p["code"] = "^TPX"
                
        print(f"1306 のデータ {len(etf_records)} 件を ^TPX に変換・スケーリングしました。")
        
    # 5. Workers への送信
    # 5.1. 銘柄マスターの送信
    send_to_workers("/api/topix/stocks", stocks)
    
    # 5.2. 株価データのチャンク送信 (最大1500件ずつ分割)
    chunk_send_size = 1500
    total_prices = len(prices)
    for i in range(0, total_prices, chunk_send_size):
        chunk = prices[i:i + chunk_send_size]
        print(f"株価データを送信中 ({i + 1} 〜 {min(i + chunk_send_size, total_prices)} / {total_prices} 件)")
        success = send_to_workers("/api/topix/prices", chunk)
        if not success:
            print("警告: チャンク送信中にエラーが発生しました。")
            
    # 6. 指標計算の実行と送信
    metrics_list = calculate_metrics(prices)
    if metrics_list:
        send_to_workers("/api/topix/metrics", metrics_list)
    
    print("=== TOPIX データ収集パイプライン終了 ===")

if __name__ == "__main__":
    main()
