import express from "express";
import { prisma } from "./db";
import { orderSchema, signinSchema, signupSchema } from "./types";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "./config";
import { auth } from "./auth";
import { readBuilderProgram } from "typescript";
import { success } from "zod";

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
  orderId: string;
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
  const { totalQuantity, side, symbol, type, price } = validated.data;
  const userId = req.user!.id;

  if (type === "MARKET") {
    if (side === "BUY") {
      // user wants to Buy
      const totalBuyQuantity = totalQuantity;
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
      let qtyToBeFilled = totalQuantity;
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
          totalBuyQuantity: totalBuyQuantity,
          totalFilled,
          avgPrice: totalFilled > 0 ? totalCostSpent / totalFilled : 0,
        },
      });
    } else if (side === "SELL") {
      const totalSellQuantity = totalQuantity;
      let qtyToBeSold = totalSellQuantity;
      if (!BALANCES[userId]![symbol]) {
        return res.status(400).json({
          success: "false",
          error: `User doesnot have this assest: ${symbol}`,
          data: null,
        });
      }
      const userTotalAssetBalance =
        BALANCES[userId]![symbol]!.total - BALANCES[userId]![symbol]!.locked;

      let totalUSDReceived = 0;
      if (!ORDER_BOOKS[symbol]?.BIDS) {
        return res.status(404).json({
          success: false,
          data: null,
          error: "No BIDS available for this asset",
        });
      }

      const allBidPricesInString = Object.keys(ORDER_BOOKS[symbol].BIDS);
      const allBidPrices = allBidPricesInString.map((priceString) =>
        Number(priceString)
      );

      const sortedBids = allBidPrices.sort((a, b) => b - a);

      let assetBalanceLeft = userTotalAssetBalance;

      for (const price of sortedBids) {
        const bidsAvailableAtThisPrice =
          ORDER_BOOKS[symbol].BIDS[price]!.totalQty;
        const filled = Math.min(
          bidsAvailableAtThisPrice,
          qtyToBeSold,
          assetBalanceLeft
        );

        if (filled === 0) break;

        totalUSDReceived += filled * price;

        // udpateSellerBalancesAndDB(filled,)
        assetBalanceLeft -= filled;
        BALANCES[userId]![symbol].total -= filled;
        qtyToBeSold -= filled;

        if (!BALANCES[userId]!["USD"]) {
          BALANCES[userId]!["USD"] = { locked: 0, total: filled * price };
        } else {
          BALANCES[userId]!["USD"].total += filled * price;
        }

        ORDER_BOOKS[symbol].BIDS[price]!.totalQty -= filled;

        const order = await prisma.order.create({
          data: {
            userId,
            market: symbol,
            price,
            qty: totalSellQuantity,
            type: "MARKET",
            side: "SELL",
            filledQty: filled > 0 ? filled : 0,
            status: "FILLED",
          },
        });

        await prisma.fills.create({
          data: {
            qty: filled,
            side: "SELL",
            type: "MARKET",
            userId,
            price,
            market: symbol,
            originalOrderId: order.id,
          },
        });

        // fulfillBids
        const orders = ORDER_BOOKS[symbol].BIDS[price]!.orders;
        let qtyToBeBought = filled;

        for (let i = 0; i < orders.length; i++) {
          const order = orders[i];
          if (!order) continue;
          const pending = order.qty - order.filledQty;
          const buysFulfilledFromThisOrder = Math.min(pending, qtyToBeBought);

          qtyToBeBought -= buysFulfilledFromThisOrder;
          order.filledQty += buysFulfilledFromThisOrder;

          BALANCES[order.userId]!["USD"]!.locked -=
            buysFulfilledFromThisOrder * price;
          BALANCES[order.userId]!["USD"]!.total -=
            buysFulfilledFromThisOrder * price;

          if (!BALANCES[order.userId]![symbol]) {
            BALANCES[order.userId]![symbol] = {
              locked: 0,
              total: buysFulfilledFromThisOrder,
            };
          } else {
            BALANCES[order.userId]![symbol]!.total +=
              buysFulfilledFromThisOrder;
          }

          if (order.filledQty === order.qty) {
            orders.splice(i, 1);
            i--;
          }
        }

        if (assetBalanceLeft === 0) break;
        if (qtyToBeSold === 0) break;
      }

      const totalSellFills = totalSellQuantity - qtyToBeSold;

      res.status(200).json({
        success: true,
        error: null,
        data: {
          totalSoldQuantity: totalSellQuantity,
          totalSellFills: totalSellQuantity - qtyToBeSold,
          avgPriceOfSell:
            totalSellFills > 0 ? totalUSDReceived / totalSellFills : 0,
        },
      });
    }
  } else if (type === "LIMIT") {
    if (!price) {
      return res.status(400).json({
        success: false,
        data: null,
        error: "Price msut be included",
      });
    }
    if (side === "BUY") {
      const totalBidQuantity = totalQuantity;
      let bidQtyLeft = totalBidQuantity;

      const usdBalance =
        BALANCES[userId]!["USD"]!.total - BALANCES[userId]!["USD"]!.locked;

      if (usdBalance < price * totalBidQuantity) {
        return res.status(400).json({
          success: false,
          data: null,
          error: "Not enough USD balance to place the order",
        });
      }

      BALANCES[userId]!["USD"]!.locked += totalBidQuantity * price;

      // start matching with ASKs <= Bid price
      // when there is no opp ASKS for this asset
      // buy order will sit in the order boook fully.
      if (!ORDER_BOOKS[symbol]) {
        ORDER_BOOKS[symbol] = { ASKS: {}, BIDS: {} };
      }

      if (!ORDER_BOOKS[symbol].ASKS) {
        const order = await createLimitOrderAndUpdateOrderBook(
          price,
          userId,
          totalBidQuantity,
          0,
          symbol,
          "BUY"
        );

        return res.status(200).json({
          success: true,
          error: null,
          data: {
            message: "Order placed",
            order,
          },
        });
      }

      const askPriceStrings = Object.keys(ORDER_BOOKS[symbol].ASKS);
      const askPrices = askPriceStrings.map((p) => Number(p));
      const sortedAskPrices = askPrices.sort((a, b) => a - b);

      let filled = 0;

      for (const askPrice of sortedAskPrices) {
        // for each askPrice if the askPrice is > bidprice, the remaining quantity will sit in Bids
        if (askPrice > price) {
          const order = await createLimitOrderAndUpdateOrderBook(
            price,
            userId,
            totalBidQuantity,
            filled,
            symbol,
            "BUY"
          );

          return res.status(200).json({
            success: true,
            error: null,
            data: {
              message: "Limit order placed successfully",
              filledQty: filled,
              position: {
                quantity: totalBidQuantity - filled,
                orderId: order.id,
                createdAt: order.createdAt,
              },
            },
          });
        }

        const orders = ORDER_BOOKS[symbol].ASKS[askPrice]!.orders;

        for (let i = 0; i < orders.length; i++) {
          const order = orders[i];

          if (!order) continue;

          const pending = order.qty - order.filledQty;
          const filledFromThisOrder = Math.min(pending, bidQtyLeft);

          ORDER_BOOKS[symbol].ASKS[askPrice]!.totalQty -= filledFromThisOrder;
          bidQtyLeft -= filledFromThisOrder;
          filled += filledFromThisOrder;
          order.filledQty += filledFromThisOrder;

          // fill the bids

          BALANCES[userId]!["USD"]!.locked -= filledFromThisOrder * price;
          BALANCES[userId]!["USD"]!.total -= filledFromThisOrder * askPrice;

          if (!BALANCES[userId]![symbol]) {
            BALANCES[userId]![symbol] = {
              locked: 0,
              total: filledFromThisOrder,
            };
          } else {
            BALANCES[userId]![symbol].total += filledFromThisOrder;
          }

          const buyOrder = await prisma.order.create({
            data: {
              userId,
              market: symbol,
              price: askPrice,
              qty: totalBidQuantity,
              type: "LIMIT",
              side: "BUY",
              filledQty: filledFromThisOrder,
              status: "FILLED",
            },
          });

          await prisma.fills.create({
            data: {
              qty: filledFromThisOrder,
              side: "BUY",
              type: "LIMIT",
              userId,
              price: askPrice,
              market: symbol,
              originalOrderId: buyOrder.id,
            },
          });

          BALANCES[order.userId]![symbol]!.locked -= filledFromThisOrder;
          BALANCES[order.userId]![symbol]!.total -= filledFromThisOrder;

          if (!BALANCES[order.userId]!["USD"]) {
            BALANCES[order.userId]!["USD"] = {
              locked: 0,
              total: askPrice * filledFromThisOrder,
            };
          } else {
            BALANCES[order.userId]!["USD"]!.total +=
              askPrice * filledFromThisOrder;
          }

          // delete the price level if the complete order gets filled
          if (order.filledQty === order.qty) {
            orders.splice(i, 1);
            i--;
          }
        }

        if (ORDER_BOOKS[symbol].ASKS[askPrice]!.totalQty === 0) {
          delete ORDER_BOOKS[symbol].ASKS[askPrice];
        }

        if (bidQtyLeft === 0) break;
        if (filled === totalBidQuantity) break;
      }

      if (bidQtyLeft > 0) {
        const order = await createLimitOrderAndUpdateOrderBook(
          price,
          userId,
          totalBidQuantity,
          filled,
          symbol,
          "BUY"
        );
      }

      res.status(200).json({
        success: true,
        error: null,
        data: {
          message:
            bidQtyLeft === 0
              ? "Fully filled"
              : "Partially filled, remaining resting in book",
          totalFilled: filled,
          remaining: bidQtyLeft,
        },
      });
    } else if (side === "SELL") {
    }
  }
});

