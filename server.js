/**
 * PeakAlgo Render Bot – ETHUSDT.P 50m
 * TradingView → Bybit (Unified)
 * 95 % position size × 3x leverage
 * Market entry + TP/SL
 */

import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;

app.post("/", async (req, res) => {
  try {
    const data = req.body;
    const SECRET = process.env.SECRET || "S1ckline2012";
    if (data.secret !== SECRET)
      return res.status(403).json({ ok: false, error: "Unauthorized" });

    const { event, symbol, price } = data;
    if (!event || !symbol || !price)
      return res.status(400).json({ ok: false, error: "Missing fields" });

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
    const marginFraction = 0.95;
    const leverage = 3;

    console.log("=== ETH-BOT ORDER START ===");
    console.log({ event, side, symbol, price, leverage });

    // === Step 1 – Wallet Balance ===
    const balanceRes = await signedGET(
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

    console.log(`💰 Wallet balance: ${usdtBalance.toFixed(2)} USDT`);

    if (usdtBalance <= 0)
      throw new Error("No available USDT balance or invalid API response.");

    // === Step 2 – Positionsgröße ===
    const marginUsed = usdtBalance * marginFraction;
    const positionValue = marginUsed * leverage;
    let qty = positionValue / price;

    // ETH Kontrakt → min 0.001 ETH
    qty = Math.max(0.001, Math.min(qty, 1000));
    qty = Math.floor(qty * 1000) / 1000;

    console.log(
      `💰 Qty ≈ ${qty} ETH | Margin ${marginUsed.toFixed(
        2
      )} USDT × ${leverage}x = ${positionValue.toFixed(2)} USDT total`
    );

    // === Step 3 – Leverage setzen ===
    try {
      const lev = await signedPOST(
        `${BASE_URL}/v5/position/set-leverage`,
        {
          category: "linear",
          symbol,
          buyLeverage: leverage.toString(),
          sellLeverage: leverage.toString(),
        },
        API_KEY,
        API_SECRET
      );
      console.log("✅ Leverage-Set:", lev.retMsg);
    } catch (e) {
      console.warn("⚠️ set-leverage failed:", e.message);
    }

    // === Step 4 – Market-Entry + TP/SL ===
    const tp = (side === "Buy" ? price * 1.0272 : price * 0.9728).toFixed(2); // +2.72 %
    const sl = (side === "Buy" ? price * 0.91 : price * 1.09).toFixed(2);     // –9 %

    const order = await signedPOST(
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
        positionIdx: 0,
        reduceOnly: false,
      },
      API_KEY,
      API_SECRET
    );

    console.log("📤 Order Response:", JSON.stringify(order, null, 2));

    return res.json({
      ok: true,
      message: `Opened ${side} ${symbol} @ ${price}`,
      qty,
      leverage,
      tp,
      sl,
      bybitResponse: order,
    });
  } catch (err) {
    console.error("Worker Error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ===== Sign-Helper ===== */
async function signedGET(url, params, apiKey, apiSecret) {
  const ts = Date.now().toString();
  const recv = "5000";
  const q = new URLSearchParams(params).toString();
  const pre = ts + apiKey + recv + q;
  const sig = crypto.createHmac("sha256", apiSecret).update(pre).digest("hex");
  const r = await fetch(`${url}?${q}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-RECV-WINDOW": recv,
      "X-BAPI-SIGN": sig,
    },
  });
  return await r.json();
}

async function signedPOST(url, body, apiKey, apiSecret) {
  const ts = Date.now().toString();
  const recv = "5000";
  const str = JSON.stringify(body);
  const pre = ts + apiKey + recv + str;
  const sig = crypto.createHmac("sha256", apiSecret).update(pre).digest("hex");
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-RECV-WINDOW": recv,
      "X-BAPI-SIGN": sig,
    },
    body: str,
  });
  return await r.json();
}

/* ===== Server-Start ===== */
app.listen(PORT, () =>
  console.log(`✅ ETH-PeakAlgo Render-Bot listening on port ${PORT}`)
);
