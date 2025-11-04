/**
 * ETH-PeakAlgo Render Bot – TradingView → Bybit
 * Market Entry + Fixed TP/SL + 95% sizing + 3x leverage
 * Auto-symbol cleanup (.P → '') for TradingView symbols
 */

import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

//──────────────────────────────────────────────
// Main route: TradingView → Bybit
//──────────────────────────────────────────────
app.post("/", async (req, res) => {
  try {
    const data = req.body;
    const SECRET = process.env.SECRET || "S1ckline2012";
    if (data.secret !== SECRET)
      return res.status(403).json({ ok: false, error: "Unauthorized" });

    let { event, symbol, price, lvg } = data;
    if (!event || !symbol || !price)
      return res.status(400).json({ ok: false, error: "Missing fields" });

    // Auto-clean TradingView symbols (remove ".P" or "PERP")
    const cleanSymbol = symbol.replace(".P", "").replace("PERP", "").toUpperCase();

    const side = event.includes("LONG")
      ? "Buy"
      : event.includes("SHORT")
      ? "Sell"
      : null;
    if (!side)
      return res.status(400).json({ ok: false, error: "Invalid event" });

    const API_KEY = process.env.BYBIT_API_KEY;
    const API_SECRET = process.env.BYBIT_API_SECRET;
    const BASE_URL = (process.env.BYBIT_API_URL || "https://api.bybit.com")
      .trim()
      .replace(/\s+/g, "")
      .replace(/\/+$/, "");

    const ACCOUNT_TYPE = process.env.ACCOUNT_TYPE || "UNIFIED";
    const marginFraction = 0.95; // use 95% of wallet balance
    const leverage = Number(lvg) || 3;

    console.log("///////////////////////////////////////////////////////////");
    console.log("=== ETH-BOT ORDER START ===");
    console.log({ event, side, symbol, cleanSymbol, price, leverage, marginFraction });
    console.log("===========================");

    //──────────────────────────────────────────────
    // 1️⃣ Wallet balance (Unified account)
    //──────────────────────────────────────────────
    const balanceRes = await sendSignedGETRequest(
      `${BASE_URL}/v5/account/wallet-balance`,
      { accountType: ACCOUNT_TYPE, coin: "USDT" },
      API_KEY,
      API_SECRET
    );

    if (balanceRes.retCode !== 0)
      throw new Error(`Balance error: ${balanceRes.retMsg}`);

    const coinList = balanceRes.result?.list?.[0]?.coin || [];
    const usdt = coinList.find((c) => c.coin === "USDT") || {};
    const usdtBalance =
      parseFloat(usdt.availableToWithdraw) ||
      parseFloat(usdt.walletBalance) ||
      parseFloat(usdt.equity) ||
      0;

    console.log(
      `💰 Wallet balance detected: ${usdtBalance.toFixed(4)} USDT (accountType=${ACCOUNT_TYPE})`
    );

    if (usdtBalance <= 0)
      throw new Error("No available USDT balance or invalid API response.");

    //──────────────────────────────────────────────
    // 2️⃣ Calculate position size (95% × 3x)
    //──────────────────────────────────────────────
    const marginUsed = usdtBalance * marginFraction;
    const positionValue = marginUsed * leverage;
    let qty = positionValue / price;

// Mindestgröße & Mindest-Nominalwert (10 USDT)
qty = Math.max(0.01, Math.min(qty, 100));
let nominal = qty * price;
if (nominal < 10) {
  qty = (10 / price);
  qty = Math.ceil(qty * 1000) / 1000; // auf StepSize 0.001 runden
}
console.log(`🔢 Adjusted qty to ${qty} ETH (≈ ${qty * price} USDT nominal)`);


    console.log(
      `💰 Calculated qty: ${qty} ETH (Margin: ${marginUsed.toFixed(
        2
      )} USDT × ${leverage}x = ${positionValue.toFixed(2)} USDT total)`
    );

    //──────────────────────────────────────────────
    // 3️⃣ Set leverage (optional)
    //──────────────────────────────────────────────
    try {
      const levRes = await sendSignedPOST(
        `${BASE_URL}/v5/position/set-leverage`,
        {
          category: "linear",
          symbol: cleanSymbol,
          buyLeverage: leverage.toString(),
          sellLeverage: leverage.toString(),
        },
        API_KEY,
        API_SECRET
      );
      console.log("✅ Leverage response:", levRes.retMsg);
    } catch (err) {
      console.warn("⚠️ set-leverage failed:", err.message);
    }

    //──────────────────────────────────────────────
    // 4️⃣ Place Market Order + TP/SL (fixed %)
    //──────────────────────────────────────────────
    const TP_PCT = 2.72;
    const SL_PCT = 9.0;

    const tp = (side === "Buy"
      ? price * (1 + TP_PCT / 100)
      : price * (1 - TP_PCT / 100)
    ).toFixed(2);

    const sl = (side === "Buy"
      ? price * (1 - SL_PCT / 100)
      : price * (1 + SL_PCT / 100)
    ).toFixed(2);

    const orderRes = await sendSignedPOST(
      `${BASE_URL}/v5/order/create`,
      {
        category: "linear",
        symbol: cleanSymbol,
        side,
        orderType: "Market",
        qty: qty.toString(),
        timeInForce: "GTC",
        takeProfit: tp,
        stopLoss: sl,
        positionIdx: 0,
        reduceOnly: false,
      },
      API_KEY,
      API_SECRET
    );

    console.log("📤 Order Response:", JSON.stringify(orderRes, null, 2));

    return res.json({
      ok: true,
      message: `Opened ${side} ${cleanSymbol} @ ${price}`,
      qty,
      leverage,
      tp,
      sl,
      bybitResponse: orderRes,
    });
  } catch (err) {
    console.error("❌ Worker Error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

//──────────────────────────────────────────────
// Helper functions for signed API calls
//──────────────────────────────────────────────
async function sendSignedGETRequest(url, params, apiKey, apiSecret) {
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const query = new URLSearchParams(params).toString();
  const preSign = timestamp + apiKey + recvWindow + query;
  const sign = crypto.createHmac("sha256", apiSecret).update(preSign).digest("hex");

  const res = await fetch(`${url}?${query}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": sign,
    },
  });
  const text = await res.text();
  return JSON.parse(text);
}

async function sendSignedPOST(url, body, apiKey, apiSecret) {
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const bodyStr = JSON.stringify(body);
  const preSign = timestamp + apiKey + recvWindow + bodyStr;
  const sign = crypto.createHmac("sha256", apiSecret).update(preSign).digest("hex");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": sign,
    },
    body: bodyStr,
  });
  const text = await res.text();
  return JSON.parse(text);
}

//──────────────────────────────────────────────
// Start server
//──────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`✅ ETH-PeakAlgo Render-Bot listening on port ${PORT}`)
);
