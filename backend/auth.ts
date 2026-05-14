import { NextFunction, Response, Request } from "express";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "./config";

interface JwtPayload {
  id: string;
  username: string;
}

export const auth = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({
      success: false,
      data: null,
      error: "Unauthorized",
    });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    req.user = {
      id: decoded.id,
      username: decoded.username,
    };
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      data: null,
      error: "Unauthorized",
    });
  }
};
