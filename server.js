/**
 * PeakAlgo Render Bot – TradingView → Bybit
 * Market Entry + ATR-based TP/SL + dynamic 90% qty + leverage + logging
 * Compatible with Unified Trading Account (UTA) & Contract
 */

import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());

app.post("/", async (req, res) => {
  try {
    const data = req.body;
    const SECRET = process.env.SECRET || "S1ckline2012";

    if (data.secret !== SECRET)
      return res.status(403).json({ ok: false, error: "Unauthorized" });

    const { event, symbol, price, lvg } = data;
    if (!event || !symbol || !price)
      return res.status(400).json({ ok: false, error: "Missing fields" });

    // === API Credentials & Base URL ===
    const API_KEY = process.env.BYBIT_API_KEY;
    const API_SECRET = process.env.BYBIT_API_SECRET;
    const BASE_URL = (process.env.BYBIT_API_URL || "https://api.bybit.com")
      .trim()
      .replace(/\s+/g, "")
      .replace(/\/+$/, "");

    if (!API_KEY || !API_SECRET)
      throw new Error("Missing Bybit API credentials.");

    // === Side bestimmen ===
    const side = event.includes("LONG")
      ? "Buy"
      : event.includes("SHORT")
      ? "Sell"
      : null;
    if (!side)
      return res.status(400).json({ ok: false, error: "Invalid event" });

    // === TP/SL übernehmen (von TV oder Fallback) ===
    let tp = data.tp || (side === "Buy" ? price * 1.003 : price * 0.997);
    let sl = data.sl || (side === "Buy" ? price * 0.997 : price * 1.003);
    tp = parseFloat(tp).toFixed(2);
    sl = parseFloat(sl).toFixed(2);

    console.log("///////////////////////////////////////////////////////////");
    console.log("=== ORDER START ===");
    console.log({ event, side, symbol, price, tp, sl, lvg });
    console.log("===================");

    // === Schritt 1: Balance holen (UTA via GET) ===
    let balanceRes;
    let accountTypeUsed = "UNIFIED";

    try {
      balanceRes = await sendSignedGETRequest(
        `${BASE_URL}/v5/asset/transfer/query-account-coin-balance`,
        { accountType: "UNIFIED", coin: "USDT" },
        API_KEY,
        API_SECRET
      );
      if (balanceRes.retCode !== 0) throw new Error("Invalid UNIFIED response");
    } catch (err) {
      console.warn("⚠️ UNIFIED failed, retrying with CONTRACT...");
      balanceRes = await sendSignedGETRequest(
        `${BASE_URL}/v5/asset/transfer/query-account-coin-balance`,
        { accountType: "CONTRACT", coin: "USDT" },
        API_KEY,
        API_SECRET
      );
      accountTypeUsed = "CONTRACT";
    }

    console.log(
      `✅ Using accountType: ${accountTypeUsed}`,
      JSON.stringify(balanceRes, null, 2)
    );

    const usdtBalance =
      parseFloat(balanceRes.result?.balance?.transferBalance) ||
      parseFloat(balanceRes.result?.balance?.walletBalance) ||
      0;

    if (usdtBalance <= 0)
      throw new Error("No available USDT balance or invalid API response.");

    // === Schritt 1.1: Margin- und Hebel-basierte Positionsgröße ===
    const marginFraction = 0.90; // 90 % des Balances als Margin
    const leverage = Number(lvg) || 1;

    const marginUsed = usdtBalance * marginFraction;
    const positionValue = marginUsed * leverage;

    let qty = positionValue / price;

    // Sicherheitslimits und korrekte Rundung (Bybit StepSize 0.001)
    qty = Math.max(0.001, Math.min(qty, 10));
    qty = Math.floor(qty * 1000) / 1000;

    console.log(
      `💰 Calculated qty: ${qty} BTC (Margin: ${marginUsed.toFixed(
        2
      )} USDT × ${leverage}x = ${positionValue.toFixed(2)} USDT total)`
    );

    // === Schritt 2: Leverage setzen (Sicherheitsmaßnahme) ===
    try {
      const leverageRes = await sendSignedRequest(
        `${BASE_URL}/v5/position/set-leverage`,
        {
          category: "linear",
          symbol,
          buyLeverage: leverage.toString(),
          sellLeverage: leverage.toString()
        },
        API_KEY,
        API_SECRET
      );
      console.log("Leverage set response:", JSON.stringify(leverageRes, null, 2));
    } catch (levErr) {
      console.warn("⚠️ Could not set leverage:", levErr.message);
    }

    // === Schritt 3: Market Entry ===
    const orderRes = await sendSignedRequest(
      `${BASE_URL}/v5/order/create`,
      {
        category: "linear",
        symbol,
        side,
        orderType: "Market",
        qty: qty.toString(),
        timeInForce: "GTC",
        takeProfit: tp,
        stopLoss: sl,
        positionIdx: 0
      },
      API_KEY,
      API_SECRET
    );

    console.log("Order Response:", JSON.stringify(orderRes, null, 2));

    return res.json({
      ok: true,
      message: `Opened ${side} ${symbol} @${price}`,
      leverage,
      qty,
      accountTypeUsed,
      bybitResponse: orderRes
    });
  } catch (err) {
    console.error("Worker Error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message,
      stack: err.stack
    });
  }
});

/** === Helper: signierter POST-Request (Bybit) === */
async function sendSignedRequest(url, params, apiKey, apiSecret) {
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const searchParams = new URLSearchParams(params).toString();
  const preSign = timestamp + apiKey + recvWindow + searchParams;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(preSign)
    .digest("hex");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": signature
    },
    body: searchParams
  });

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error("⚠️ Bybit non-JSON response for:", url);
    console.error(text.slice(0, 400));
    throw new Error(`Bybit returned non-JSON response (${res.status})`);
  }
}

/** === Helper: signierter GET-Request (Bybit Balance) === */
async function sendSignedGETRequest(url, params, apiKey, apiSecret) {
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const searchParams = new URLSearchParams(params).toString();
  const preSign = timestamp + apiKey + recvWindow + searchParams;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(preSign)
    .digest("hex");

  const fullUrl = `${url}?${searchParams}`;
  const res = await fetch(fullUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": signature
    }
  });

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error("⚠️ Bybit non-JSON response for:", url);
    console.error(text.slice(0, 400));
    throw new Error(`Bybit returned non-JSON response (${res.status})`);
  }
}

app.listen(10000, () => console.log("✅ PeakAlgo Render bot online"));
