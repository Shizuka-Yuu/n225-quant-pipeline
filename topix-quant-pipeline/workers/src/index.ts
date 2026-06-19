export interface Env {
  DB: D1Database;
  API_TOKEN: string;
}

// 共通のレスポンスヘッダー (CORS用)
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

    // API認証チェック
    if (path.startsWith("/api/")) {
      if (!checkAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    try {
      // 1. GET /api/topix/stocks
      // 登録済みの全アクティブ銘柄コード一覧を返す
      if (path === "/api/topix/stocks" && request.method === "GET") {
        const result = await env.DB.prepare(
          "SELECT code FROM topix_stocks WHERE is_active = 1"
        ).all();
        const codes = result.results.map((r) => r.code);

        // daily_prices に存在する code もマージして一意にする (指数シンボルなどに対応)
        const priceResult = await env.DB.prepare("SELECT DISTINCT code FROM topix_prices").all();
        const priceCodes = priceResult.results.map((r) => r.code);

        const allCodes = Array.from(new Set([...codes, ...priceCodes]));

        return new Response(JSON.stringify(allCodes), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 2. POST /api/topix/stocks
      // TOPIX構成銘柄マスターの登録 (一括UPSERT & 除外銘柄の論理削除)
      if (path === "/api/topix/stocks" && request.method === "POST") {
        const stocks = await request.json() as Array<{
          code: string;
          name: string;
          industry: string;
          weight: number;
          new_index_group: string;
          last_updated: string;
        }>;

        if (!Array.isArray(stocks)) {
          return new Response(JSON.stringify({ error: "Invalid data format" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // 1. 一旦、全登録銘柄のアクティブフラグを0（除外状態）に設定
        const deactivateStmt = env.DB.prepare("UPDATE topix_stocks SET is_active = 0");
        
        // 2. 送信された銘柄を is_active = 1 で登録・更新
        const upsertStmt = env.DB.prepare(
          `INSERT OR REPLACE INTO topix_stocks 
           (code, name, industry, weight, new_index_group, is_active, last_updated) 
           VALUES (?, ?, ?, ?, ?, 1, ?)`
        );

        // バッチ処理の実行 (全銘柄のフラグ更新 + UPSERT)
        const batchStmts = [deactivateStmt];
        
        // チャンクに分けて処理を結合
        const chunkSize = 100;
        for (let i = 0; i < stocks.length; i += chunkSize) {
          const chunk = stocks.slice(i, i + chunkSize);
          const chunkStmts = chunk.map((s) => 
            upsertStmt.bind(s.code, s.name, s.industry, s.weight, s.new_index_group, s.last_updated)
          );
          await env.DB.batch([deactivateStmt, ...chunkStmts]);
        }

        return new Response(JSON.stringify({ success: true, count: stocks.length }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 3. POST /api/topix/prices
      // 株価・出来高データの登録
      if (path === "/api/topix/prices" && request.method === "POST") {
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
          "INSERT OR REPLACE INTO topix_prices (code, date, close_price, volume) VALUES (?, ?, ?, ?)"
        );

        // D1のバッチ制限を考慮して100件ずつバッチ実行
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

      // 4. POST /api/topix/calculate
      // 日次指標計算の実行 (値上がり/値下がり/変わらず、52週新高値/新安値、全体出来高)
      if (path === "/api/topix/calculate" && request.method === "POST") {
        // D1から株価データを全件取得 (10,000行の上限を考慮しインクリメンタルにロード)
        let allPrices: Array<{ code: string; date: string; close_price: number; volume: number }> = [];
        let offset = 0;
        const limit = 10000;

        while (true) {
          const res = await env.DB.prepare(
            "SELECT code, date, close_price, volume FROM topix_prices ORDER BY code, date ASC LIMIT ? OFFSET ?"
          )
            .bind(limit, offset)
            .all<{ code: string; date: string; close_price: number; volume: number }>();

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

        // データを銘柄コードごとにマップ化
        const stockPricesMap = new Map<string, Array<{ date: string; close: number; volume: number }>>();
        for (const row of allPrices) {
          if (!stockPricesMap.has(row.code)) {
            stockPricesMap.set(row.code, []);
          }
          stockPricesMap.get(row.code)!.push({
            date: row.date,
            close: row.close_price,
            volume: row.volume,
          });
        }

        // ソートの整合性を担保
        for (const [code, arr] of stockPricesMap.entries()) {
          arr.sort((a, b) => a.date.localeCompare(b.date));
        }

        // TOPIX指数のデータと日付リストの特定 (基準日はTOPIX指数 ^TPX の日付リストとする)
        const topixPrices = stockPricesMap.get("^TPX") || [];
        if (topixPrices.length === 0) {
          return new Response(JSON.stringify({ error: "No TOPIX index data found (^TPX)" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const topixCloseMap = new Map<string, number>();
        for (const p of topixPrices) {
          topixCloseMap.set(p.date, p.close);
        }

        const uniqueDates = topixPrices.map((p) => p.date);
        const metricsToInsert: Array<{
          date: string;
          topix_close: number | null;
          advances: number;
          declines: number;
          unchanged: number;
          new_highs: number;
          new_lows: number;
          total_volume: number;
        }> = [];

        // 日付ごとに全銘柄の株価・出来高を集計計算
        for (let dIdx = 0; dIdx < uniqueDates.length; dIdx++) {
          const targetDate = uniqueDates[dIdx];

          let advances = 0;
          let declines = 0;
          let unchanged = 0;
          let newHighs = 0;
          let newLows = 0;
          let totalVolume = 0;

          // 52週 (365日) 前の日付文字列を算出
          const targetDateObj = new Date(targetDate);
          const past365DateObj = new Date(targetDateObj.getTime() - 365 * 24 * 60 * 60 * 1000);
          const past365DateStr = past365DateObj.toISOString().split("T")[0];

          for (const [code, priceArr] of stockPricesMap.entries()) {
            if (code === "^TPX") continue; // 指数自体は個別集計から除外

            const idx = priceArr.findIndex((p) => p.date === targetDate);
            if (idx === -1) continue; // 対象日にデータがない銘柄はスキップ

            const currentPrice = priceArr[idx].close;
            const currentVolume = priceArr[idx].volume;

            // 出来高の加算
            totalVolume += currentVolume;

            // 1. 前日比比較（値上がり・値下がり・変わらず）
            if (idx > 0) {
              const prevPrice = priceArr[idx - 1].close;
              if (currentPrice > prevPrice) {
                advances++;
              } else if (currentPrice < prevPrice) {
                declines++;
              } else {
                unchanged++;
              }
            }

            // 2. 52週新高値・新安値の計算
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
            topix_close: topixCloseMap.get(targetDate) || null,
            advances,
            declines,
            unchanged,
            new_highs: newHighs,
            new_lows: newLows,
            total_volume: totalVolume,
          });
        }

        // 集計データを D1 の topix_metrics に保存
        const insertStmt = env.DB.prepare(
          `INSERT OR REPLACE INTO topix_metrics 
           (date, topix_close, advances, declines, unchanged, new_highs, new_lows, total_volume) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );

        const chunkSize = 100;
        for (let i = 0; i < metricsToInsert.length; i += chunkSize) {
          const chunk = metricsToInsert.slice(i, i + chunkSize);
          const batchStmts = chunk.map((m) =>
            insertStmt.bind(
              m.date,
              m.topix_close,
              m.advances,
              m.declines,
              m.unchanged,
              m.new_highs,
              m.new_lows,
              m.total_volume
            )
          );
          await env.DB.batch(batchStmts);
        }

        return new Response(
          JSON.stringify({ success: true, count: metricsToInsert.length }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // 5. GET /api/topix/metrics
      // GAS向け日次集計データの返却
      if (path === "/api/topix/metrics" && request.method === "GET") {
        const result = await env.DB.prepare(
          `SELECT date, topix_close, advances, declines, unchanged, new_highs, new_lows, total_volume 
           FROM topix_metrics ORDER BY date ASC`
        ).all();

        return new Response(JSON.stringify(result.results), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 該当エンドポイントなし
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
