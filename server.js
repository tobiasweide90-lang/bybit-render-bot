/**
 * ETHUSDT Render Bot – TradingView → Bybit (REAL)
 * Market Entry + TP/SL + dynamic 95% sizing + leverage
 * Handles .P symbols, One-Way/Hedge detection, and 0.01 ETH step rounding
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

    const { event, symbol, price, lvg } = data;
    if (!event || !symbol || !price)
      return res.status(400).json({ ok: false, error: "Missing fields" });

    //──────────────────────────────────────────────
    // Determine trade side
    //──────────────────────────────────────────────
    const side = event.includes("LONG")
      ? "Buy"
      : event.includes("SHORT")
      ? "Sell"
      : null;
    if (!side)
      return res.status(400).json({ ok: false, error: "Invalid event" });

    // Clean up symbol (TradingView often sends .P)
    const cleanSymbol = symbol.replace(".P", "").trim();

    //──────────────────────────────────────────────
    // Base setup
    //──────────────────────────────────────────────
    const API_KEY = process.env.BYBIT_API_KEY;
    const API_SECRET = process.env.BYBIT_API_SECRET;
    const BASE_URL = (process.env.BYBIT_API_URL || "https://api.bybit.com")
      .trim()
      .replace(/\s+/g, "")
      .replace(/\/+$/, "");

    const ACCOUNT_TYPE = process.env.ACCOUNT_TYPE || "UNIFIED";
    const marginFraction = 0.95;
    const leverage = Number(lvg) || 3;

    console.log("///////////////////////////////////////////////////////////");
    console.log("=== ETH-BOT ORDER START ===");
    console.log({
      event,
      side,
      symbol,
      cleanSymbol,
      price,
      leverage,
      marginFraction,
    });
    console.log("===========================");

    //──────────────────────────────────────────────
    // 1️⃣ Fetch USDT balance
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
      `💰 Wallet balance detected: ${usdtBalance.toFixed(
        4
      )} USDT (accountType=${ACCOUNT_TYPE})`
    );

    if (usdtBalance <= 0)
      throw new Error("No available USDT balance or invalid API response.");

    //──────────────────────────────────────────────
    // 2️⃣ Calculate position size (95 % × leverage)
    //──────────────────────────────────────────────
    const marginUsed = usdtBalance * marginFraction;
    const positionValue = marginUsed * leverage;
    let qty = positionValue / price;

    // Mindestgröße & Mindest-Nominalwert (10 USDT)
    qty = Math.max(0.01, Math.min(qty, 100));
    let nominal = qty * price;
    if (nominal < 10) {
      qty = 10 / price;
    }

    // 🔧 ETH StepSize = 0.01 → runden
    qty = Math.floor(qty * 100) / 100;

    console.log(
      `🔢 Adjusted qty = ${qty} ETH (≈ ${(qty * price).toFixed(2)} USDT nominal)`
    );
    console.log(
      `💰 Calculated qty: ${qty} ETH (Margin: ${marginUsed.toFixed(
        2
      )} USDT × ${leverage}x = ${positionValue.toFixed(2)} USDT total)`
    );

    //──────────────────────────────────────────────
    // 3️⃣ Set leverage
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
	// 3.8️⃣ Force One-Way Mode for the specific symbol
	//──────────────────────────────────────────────
	try {
	  const modeRes = await sendSignedPOST(
		`${BASE_URL}/v5/position/switch-mode`,
		{ 
		  category: "linear", 
		  symbol: cleanSymbol,   // 🔧 fix: Symbol spezifizieren!
		  mode: 0                // 0 = One-Way
		},
		API_KEY,
		API_SECRET
	  );
	  console.log("🔧 Switch-Mode response:", modeRes.retMsg);
	} catch (err) {
	  console.warn("⚠️ Could not enforce One-Way mode:", err.message);
	}

//──────────────────────────────────────────────
// 4️⃣ Place Market Order + TP/SL (One-Way mode enforced)
//──────────────────────────────────────────────
// TP: ca. +2.72% / SL: -9.00% (Notfall-Stop)
const tp = (side === "Buy" ? price * 1.0272 : price * 0.9728).toFixed(2);
const sl = (side === "Buy" ? price * 0.91 : price * 1.09).toFixed(2); // ← alter Wert

// 🔧 Neuer fester SL = 9 %
const slPct = 0.09;
const slNew = (side === "Buy" ? price * (1 - slPct) : price * (1 + slPct)).toFixed(2);

console.log(`🛡️ Safety SL fixed at ${slPct * 100}% → ${slNew}`);

const orderPayload = {
  category: "linear",
  symbol: cleanSymbol,
  side,
  orderType: "Market",
  qty: qty.toString(),
  timeInForce: "GTC",
  takeProfit: tp,
  stopLoss: slNew,        // ✅ 9% Notfall-SL hier gesetzt
  reduceOnly: false,
  positionIdx: 0,
};


    console.log("🟩 Order Payload (forced One-Way):", orderPayload);

    const orderRes = await sendSignedPOST(
      `${BASE_URL}/v5/order/create`,
      orderPayload,
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
    console.error("Worker Error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

//──────────────────────────────────────────────
// ======= Sign helpers =======
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
// ======= Start Server =======
//──────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`✅ ETH-PeakAlgo Render-Bot listening on port ${PORT}`)
);
