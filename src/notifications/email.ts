import { Resend } from 'resend';
import { config } from '../config.js';

// Constructed lazily: Resend's constructor throws synchronously when the key
// is empty, and doing that at module load would crash the whole process on
// boot if RESEND_API_KEY isn't set. Deferring it means a missing key only
// breaks email sending (as config.ts already warns), not the entire server.
let resend: Resend | null = null;
function getClient(): Resend {
  if (!config.resend.apiKey) {
    throw new Error('RESEND_API_KEY is not set - cannot send email.');
  }
  if (!resend) resend = new Resend(config.resend.apiKey);
  return resend;
}

async function send(to: string, subject: string, html: string): Promise<void> {
  const { error } = await getClient().emails.send({
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
