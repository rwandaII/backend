import { Resend } from 'resend';
import { config } from '../config.js';

const resend = new Resend(config.resend.apiKey);

async function send(to: string, subject: string, html: string): Promise<void> {
  const { error } = await resend.emails.send({
    from: config.resend.fromEmail,
    to,
    subject,
    html,
  });
  if (error) throw new Error(`Resend: ${error.message}`);
}

export async function sendVerificationEmail(to: string, name: string, code: string): Promise<void> {
  await send(
    to,
    `${config.storeName} - verify your email`,
    `<p>Hi ${escapeHtml(name)},</p>
     <p>Your verification code is:</p>
     <p style="font-size:28px;font-weight:700;letter-spacing:4px">${escapeHtml(code)}</p>
     <p>This code expires in 15 minutes. If you didn't create an account, ignore this email.</p>`
  );
}

export async function sendPasswordResetEmail(to: string, name: string, resetLink: string): Promise<void> {
  await send(
    to,
    `${config.storeName} - reset your password`,
    `<p>Hi ${escapeHtml(name)},</p>
     <p>Click the link below to set a new password. It expires in 30 minutes.</p>
     <p><a href="${resetLink}">${resetLink}</a></p>
     <p>If you didn't request this, you can safely ignore this email.</p>`
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
