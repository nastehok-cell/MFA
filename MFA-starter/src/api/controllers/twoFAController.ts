import CustomError from '../../classes/CustomError';
import { NextFunction, Request, Response } from 'express';
import * as OTPAuth from 'otpauth';
import QRcode from 'qrcode';
import jwt from 'jsonwebtoken';
import twoFAModel from '../models/twoFAModel';

const setupTwoFA = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authUrl = process.env.AUTH_URL;
    if (!authUrl) {
      throw new CustomError('AUTH_URL is missing', 500);
    }

    const register = await fetch(`${authUrl}/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req.body),
    });

    if (!register.ok) {
      throw new CustomError('User registration failed', 400);
    }

    const user = (await register.json()) as { id: number; email: string };
    const secret = new OTPAuth.Secret();
    const totp = new OTPAuth.TOTP({
      issuer: 'My app',
      label: user.email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });

    const otpauthUrl = totp.toString();

    await twoFAModel.findOneAndUpdate(
      { email: user.email },
      {
        userId: user.id,
        email: user.email,
        twoFactorSecret: secret.base32,
        twoFactorEnabled: false,
      },
      { upsert: true, new: true },
    );

    const qrCodeDefault = await QRcode.toDataURL(otpauthUrl);

    return res.status(201).json({
      message: '2FA setup successful',
      qrCode: qrCodeDefault,
    });
  } catch (error) {
    next(new CustomError((error as Error).message, 500));
  }
};

const verifyTwoFA = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { email, code } = req.body as { email: string; code: string };

  try {
    const authUrl = process.env.AUTH_URL;
    if (!authUrl) {
      throw new CustomError('AUTH_URL is missing', 500);
    }

    const twoFAData = await twoFAModel.findOne({ email });

    if (!twoFAData) {
      throw new CustomError('2FA setup not found', 404);
    }

    const secret = OTPAuth.Secret.fromBase32(twoFAData.twoFactorSecret);
    const totp = new OTPAuth.TOTP({
      issuer: 'My app',
      label: email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });

    const delta = totp.validate({
      token: code,
      window: 1,
    });

    if (delta === null) {
      throw new CustomError('Invalid 2FA code', 401);
    }

    const userResponse = await fetch(`${authUrl}/users/${twoFAData.userId}`);

    if (!userResponse.ok) {
      throw new CustomError('User not found', 404);
    }

    const user = (await userResponse.json()) as { id: number; email: string };

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
      },
      process.env.JWT_SECRET as string,
      {
        expiresIn: '1h',
      },
    );

    await twoFAModel.findOneAndUpdate({ email }, { twoFactorEnabled: true });

    return res.status(200).json({
      message: '2FA verification successful',
      token,
    });
  } catch (error) {
    if (error instanceof CustomError) {
      return next(error);
    }

    next(new CustomError((error as Error).message, 500));
  }
};

export { setupTwoFA, verifyTwoFA };