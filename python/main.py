import os
import sys
import time
import datetime
import re
import requests
from bs4 import BeautifulSoup

# 設定
NIKKEI_URL = "https://indexes.nikkei.co.jp/nkave/index/component?idx=nk225"
YAHOO_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart/"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# 環境変数の読み込み
WORKERS_API_URL = os.environ.get("WORKERS_API_URL")
WORKERS_API_TOKEN = os.environ.get("WORKERS_API_TOKEN")

# ロギング設定 (UTF-8強制)
if sys.platform.startswith('win'):
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

def get_headers(auth=False):
    headers = {"User-Agent": USER_AGENT}
    if auth and WORKERS_API_TOKEN:
        headers["Authorization"] = f"Bearer {WORKERS_API_TOKEN}"
    return headers

def scrape_nikkei_components():
    print("日経225構成銘柄のスクレイピングを開始します...")
    try:
        response = requests.get(NIKKEI_URL, headers=get_headers())
        response.raise_for_status()
        html_str = response.text
    except Exception as e:
        print(f"日経サイトの取得に失敗しました: {e}")
        sys.exit(1)

    soup = BeautifulSoup(html_str, "html.parser")
    
    # 更新日付の抽出
    date_match = re.search(r"更新日付：(\d{4})\.(\d{2})\.(\d{2})", html_str)
    if date_match:
        extracted_date = f"{date_match.group(1)}-{date_match.group(2)}-{date_match.group(3)}"
    else:
        # 代替パターン
        date_match_alt = re.search(r"(\d{4})/(\d{2})/(\d{2})", html_str)
        if date_match_alt:
            extracted_date = f"{date_match_alt.group(1)}-{date_match_alt.group(2)}-{date_match_alt.group(3)}"
        else:
            extracted_date = datetime.date.today().strftime("%Y-%m-%d")
    
    print(f"銘柄マスタの基準日: {extracted_date}")

    stocks = []
    sectors = soup.find_all('h3', class_='idx-section-subheading')
    for sector in sectors:
        industry = sector.get_text(strip=True)
        table = sector.find_next('table')
        if table:
            rows = table.find_all('tr')
            for row in rows[1:]: # ヘッダーをスキップ
                cols = row.find_all(['td', 'th'])
                if len(cols) >= 3:
                    code = cols[0].get_text(strip=True)
                    short_name = cols[1].get_text(strip=True)
                    full_name = cols[2].get_text(strip=True)
                    stocks.append({
                        "code": code,
                        "name": short_name,
                        "full_name": full_name,
                        "industry": industry
                    })
    
    print(f"合計 {len(stocks)} 銘柄を取得しました。")
    return stocks, extracted_date

def get_existing_codes():
    if not WORKERS_API_URL:
        print("WORKERS_API_URL が設定されていないため、既存銘柄チェックをスキップします（すべて新規として処理します）。")
        return set()
    
    url = f"{WORKERS_API_URL.rstrip('/')}/api/stocks"
    print(f"Workers から既存銘柄一覧を取得中: {url}")
    try:
        res = requests.get(url, headers=get_headers(auth=True))
        res.raise_for_status()
        codes = res.json()
        print(f"DB内に登録済みの銘柄数: {len(codes)}")
        return set(codes)
    except Exception as e:
        print(f"既存銘柄一覧の取得に失敗しました (新規取得として処理します): {e}")
        return set()

