import africastalking from 'africastalking';
import { config } from '../config.js';

const at = africastalking({
  apiKey: config.africastalking.apiKey,
  username: config.africastalking.username,
});
const smsClient = at.SMS;

async function send(to: string, message: string): Promise<void> {
  await smsClient.send({
    to: [to],
    message,
    ...(config.africastalking.senderId ? { from: config.africastalking.senderId } : {}),
  });
}

export async function sendVerificationSms(to: string, code: string): Promise<void> {
  await send(to, `${config.storeName}: your verification code is ${code}. It expires in 15 minutes.`);
}

export async function sendPasswordResetSms(to: string, code: string): Promise<void> {
  await send(to, `${config.storeName}: your password reset code is ${code}. It expires in 30 minutes.`);
}
