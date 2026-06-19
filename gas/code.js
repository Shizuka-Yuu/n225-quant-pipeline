/**
 * 日経225データパイプライン同期スクリプト (GAS用)
 * スプレッドシートの「拡張機能 > Apps Script」に貼り付けて使用してください。
 */

// 定数定義 (ScriptPropertiesから取得できない場合のデフォルト値)
var DEFAULT_SHEET_NAME = "raw_data";
var DEFAULT_EMA_FAST = 19;  // 19日 (約10%平滑化)
var DEFAULT_EMA_SLOW = 39;  // 39日 (約5%平滑化)

/**
 * 初期セットアップ関数
 * スプレッドシート上で手動で1回実行してください。必要なプロパティの設定とシート作成を行います。
 */
function setup() {
  var activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = activeSpreadsheet.getSheetByName(DEFAULT_SHEET_NAME);
  if (!sheet) {
    sheet = activeSpreadsheet.insertSheet(DEFAULT_SHEET_NAME);
    // ヘッダー行の書き込み
    sheet.appendRow(["date", "nk225_close", "advances", "declines", "new_highs", "new_lows", "mcclellan_osc"]);
    Logger.log("シート '" + DEFAULT_SHEET_NAME + "' を新規作成しました。");
  } else {
    Logger.log("シート '" + DEFAULT_SHEET_NAME + "' は既に存在します。");
  }

  // 初期スクリプトプロパティのセット
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty("WORKERS_API_URL")) {
    props.setProperty("WORKERS_API_URL", "https://your-workers-url.workers.dev");
  }
  if (!props.getProperty("WORKERS_API_TOKEN")) {
    props.setProperty("WORKERS_API_TOKEN", "your-secure-token");
  }
  if (!props.getProperty("EMA_FAST_PERIOD")) {
    props.setProperty("EMA_FAST_PERIOD", String(DEFAULT_EMA_FAST));
  }
  if (!props.getProperty("EMA_SLOW_PERIOD")) {
    props.setProperty("EMA_SLOW_PERIOD", String(DEFAULT_EMA_SLOW));
  }
  
  Logger.log("セットアップが完了しました。ScriptPropertiesの値およびシート構成を確認してください。");
}

/**
 * Workers API からデータを取得し、マクレランオシレーターを計算してスプレッドシートに追記するメイン関数
 */
