/**
 * TOPIXデータパイプライン同期スクリプト (GAS用)
 * スプレッドシートの「拡張機能 > Apps Script」に貼り付けて使用してください。
 */

// 定数定義 (ScriptPropertiesから取得できない場合のデフォルト値)
var DEFAULT_SHEET_NAME = "topix_raw_data";
var DEFAULT_EMA_FAST = 19;  // 19日
var DEFAULT_EMA_SLOW = 39;  // 39日

/**
 * 初期セットアップ関数
 * スプレッドシート上で手動で1回実行してください。必要なプロパティの設定とシート作成を行います。
 */
function setup() {
  var activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = activeSpreadsheet.getSheetByName(DEFAULT_SHEET_NAME);
  if (!sheet) {
    sheet = activeSpreadsheet.insertSheet(DEFAULT_SHEET_NAME);
    // ヘッダー行の書き込み (unchanged, total_volume を追加)
    sheet.appendRow([
      "date", 
      "topix_close", 
      "advances", 
      "declines", 
      "unchanged", 
      "new_highs", 
      "new_lows", 
      "total_volume", 
      "mcclellan_osc"
    ]);
    Logger.log("シート '" + DEFAULT_SHEET_NAME + "' を新規作成しました。");
  } else {
    Logger.log("シート '" + DEFAULT_SHEET_NAME + "' は既に存在します。");
  }

  // 初期スクリプトプロパティのセット (TOPIX専用のWorkersエンドポイント用)
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty("TOPIX_WORKERS_API_URL")) {
    props.setProperty("TOPIX_WORKERS_API_URL", "https://your-topix-workers-url.workers.dev");
  }
  if (!props.getProperty("TOPIX_WORKERS_API_TOKEN")) {
    props.setProperty("TOPIX_WORKERS_API_TOKEN", "your-secure-token");
  }
  if (!props.getProperty("TOPIX_EMA_FAST_PERIOD")) {
    props.setProperty("TOPIX_EMA_FAST_PERIOD", String(DEFAULT_EMA_FAST));
  }
  if (!props.getProperty("TOPIX_EMA_SLOW_PERIOD")) {
    props.setProperty("TOPIX_EMA_SLOW_PERIOD", String(DEFAULT_EMA_SLOW));
  }
  
  Logger.log("セットアップが完了しました。ScriptPropertiesの値およびシート構成を確認してください。");
}

/**
 * Workers API からデータを取得し、マクレランオシレーターを計算してスプレッドシートに追記・更新するメイン関数
 */
function syncTOPIXMetrics() {
  var props = PropertiesService.getScriptProperties();
  var workersUrl = props.getProperty("TOPIX_WORKERS_API_URL");
  var token = props.getProperty("TOPIX_WORKERS_API_TOKEN");
  var fastPeriod = parseInt(props.getProperty("TOPIX_EMA_FAST_PERIOD") || DEFAULT_EMA_FAST, 10);
  var slowPeriod = parseInt(props.getProperty("TOPIX_EMA_SLOW_PERIOD") || DEFAULT_EMA_SLOW, 10);

  if (!workersUrl || workersUrl.indexOf("your-topix-workers-url") !== -1) {
    throw new Error("TOPIX_WORKERS_API_URL が設定されていないか、デフォルト値のままです。ScriptProperties を設定してください。");
  }

  var activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = activeSpreadsheet.getSheetByName(DEFAULT_SHEET_NAME);
  if (!sheet) {
    throw new Error("シート '" + DEFAULT_SHEET_NAME + "' が見つかりません。先に setup 関数を実行してください。");
  }

  // 1. スプレッドシート上の全既存データを取得
  var lastRow = sheet.getLastRow();
  var sheetData = [];
  var latestDateStr = "";

  // カラム数は 9列
  if (lastRow > 1) {
    sheetData = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  }

  // 日付をキーとして、sheetData上のインデックスをマップ化
  var dateToIndexMap = {};
  for (var i = 0; i < sheetData.length; i++) {
    var d = sheetData[i][0];
    if (d) {
      var dateStr = formatDate(d);
      dateToIndexMap[dateStr] = i;
      if (dateStr > latestDateStr) {
        latestDateStr = dateStr;
      }
    }
  }
  
  Logger.log("スプレッドシートの既存データ件数: " + sheetData.length + ", 最新日付: " + (latestDateStr || "なし"));

  // 2. Workers から基礎集計データを取得
  var endpoint = workersUrl.replace(/\/$/, "") + "/api/topix/metrics";
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
      topix_close: raw.topix_close,
      advances: raw.advances,
      declines: raw.declines,
      unchanged: raw.unchanged,
      new_highs: raw.new_highs,
      new_lows: raw.new_lows,
      total_volume: raw.total_volume,
      mcclellan_osc: mcclellanOsc
    });
  }

  // 4. メモリ上でデータをマージ（既存日付は上書き、新規日付は追加）
  var updateCount = 0;
  var insertCount = 0;

  for (var k = 0; k < calculatedRows.length; k++) {
    var row = calculatedRows[k];
    var rowData = [
      row.date,
      row.topix_close,
      row.advances,
      row.declines,
      row.unchanged,
      row.new_highs,
      row.new_lows,
      row.total_volume,
      row.mcclellan_osc
    ];

    if (row.date in dateToIndexMap) {
      var idx = dateToIndexMap[row.date];
      sheetData[idx] = rowData;
      updateCount++;
    } else {
      sheetData.push(rowData);
      insertCount++;
    }
  }

  // 日付順にソート
  sheetData.sort(function(a, b) {
    return a[0].localeCompare(b[0]);
  });

  Logger.log("更新（上書き）データ件数: " + updateCount + ", 新規追加データ件数: " + insertCount);

  // 5. スプレッドシートへ一括書き戻し
  if (sheetData.length > 0) {
    sheet.getRange(2, 1, sheetData.length, 9).setValues(sheetData);
    Logger.log("スプレッドシートに合計 " + sheetData.length + " 件のレコードを書き込みました。");
  } else {
    Logger.log("書き込むデータはありません。");
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
  if (typeof date === "string") {
    var match = date.match(/^\d{4}-\d{2}-\d{2}/);
    if (match) {
      return match[0];
    }
    try {
      var parsedDate = new Date(date);
      if (!isNaN(parsedDate.getTime())) {
        return formatDate(parsedDate);
      }
    } catch(e) {}
  }
  return String(date);
}
