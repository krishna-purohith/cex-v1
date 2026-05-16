import z from "zod";

export const signupSchema = z.object({
  username: z.string(),
  password: z.string(),
});
export const signinSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export const orderSchema = z.object({
  side: z.enum(["SELL", "BUY"]),
  type: z.enum(["MARKET", "LIMIT"]),
  symbol: z.string(),
  price: z.number().optional(),
  totalBuyQuantity: z.number(),
});