function syncN225Metrics() {
  var props = PropertiesService.getScriptProperties();
  var workersUrl = props.getProperty("WORKERS_API_URL");
  var token = props.getProperty("WORKERS_API_TOKEN");
  var fastPeriod = parseInt(props.getProperty("EMA_FAST_PERIOD") || DEFAULT_EMA_FAST, 10);
  var slowPeriod = parseInt(props.getProperty("EMA_SLOW_PERIOD") || DEFAULT_EMA_SLOW, 10);

  if (!workersUrl || workersUrl.indexOf("your-workers-url") !== -1) {
    throw new Error("WORKERS_API_URL が設定されていないか、デフォルト値のままです。ScriptProperties を設定してください。");
  }

  var activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = activeSpreadsheet.getSheetByName(DEFAULT_SHEET_NAME);
  if (!sheet) {
    throw new Error("シート '" + DEFAULT_SHEET_NAME + "' が見つかりません。先に setup 関数を実行してください。");
  }

  // 1. スプレッドシート上の既存日付を特定 (A列)
  var lastRow = sheet.getLastRow();
  var existingDates = new Set();
  var latestDateStr = "";

  if (lastRow > 1) {
    // ヘッダーを除いた日付の範囲を取得 (A2:A{lastRow})
    var dateValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < dateValues.length; i++) {
      var d = dateValues[i][0];
      if (d) {
        var dateStr = formatDate(d);
        existingDates.add(dateStr);
        if (dateStr > latestDateStr) {
          latestDateStr = dateStr;
        }
      }
    }
  }
  
  Logger.log("スプレッドシートの既存データ件数: " + existingDates.size + ", 最新日付: " + (latestDateStr || "なし"));

  // 2. Workers から基礎集計データを取得
  var endpoint = workersUrl.replace(/\/$/, "") + "/api/metrics";
  Logger.log("Workers からデータを取得中: " + endpoint);
  
  var options = {
    method: "get",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(endpoint, options);
  var responseCode = response.getResponseCode();
  
  if (responseCode !== 200) {
    throw new Error("Workers API からのデータ取得に失敗しました。ステータスコード: " + responseCode + ", レスポンス: " + response.getContentText());
  }

  var metricsData = JSON.parse(response.getContentText());
  Logger.log("取得した生データ件数: " + metricsData.length);

  if (metricsData.length === 0) {
    Logger.log("取得データが 0 件のため、処理を終了します。");
    return;
  }

  // 3. マクレラン・オシレーターを全期間で動的計算 (EMA期間をGAS側で制御)
  // EMA計算用の平滑化定数
  var alphaFast = 2 / (fastPeriod + 1);
  var alphaSlow = 2 / (slowPeriod + 1);

  var emaFast = 0;
  var emaSlow = 0;

  var calculatedRows = [];

  for (var j = 0; j < metricsData.length; j++) {
    var raw = metricsData[j];
    var dValue = raw.advances - raw.declines;

    // 初回行は D の値そのものを初期値とする
    if (j === 0) {
      emaFast = dValue;
      emaSlow = dValue;
    } else {
      emaFast = (dValue - emaFast) * alphaFast + emaFast;
      emaSlow = (dValue - emaSlow) * alphaSlow + emaSlow;
    }

    var mcclellanOsc = emaFast - emaSlow;

    calculatedRows.push({
      date: raw.date,
      nk225_close: raw.nk225_close,
      advances: raw.advances,
      declines: raw.declines,
      new_highs: raw.new_highs,
      new_lows: raw.new_lows,
      mcclellan_osc: mcclellanOsc
    });
  }

  // 4. 重複を排除した新規追加用データの抽出
  var newRows = [];
  for (var k = 0; k < calculatedRows.length; k++) {
    var row = calculatedRows[k];
    if (!existingDates.has(row.date)) {
      newRows.push([
        row.date,
        row.nk225_close,
        row.advances,
        row.declines,
        row.new_highs,
        row.new_lows,
        row.mcclellan_osc
      ]);
    }
  }

  Logger.log("追記対象の新規データ件数: " + newRows.length);

  // 5. 末尾への一括追記
  if (newRows.length > 0) {
    // 日付順にソートして追記
    newRows.sort(function(a, b) {
      return a[0].localeCompare(b[0]);
    });

    var insertStartRow = lastRow + 1;
    sheet.getRange(insertStartRow, 1, newRows.length, 7).setValues(newRows);
    Logger.log("スプレッドシートに " + newRows.length + " 件のレコードを追記しました。");
  } else {
    Logger.log("追記する新しいデータはありません。");
  }
}

/**
 * 日付オブジェクトを YYYY-MM-DD 文字列に変換するヘルパー
 */
function formatDate(date) {
  if (date instanceof Date) {
    var y = date.getFullYear();
    var m = ("0" + (date.getMonth() + 1)).slice(-2);
    var d = ("0" + date.getDate()).slice(-2);
    return y + "-" + m + "-" + d;
  }
  // すでに文字列で格納されている場合
  if (typeof date === "string") {
    // YYYY-MM-DD 形式であればそのまま返す
    var match = date.match(/^\d{4}-\d{2}-\d{2}/);
    if (match) {
      return match[0];
    }
    // スプレッドシート上の解釈などで別形式になっている場合、日付にパースしてみる
    try {
      var parsedDate = new Date(date);
      if (!isNaN(parsedDate.getTime())) {
        return formatDate(parsedDate);
      }
    } catch(e) {}
  }
  return String(date);
}
