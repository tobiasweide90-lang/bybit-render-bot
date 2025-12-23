/**
 * ETHUSDT Render Bot – TradingView → Bybit (REAL)
 * Market Entry + TP/SL + dynamic 95% sizing + leverage
 * Handles .P symbols, One-Way/Hedge detection, and 0.01 ETH step rounding
 *
 * FIX (Flip issue):
 * - Robust position detection (do not assume list[0])
 * - Cancel resting orders first
 * - Close opposite position with reduceOnly market
 * - Poll until position is flat before opening new position (prevents race condition)
 * - Hard-fail on Bybit retCode != 0 for create order
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
    if (data.secret !== SECRET) {
      return res.status(403).json({ ok: false, error: "Unauthorized" });
    }

    const { event, symbol, price, lvg } = data;
    if (!event || !symbol || !price) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }

    //──────────────────────────────────────────────
    // Determine trade side
    //──────────────────────────────────────────────
    const side = event.includes("LONG")
      ? "Buy"
      : event.includes("SHORT")
      ? "Sell"
      : null;

    if (!side) {
      return res.status(400).json({ ok: false, error: "Invalid event" });
    }

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

    if (!API_KEY || !API_SECRET) {
      return res.status(500).json({ ok: false, error: "Missing BYBIT API credentials" });
    }

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
      accountType: ACCOUNT_TYPE,
    });
    console.log("===========================");

    //──────────────────────────────────────────────
    // Helpers (sleep, position fetch, cancel orders)
    //──────────────────────────────────────────────
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function fetchPositions() {
      const posRes = await sendSignedGETRequest(
        `${BASE_URL}/v5/position/list`,
        { category: "linear", symbol: cleanSymbol },
        API_KEY,
        API_SECRET
      );
      return posRes;
    }

    function pickActivePosition(posRes) {
      const list = posRes?.result?.list || [];
      // Find any active position with size > 0
      const active = list.find((p) => Number(p.size) > 0);
      return { list, active };
    }

    async function cancelAllOpenOrders() {
      const openOrders = await sendSignedGETRequest(
        `${BASE_URL}/v5/order/realtime`,
        { category: "linear", symbol: cleanSymbol },
        API_KEY,
        API_SECRET
      );

      const orders = openOrders?.result?.list || [];
      if (!orders.length) return 0;

      for (const o of orders) {
        const cancelRes = await sendSignedPOST(
          `${BASE_URL}/v5/order/cancel`,
          { category: "linear", symbol: cleanSymbol, orderId: o.orderId },
          API_KEY,
          API_SECRET
        );
        // Do not hard-fail cancellations; log instead
        if (cancelRes?.retCode !== 0) {
          console.warn("⚠️ Cancel failed:", cancelRes?.retMsg, "orderId=", o.orderId);
        }
      }
      return orders.length;
    }

    async function ensureFlatIfOpposite(targetSide) {
      // Cancel orders first (TP/SL leftovers are common)
      const cancelled = await cancelAllOpenOrders();
      if (cancelled) console.log(`🧹 ${cancelled} old orders cancelled.`);

      const posRes = await fetchPositions();
      if (posRes?.retCode !== 0) {
        throw new Error(`Position list error: ${posRes?.retMsg}`);
      }

      const { active } = pickActivePosition(posRes);

      if (!active) {
        console.log("ℹ️ No active position detected. Good to open new one.");
        return { wasOpposite: false, closed: false };
      }

      const currentSide = active.side; // "Buy" or "Sell"
      const currentSize = Number(active.size);

      console.log("📌 Active position detected:", { currentSide, currentSize });

      const isOpposite =
        (targetSide === "Buy" && currentSide === "Sell") ||
        (targetSide === "Sell" && currentSide === "Buy");

      if (!isOpposite) {
        console.log("ℹ️ Existing position is same-side (or aligned). No flip-close needed.");
        return { wasOpposite: false, closed: false };
      }

      console.log(`🧹 Closing opposite position (${currentSide}) before flipping...`);

      const closeRes = await sendSignedPOST(
        `${BASE_URL}/v5/order/create`,
        {
          category: "linear",
          symbol: cleanSymbol,
          side: currentSide === "Buy" ? "Sell" : "Buy",
          orderType: "Market",
          qty: currentSize.toString(),
          reduceOnly: true,
          timeInForce: "IOC",
          positionIdx: 0,
        },
        API_KEY,
        API_SECRET
      );

      console.log("✅ Close order response:", JSON.stringify(closeRes, null, 2));

      if (closeRes?.retCode !== 0) {
        throw new Error(`Close opposite failed: ${closeRes?.retMsg}`);
      }

      // Poll until position is flat (prevents race condition)
      let flat = false;
      for (let i = 0; i < 12; i++) {
        await sleep(450);
        const posRes2 = await fetchPositions();
        const { active: active2 } = pickActivePosition(posRes2);
        if (!active2 || Number(active2.size) === 0) {
          flat = true;
          break;
        }
      }

      if (!flat) {
        throw new Error("Flip abort: opposite position did not close in time (still open).");
      }

      console.log("✅ Position is flat after close. Proceeding...");
      return { wasOpposite: true, closed: true };
    }

    //──────────────────────────────────────────────
    // 1️⃣ Fetch USDT balance
    //──────────────────────────────────────────────
    const balanceRes = await sendSignedGETRequest(
      `${BASE_URL}/v5/account/wallet-balance`,
      { accountType: ACCOUNT_TYPE, coin: "USDT" },
      API_KEY,
      API_SECRET
    );

    if (balanceRes.retCode !== 0) {
      throw new Error(`Balance error: ${balanceRes.retMsg}`);
    }

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

    if (usdtBalance <= 0) {
      throw new Error("No available USDT balance or invalid API response.");
    }

    //──────────────────────────────────────────────
    // 2️⃣ Calculate position size (95 % × leverage)
    //──────────────────────────────────────────────
    const marginUsed = usdtBalance * marginFraction;
    const positionValue = marginUsed * leverage;
    let qty = positionValue / Number(price);

    // Mindestgröße & Mindest-Nominalwert (10 USDT)
    qty = Math.max(0.01, Math.min(qty, 100));
    let nominal = qty * Number(price);
    if (nominal < 10) {
      qty = 10 / Number(price);
    }

    // 🔧 ETH StepSize = 0.01 → runden
    qty = Math.floor(qty * 100) / 100;

    console.log(
      `🔢 Adjusted qty = ${qty} ETH (≈ ${(qty * Number(price)).toFixed(2)} USDT nominal)`
    );
    console.log(
      `💰 Calculated qty: ${qty} ETH (Margin: ${marginUsed.toFixed(2)} USDT × ${leverage}x = ${positionValue.toFixed(
        2
      )} USDT total)`
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
          symbol: cleanSymbol,
          mode: 0, // 0 = One-Way
        },
        API_KEY,
        API_SECRET
      );
      console.log("🔧 Switch-Mode response:", modeRes.retMsg);
    } catch (err) {
      console.warn("⚠️ Could not enforce One-Way mode:", err.message);
    }

    //──────────────────────────────────────────────
    // 3.9️⃣ Cleanup + Flip (robust)
    //──────────────────────────────────────────────
    console.log("🧹 Running robust flip cleanup (cancel orders → close opposite → wait flat)...");
    await ensureFlatIfOpposite(side);

    //──────────────────────────────────────────────
    // 4️⃣ Place Market Order + TP/SL (One-Way mode enforced)
    //──────────────────────────────────────────────

    // TP: +2.72 %
    const tp = (side === "Buy" ? Number(price) * 1.0272 : Number(price) * 0.9728).toFixed(2);

    // Fester Notfall-SL = 21 %
    const slPct = 0.21;
    const sl = (
      side === "Buy"
        ? Number(price) * (1 - slPct) // 21 % unter Entry
        : Number(price) * (1 + slPct) // 21 % über Entry
    ).toFixed(2);

    console.log(`🛡️ Safety SL fixed at ${slPct * 100}% → ${sl}`);

    const orderPayload = {
      category: "linear",
      symbol: cleanSymbol,
      side,
      orderType: "Market",
      qty: qty.toString(),
      timeInForce: "GTC",
      takeProfit: tp,
      stopLoss: sl, // ✅ 21% Notfall-SL hier gesetzt
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

    // Hard-fail on Bybit errors so you SEE it immediately
    if (orderRes?.retCode !== 0) {
      throw new Error(`Order create failed: ${orderRes?.retMsg}`);
    }

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

  // Safer parse
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Bybit GET JSON parse error. Raw: ${text}`);
  }
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

  // Safer parse
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Bybit POST JSON parse error. Raw: ${text}`);
  }
}

//──────────────────────────────────────────────
// ======= Start Server =======
//──────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ ETH-PeakAlgo Render-Bot listening on port ${PORT}`));
