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