def fetch_yahoo_finance(code, range_str):
    # インデックス(^N225)は.Tを付加しない
    if code.startswith("^"):
        symbol = code
    else:
        symbol = f"{code}.T"
        
    url = f"{YAHOO_BASE_URL}{symbol}?range={range_str}&interval=1d"
    
    try:
        res = requests.get(url, headers=get_headers())
        # APIが404などを返した場合は例外
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
        
        # adjclose (調整後終値) を優先
        adjclose = indicators.get('adjclose', [{}])[0].get('adjclose', [])
        
        records = []
        for i in range(len(timestamps)):
            ts = timestamps[i]
            dt = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime('%Y-%m-%d')
            
            # 終値の選択 (adjclose優先、なければclose)
            close_price = None
            if i < len(adjclose) and adjclose[i] is not None:
                close_price = adjclose[i]
            elif i < len(close_prices) and close_prices[i] is not None:
                close_price = close_prices[i]
                
            volume = volumes[i] if i < len(volumes) else 0
            if volume is None:
                volume = 0
                
            # 欠損値(終値がNull)の行は除外
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
        print(f"Yahoo Finance API 取得エラー ({symbol}): {e}")
        return []

def send_to_workers(endpoint, data):
    if not WORKERS_API_URL:
        print(f"WORKERS_API_URL 未設定のため、Workers への送信をスキップします。データ件数: {len(data)}")
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

def trigger_calculation():
    if not WORKERS_API_URL:
        print("WORKERS_API_URL 未設定のため、集計処理の実行をスキップします。")
        return
        
    url = f"{WORKERS_API_URL.rstrip('/')}/api/calculate"
    print("Workers の集計処理をトリガーします...")
    try:
        res = requests.post(url, headers=get_headers(auth=True))
        res.raise_for_status()
        print(f"集計処理のトリガーに成功しました: {res.text}")
    except Exception as e:
        print(f"集計処理のトリガーに失敗しました: {e}")

def main():
    print("=== データ収集パイプライン開始 ===")
    
    # 1. 銘柄マスターのスクレイピング
    stocks, master_date = scrape_nikkei_components()
    
    # 2. 既存の登録済み銘柄一覧を取得
    existing_codes = get_existing_codes()
    
    # 3. 各銘柄および日経平均株価の時系列データを取得
    prices = []
    
    # 収集対象リスト作成 (225銘柄 + 日経平均インデックス)
    targets = [{"code": s["code"]} for s in stocks]
    targets.append({"code": "^N225"})
    
    total_targets = len(targets)
    print(f"時系列データの取得を開始します (対象: {total_targets} 件)")
    
    success_count = 0
    for idx, target in enumerate(targets):
        code = target["code"]
        # DBに過去データがあるか判定
        is_existing = code in existing_codes
        range_str = "5d" if is_existing else "1y"
        
        print(f"[{idx+1}/{total_targets}] Code: {code} ({'既存' if is_existing else '新規/過去なし'} -> range={range_str}) ... ", end="", flush=True)
        
        # Yahoo Finance API から取得
        records = fetch_yahoo_finance(code, range_str)
        if records:
            prices.extend(records)
            print(f"成功 ({len(records)} 件)")
            success_count += 1
        else:
            print("失敗 (またはデータなし)")
            
        # APIレートリミット回避のウェイト
        time.sleep(1.5)
        
    print(f"時系列データ取得完了。成功: {success_count}/{total_targets} 件。総レコード数: {len(prices)}")
    
    if not prices:
        print("エラー: 取得できた株価データが 0 件です。処理を中断します。")
        sys.exit(1)
        
    # 4. Workers に送信
    # 4.1. 銘柄マスターの送信
    send_to_workers("/api/stocks", stocks)
    
    # 4.2. 株価データのチャンク送信 (最大1500件ずつ分割)
    chunk_size = 1500
    total_prices = len(prices)
    for i in range(0, total_prices, chunk_size):
        chunk = prices[i:i + chunk_size]
        print(f"株価データを送信中 ({i + 1} 〜 {min(i + chunk_size, total_prices)} / {total_prices} 件)")
        success = send_to_workers("/api/prices", chunk)
        if not success:
            print("警告: チャンク送信中にエラーが発生しました。")
            
    # 5. 集計処理の実行トリガー
    trigger_calculation()
    
    print("=== データ収集パイプライン終了 ===")

if __name__ == "__main__":
    main()