async function createLimitOrderAndUpdateOrderBook(
  price: number,
  userId: string,
  totalOrderquantity: number,
  filled: number,
  symbol: string,
  side: "BUY" | "SELL"
) {
  const order = await prisma.order.create({
    data: {
      userId,
      market: symbol,
      price,
      qty: totalOrderquantity,
      type: "LIMIT",
      side,
      filledQty: filled,
      status: "OPEN",
    },
  });

  if (filled > 0) {
    await prisma.fills.create({
      data: {
        qty: filled,
        side,
        type: "LIMIT",
        userId,
        price,
        market: symbol,
        originalOrderId: order.id,
      },
    });
  }

  // place them in the order books BIDS for this price
  if (!ORDER_BOOKS[symbol]) {
    ORDER_BOOKS[symbol] = { ASKS: {}, BIDS: {} };
  }

  const bookSide = side === "BUY" ? "BIDS" : "ASKS";

  if (!ORDER_BOOKS[symbol][bookSide][price]) {
    ORDER_BOOKS[symbol][bookSide][price] = { totalQty: 0, orders: [] };
  }
  ORDER_BOOKS[symbol][bookSide][price].totalQty += totalOrderquantity - filled;
  ORDER_BOOKS[symbol][bookSide][price].orders.push({
    userId,
    qty: totalOrderquantity,
    filledQty: filled,
    orderId: order.id,
    createdAt: new Date(),
  });
  return order;
}

app.listen(3000, () => console.log(`Backend started on PORT:3000`));
