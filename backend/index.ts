import express from "express";
import { prisma } from "./db";
import { orderSchema, signinSchema, signupSchema } from "./types";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "./config";
import { auth } from "./auth";

const app = express();
app.use(express.json());

type Balance = Record<
  string,
  Record<string, { total: number; locked: number }>
>;

const BALANCES: Balance = {};

interface Order {
  userId: string;
  qty: number;
  filledQty: number;
  orderId: number;
  createdAt: Date;
}
type Bid = Record<number, { totalQty: number; orders: Order[] }>;
type Ask = Record<number, { totalQty: number; orders: Order[] }>;

type OrderBook = Record<
  string,
  {
    BIDS: Bid;
    ASKS: Ask;
  }
>;

const ORDER_BOOKS: OrderBook = {};

app.post("/signup", async (req, res) => {
  const validated = signupSchema.safeParse(req.body);
  if (!validated.success) {
    res.status(400).json({
      success: false,
      data: null,
      error: "Username and Password required",
    });
    return;
  }
  const { username, password } = validated.data;
  try {
    const existing = await prisma.user.findUnique({
      where: { username },
    });
    if (existing) {
      res.status(400).json({
        success: false,
        data: null,
        error: "User already registered. Please signin",
      });
      return;
    }
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: { username, password: hashedPassword },
      select: { username: true, id: true },
    });

    const userId = user.id;
    BALANCES[userId] = { USD: { total: 0, locked: 0 } };

    res.status(201).json({
      success: true,
      error: null,
      data: { message: "Signup successful", balance: BALANCES[userId] },
    });
  } catch (error) {
    console.error(error);
  }
});

app.post("/signin", async (req, res) => {
  const validated = signinSchema.safeParse(req.body);
  if (!validated.success) {
    res.status(400).json({
      success: false,
      data: null,
      error: "Username and Password required",
    });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { username: validated.data.username },
    });
    if (!user) {
      res.status(400).json({
        success: false,
        data: null,
        error: "User doesnot exist. Please signup",
      });
      return;
    }
    const passwordMatched = await bcrypt.compare(
      validated.data.password,
      user.password
    );
    if (!passwordMatched) {
      res.status(401).json({
        success: false,
        data: null,
        error: "Invalid credentails",
      });
      return;
    }
    const token = jwt.sign(
      { id: user.id, username: validated.data.username },
      JWT_SECRET
    );
    res.status(200).json({
      success: true,
      data: { token: token },
      error: null,
    });
  } catch (error) {
    console.error(error);
  }
});

app.get("/me", auth, (req, res) => {
  res.status(200).json({
    success: true,
    error: null,
    data: req.user!.username,
  });
});

async function updateBuyerBalancesAndDB(
  userId: string,
  filled: number,
  price: number,
  symbol: string,
  totalBuyQuantity: number
) {
  BALANCES[userId]!["USD"]!.total -= filled * price;
  if (!BALANCES[userId]![symbol]) {
    BALANCES[userId]![symbol] = { total: filled, locked: 0 };
  } else {
    BALANCES[userId]![symbol].total += filled;
  }

  ORDER_BOOKS[symbol]!.ASKS[price]!.totalQty -= filled;

  const order = await prisma.order.create({
    data: {
      userId,
      market: symbol,
      price: price,
      qty: totalBuyQuantity,
      type: "MARKET",
      side: "BUY",
      filledQty: filled,
      status: "FILLED",
    },
  });
  await prisma.fills.create({
    data: {
      qty: filled,
      side: "BUY",
      type: "MARKET",
      userId,
      price,
      market: symbol,
      originalOrderId: order.id,
    },
  });
}

async function fulfillAsks(
  orders: Order[],
  askQtyToBeFulfilled: number,
  price: number,
  symbol: string
) {
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    if (!order) continue;
    const pending = order.qty - order.filledQty;

    const filledFromThisOrder = Math.min(pending, askQtyToBeFulfilled);

    askQtyToBeFulfilled -= filledFromThisOrder;
    order.filledQty += filledFromThisOrder;

    if (order.qty === order.filledQty) {
      orders.splice(i, 1);
      i--;
    }

    if (!BALANCES[order.userId]!["USD"]) {
      BALANCES[order.userId]!["USD"] = {
        locked: 0,
        total: filledFromThisOrder * price,
      };
    } else {
      BALANCES[order.userId]!["USD"]!.total += filledFromThisOrder * price;
    }
    BALANCES[order.userId]![symbol]!.locked -= filledFromThisOrder;
    BALANCES[order.userId]![symbol]!.total -= filledFromThisOrder;

    if (askQtyToBeFulfilled === 0) break;
  }
}

