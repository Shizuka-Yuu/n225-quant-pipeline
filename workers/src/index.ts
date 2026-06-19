export interface Env {
  DB: D1Database;
  API_TOKEN: string;
}

// 共通のレスポンスヘッダー
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// 認証チェック関数
function checkAuth(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.substring(7);
  return token === env.API_TOKEN;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // OPTIONS リクエスト（CORSプリフライト）の処理
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // GET 以外のメソッドはすべて認証チェック
    // ※ GET /api/metrics もGAS連携等のため、セキュリティ上認証を必須とします
    if (path.startsWith("/api/")) {
      if (!checkAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    try {
      // 1. GET /api/stocks
      // 登録済みの全銘柄コード一覧を返す (Actions側で新規・既存判定に利用)
      if (path === "/api/stocks" && request.method === "GET") {
        const result = await env.DB.prepare("SELECT code FROM stocks").all();
        const codes = result.results.map((r) => r.code);
        // daily_prices に存在する code もマージして一意にする (特にインデックスなど)
        const priceResult = await env.DB.prepare("SELECT DISTINCT code FROM daily_prices").all();
        const priceCodes = priceResult.results.map((r) => r.code);
        
        const allCodes = Array.from(new Set([...codes, ...priceCodes]));
        
        return new Response(JSON.stringify(allCodes), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 2. POST /api/stocks
      // 銘柄マスターの登録
      if (path === "/api/stocks" && request.method === "POST") {
        const stocks = await request.json() as Array<{
          code: string;
          name: string;
          full_name: string;
          industry: string;
        }>;

        if (!Array.isArray(stocks)) {
          return new Response(JSON.stringify({ error: "Invalid data format" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // チャンクに分けて INSERT OR REPLACE
        const stmt = env.DB.prepare(
          "INSERT OR REPLACE INTO stocks (code, name, full_name, industry) VALUES (?, ?, ?, ?)"
        );

        const chunkSize = 100;
        for (let i = 0; i < stocks.length; i += chunkSize) {
          const chunk = stocks.slice(i, i + chunkSize);
          const batchStmts = chunk.map((s) => stmt.bind(s.code, s.name, s.full_name, s.industry));
          await env.DB.batch(batchStmts);
        }

        return new Response(JSON.stringify({ success: true, count: stocks.length }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 3. POST /api/prices
      // 株価・出来高データの登録
      if (path === "/api/prices" && request.method === "POST") {
        const prices = await request.json() as Array<{
          code: string;
          date: string;
          close_price: number;
          volume: number;
        }>;

        if (!Array.isArray(prices)) {
          return new Response(JSON.stringify({ error: "Invalid data format" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const stmt = env.DB.prepare(
          "INSERT OR REPLACE INTO daily_prices (code, date, close_price, volume) VALUES (?, ?, ?, ?)"
        );

        // D1のバッチサイズ制限を考慮し、100件ずつバッチ実行
        const chunkSize = 100;
        for (let i = 0; i < prices.length; i += chunkSize) {
          const chunk = prices.slice(i, i + chunkSize);
          const batchStmts = chunk.map((p) => stmt.bind(p.code, p.date, p.close_price, p.volume));
          await env.DB.batch(batchStmts);
        }

        return new Response(JSON.stringify({ success: true, count: prices.length }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 4. POST /api/calculate
      // 集計計算の実行（日次集計データの生成と daily_metrics への格納）
      if (path === "/api/calculate" && request.method === "POST") {
        // 1. D1 から全株価データを10,000行ずつ取得してメモリにマージ (10,000行上限対策)
        let allPrices: Array<{ code: string; date: string; close_price: number }> = [];
        let offset = 0;
        const limit = 10000;
        
        while (true) {
          const res = await env.DB.prepare(
            "SELECT code, date, close_price FROM daily_prices ORDER BY code, date ASC LIMIT ? OFFSET ?"
          )
            .bind(limit, offset)
            .all<{ code: string; date: string; close_price: number }>();
            
          if (!res.results || res.results.length === 0) {
            break;
          }
          allPrices = allPrices.concat(res.results);
          if (res.results.length < limit) {
            break;
          }
          offset += limit;
        }

        if (allPrices.length === 0) {
          return new Response(JSON.stringify({ error: "No price data in database" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // 2. データを銘柄コードごとにマップ化
        const stockPricesMap = new Map<string, Array<{ date: string; close: number }>>();
        for (const row of allPrices) {
          if (!stockPricesMap.has(row.code)) {
            stockPricesMap.set(row.code, []);
          }
          stockPricesMap.get(row.code)!.push({ date: row.date, close: row.close_price });
        }

        // 各銘柄内の日付順ソート (ORDER BYで取得しているため基本ソート済だが念のため)
        for (const [code, arr] of stockPricesMap.entries()) {
          arr.sort((a, b) => a.date.localeCompare(b.date));
        }

        // 3. 日経平均のデータと日付リストの特定
        const n225Prices = stockPricesMap.get("^N225") || [];
        if (n225Prices.length === 0) {
          return new Response(JSON.stringify({ error: "No N225 index data found" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const n225CloseMap = new Map<string, number>();
        for (const p of n225Prices) {
          n225CloseMap.set(p.date, p.close);
        }

        // 計算対象の日付リスト (N225の時系列)
        const uniqueDates = n225Prices.map((p) => p.date);

        // 計算結果の格納用
        const metricsToInsert: Array<{
          date: string;
          nk225_close: number | null;
          advances: number;
          declines: number;
          new_highs: number;
          new_lows: number;
        }> = [];

        // 4. 日付ごとに集計計算を実行
        for (let dIdx = 0; dIdx < uniqueDates.length; dIdx++) {
          const targetDate = uniqueDates[dIdx];
          
          let advances = 0;
          let declines = 0;
          let newHighs = 0;
          let newLows = 0;

          // 基準日から過去365日前までの日時テキストを計算
          const targetDateObj = new Date(targetDate);
          const past365DateObj = new Date(targetDateObj.getTime() - 365 * 24 * 60 * 60 * 1000);
          const past365DateStr = past365DateObj.toISOString().split("T")[0];

          // 個別銘柄ごとに計算
          for (const [code, priceArr] of stockPricesMap.entries()) {
            if (code === "^N225") continue; // インデックス自体は個別集計から除外

            const idx = priceArr.findIndex((p) => p.date === targetDate);
            if (idx === -1) continue; // 当日のデータが無い銘柄はスキップ

            const currentPrice = priceArr[idx].close;

            // A) 値上がり・値下がりの計算（直前取引レコードとの比較）
            if (idx > 0) {
              const prevPrice = priceArr[idx - 1].close;
              if (currentPrice > prevPrice) {
                advances++;
              } else if (currentPrice < prevPrice) {
                declines++;
              }
            }

            // B) 52週新高値・新安値の計算
            // 基準日より前の過去365日間のデータを抽出
            const pastPrices = priceArr.filter(
              (p) => p.date >= past365DateStr && p.date < targetDate
            );

            if (pastPrices.length > 0) {
              let maxPrice = -Infinity;
              let minPrice = Infinity;
              
              for (const p of pastPrices) {
                if (p.close > maxPrice) maxPrice = p.close;
                if (p.close < minPrice) minPrice = p.close;
              }

              if (currentPrice >= maxPrice) {
                newHighs++;
              }
              if (currentPrice <= minPrice) {
                newLows++;
              }
            }
          }

          metricsToInsert.push({
            date: targetDate,
            nk225_close: n225CloseMap.get(targetDate) || null,
            advances,
            declines,
            new_highs: newHighs,
            new_lows: newLows,
          });
        }

        // 5. 計算結果を D1 の daily_metrics に保存
        const insertStmt = env.DB.prepare(
          "INSERT OR REPLACE INTO daily_metrics (date, nk225_close, advances, declines, new_highs, new_lows) VALUES (?, ?, ?, ?, ?, ?)"
        );

        const chunkSize = 100;
        for (let i = 0; i < metricsToInsert.length; i += chunkSize) {
          const chunk = metricsToInsert.slice(i, i + chunkSize);
          const batchStmts = chunk.map((m) =>
            insertStmt.bind(m.date, m.nk225_close, m.advances, m.declines, m.new_highs, m.new_lows)
          );
          await env.DB.batch(batchStmts);
        }

        return new Response(
          JSON.stringify({ success: true, count: metricsToInsert.length }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // 5. GET /api/metrics
      // GAS向け日次集計データの返却
      if (path === "/api/metrics" && request.method === "GET") {
        const result = await env.DB.prepare(
          "SELECT date, nk225_close, advances, declines, new_highs, new_lows FROM daily_metrics ORDER BY date ASC"
        ).all();

        return new Response(JSON.stringify(result.results), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // エンドポイントが見つからない場合
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message || "Internal Server Error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};
