import express from "express";
import { prisma } from "./db";
import { orderSchema, signinSchema, signupSchema } from "./types";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "./config";
import { auth } from "./auth";

const app = express();
app.use(express.json());

type Balance = Record<string, Record<string, { total: number; locked: number }>>;

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

app.post("/order", auth, (req, res) => {
  const validated = orderSchema.safeParse(req.body);
  if (!validated.success) {
    return res
      .status(400)
      .json({ success: false, data: null, error: "All fields requried" });
  }
  const { qty, side, symbol, type } = validated.data;
  const userId = req.user!.id;
  if (type === "MARKET") {
    if (side === "BUY") {
      // check if USD balance is >= qty * price
      const userUSDBalance =
        BALANCES[userId]!.USD.total - BALANCES[userId]!.USD.locked;

      ORDER_BOOKS[symbol]?.ASKS[]

      // orderBook has ask for this symbol

      // check if ask quantity is >= bid quantity, if its less partial fill n remaining order cancell.
      //
    } else if (side === "SELL") {
    }
  }
});

app.listen(3000, () => console.log(`Backend started on PORT:3000`));