app.post("/order", auth, async (req, res) => {
  const validated = orderSchema.safeParse(req.body);
  if (!validated.success) {
    return res
      .status(400)
      .json({ success: false, data: null, error: "All fields requried" });
  }
  const { totalBuyQuantity, side, symbol, type } = validated.data;
  const userId = req.user!.id;

  if (type === "MARKET") {
    if (side === "BUY") {
      // user wants to Buy
      const USDBalance =
        BALANCES[userId]!["USD"]!.total - BALANCES[userId]!["USD"]!.locked;

      if (!ORDER_BOOKS[symbol]) {
        return res.status(404).json({
          success: false,
          data: null,
          error: "Empty order book",
        });
      }
      // sort the Asks for this asset
      const asks = ORDER_BOOKS[symbol].ASKS;
      const priceStrings = Object.keys(asks);
      const prices = priceStrings.map((p) => Number(p));
      const sortedPrices = prices.sort((a, b) => a - b);

      let USDBalanceLeft = USDBalance;
      let qtyToBeFilled = totalBuyQuantity;
      let totalCostSpent = 0;

      // iterate though the sortedPrices n then try to fill the order quantity.
      for (const price of sortedPrices) {
        const availableAskQty = asks[price]!.totalQty;

        if (qtyToBeFilled <= availableAskQty) {
          // complete market order will be filled if user has enough USD Balance
          const filled = qtyToBeFilled;
          const cost = filled * price;

          if (USDBalanceLeft >= cost) {
            updateBuyerBalancesAndDB(
              userId,
              filled,
              price,
              symbol,
              totalBuyQuantity
            );

            USDBalanceLeft -= cost;

            let askQty = filled;
            totalCostSpent += filled * price;
            const orders = ORDER_BOOKS[symbol]!.ASKS[price]!.orders;

            fulfillAsks(orders, askQty, price, symbol);

            qtyToBeFilled -= filled;
          } else {
            // this is the case wher user has less USD than qtyToBeFilled * price
            // calculate how many qty he can buy with the USDBalance cx has

            const qtyUserCanAfford = Math.floor(USDBalanceLeft / price);

            const filled = qtyUserCanAfford;
            if (filled === 0) break;

            updateBuyerBalancesAndDB(
              userId,
              filled,
              price,
              symbol,
              totalBuyQuantity
            );

            qtyToBeFilled = qtyToBeFilled - filled;
            USDBalanceLeft -= filled * price;
            totalCostSpent += filled * price;

            let askQty = filled;
            const orders = ORDER_BOOKS[symbol]!.ASKS[price]?.orders;
            if (!orders) continue;
            fulfillAsks(orders, askQty, price, symbol);
          }
        } else {
          // You now have the case where qtyToBeFilled > availableAskQty at that price
          // Here qtyToBeFilled > availableAskQty
          const cost = availableAskQty * price;

          if (USDBalanceLeft >= cost) {
            const filled = availableAskQty;
            qtyToBeFilled -= filled;
            updateBuyerBalancesAndDB(
              userId,
              filled,
              price,
              symbol,
              totalBuyQuantity
            );
            USDBalanceLeft -= cost;
            totalCostSpent += cost;
            const orders = ORDER_BOOKS[symbol]!.ASKS[price]?.orders;
            if (!orders) continue;
            fulfillAsks(orders, filled, price, symbol);
            delete ORDER_BOOKS[symbol].ASKS[price];
          } else {
            // Case where user has less USD
            const filled = Math.floor(USDBalanceLeft / price);
            if (filled === 0) break;
            qtyToBeFilled -= filled;
            USDBalanceLeft -= filled * price;
            totalCostSpent += filled * price;
            updateBuyerBalancesAndDB(
              userId,
              filled,
              price,
              symbol,
              totalBuyQuantity
            );
            const orders = ORDER_BOOKS[symbol].ASKS[price]?.orders;
            if (!orders) {
              continue;
            }
            fulfillAsks(orders, filled, price, symbol);
          }
        }
        if (USDBalanceLeft === 0) break;
        if (qtyToBeFilled === 0) break;
      }
      const totalFilled = totalBuyQuantity - qtyToBeFilled;
      res.status(200).json({
        success: true,
        error: null,
        data: {
          totalBuyQuantity,
          totalFilled,
          avgPrice: totalFilled > 0 ? totalCostSpent / totalFilled : 0,
        },
      });
    } else if (side === "SELL") {
    }
  }
});

app.listen(3000, () => console.log(`Backend started on PORT:3000`));
