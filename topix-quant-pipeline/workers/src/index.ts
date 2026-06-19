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

      // 4. POST /api/topix/metrics
      // 集計済みデータの登録 (Python側で計算した結果を保存する)
      if (path === "/api/topix/metrics" && request.method === "POST") {
        const metrics = await request.json() as Array<{
          date: string;
          topix_close: number | null;
          advances: number;
          declines: number;
          unchanged: number;
          new_highs: number;
          new_lows: number;
          total_volume: number;
        }>;

        if (!Array.isArray(metrics)) {
          return new Response(JSON.stringify({ error: "Invalid data format" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const stmt = env.DB.prepare(
          `INSERT OR REPLACE INTO topix_metrics 
           (date, topix_close, advances, declines, unchanged, new_highs, new_lows, total_volume) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );

        // D1のバッチ制限を考慮して100件ずつバッチ実行
        const chunkSize = 100;
        for (let i = 0; i < metrics.length; i += chunkSize) {
          const chunk = metrics.slice(i, i + chunkSize);
          const batchStmts = chunk.map((m) =>
            stmt.bind(
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

        return new Response(JSON.stringify({ success: true, count: metrics.length }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 4.1. POST /api/topix/calculate
      // 未集計の日付について増分集計計算を実行する
      if (path === "/api/topix/calculate" && request.method === "POST") {
        // topix_prices に存在する日付のうち、topix_metrics に存在しない日付を昇順で取得
        const datesRes = await env.DB.prepare(
          `SELECT DISTINCT date FROM topix_prices 
           WHERE date NOT IN (SELECT date FROM topix_metrics) 
           ORDER BY date ASC`
        ).all<{ date: string }>();

        const targetDates = datesRes.results ? datesRes.results.map((r) => r.date) : [];
        if (targetDates.length === 0) {
          return new Response(JSON.stringify({ success: true, processed_count: 0, remaining_count: 0 }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // タイムアウトを防ぐため、1回のリクエストで最大10日分ずつ処理
        const batchDates = targetDates.slice(0, 10);
        const calculatedMetrics = [];

        for (const targetDate of batchDates) {
          // a. 指数の終値を取得
          const indexPriceRes = await env.DB.prepare(
            "SELECT close_price FROM topix_prices WHERE code = '^TPX' AND date = ?"
          ).bind(targetDate).first<{ close_price: number }>();
          const topixClose = indexPriceRes ? indexPriceRes.close_price : null;

          // b. 当日の全個別銘柄の株価・出来高を取得
          const currentPrices = await env.DB.prepare(
            "SELECT code, close_price, volume FROM topix_prices WHERE code != '^TPX' AND date = ?"
          ).bind(targetDate).all<{ code: string; close_price: number; volume: number }>();

          if (!currentPrices.results || currentPrices.results.length === 0) continue;

          // c. 前営業日の日付を特定し、その日の株価を取得
          const prevDateRes = await env.DB.prepare(
            "SELECT DISTINCT date FROM topix_prices WHERE date < ? ORDER BY date DESC LIMIT 1"
          ).bind(targetDate).first<{ date: string }>();

          const prevPricesMap = new Map<string, number>();
          if (prevDateRes) {
            const prevPrices = await env.DB.prepare(
              "SELECT code, close_price FROM topix_prices WHERE code != '^TPX' AND date = ?"
            ).bind(prevDateRes.date).all<{ code: string; close_price: number }>();
            if (prevPrices.results) {
              for (const p of prevPrices.results) {
                prevPricesMap.set(p.code, p.close_price);
              }
            }
          }

          // d. 過去52週 (365日) の最高値・最安値を取得
          const targetDateObj = new Date(targetDate);
          const past365DateObj = new Date(targetDateObj.getTime() - 365 * 24 * 60 * 60 * 1000);
          const past365DateStr = past365DateObj.toISOString().split("T")[0];

          const rangePrices = await env.DB.prepare(
            `SELECT code, MAX(close_price) as max_p, MIN(close_price) as min_p 
             FROM topix_prices 
             WHERE code != '^TPX' AND date >= ? AND date < ? 
             GROUP BY code`
          ).bind(past365DateStr, targetDate).all<{ code: string; max_p: number; min_p: number }>();

          const maxPricesMap = new Map<string, number>();
          const minPricesMap = new Map<string, number>();
          if (rangePrices.results) {
            for (const p of rangePrices.results) {
              maxPricesMap.set(p.code, p.max_p);
              minPricesMap.set(p.code, p.min_p);
            }
          }

          // 集計
          let advances = 0;
          let declines = 0;
          let unchanged = 0;
          let newHighs = 0;
          let newLows = 0;
          let totalVolume = 0;

          for (const p of currentPrices.results) {
            totalVolume += p.volume;

            // 前日比
            if (prevPricesMap.has(p.code)) {
              const prevClose = prevPricesMap.get(p.code)!;
              if (p.close_price > prevClose) {
                advances++;
              } else if (p.close_price < prevClose) {
                declines++;
              } else {
                unchanged++;
              }
            }

            // 新高値・新安値
            if (maxPricesMap.has(p.code)) {
              const maxP = maxPricesMap.get(p.code)!;
              const minP = minPricesMap.get(p.code)!;
              if (p.close_price >= maxP) {
                newHighs++;
              }
              if (p.close_price <= minP) {
                newLows++;
              }
            }
          }

          calculatedMetrics.push({
            date: targetDate,
            topix_close: topixClose,
            advances,
            declines,
            unchanged,
            new_highs: newHighs,
            new_lows: newLows,
            total_volume: totalVolume
          });
        }

        // 保存
        if (calculatedMetrics.length > 0) {
          const insertStmt = env.DB.prepare(
            `INSERT OR REPLACE INTO topix_metrics 
             (date, topix_close, advances, declines, unchanged, new_highs, new_lows, total_volume) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          );
          const batchStmts = calculatedMetrics.map((m) =>
            insertStmt.bind(m.date, m.topix_close, m.advances, m.declines, m.unchanged, m.new_highs, m.new_lows, m.total_volume)
          );
          await env.DB.batch(batchStmts);
        }

        return new Response(JSON.stringify({ 
          success: true, 
          processed_count: calculatedMetrics.length,
          remaining_count: targetDates.length - calculatedMetrics.length
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
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
