/**
 * Notifications service — outbound email.
 *
 * Implementation strategy:
 *  - Every send is recorded in `notifications` for audit and retry.
 *  - In development (or when SENDGRID_API_KEY is unset), email is logged to the
 *    server log instead of being sent. The DB row is still created so we can
 *    verify the call site triggered correctly.
 *  - In production with SENDGRID_API_KEY set, we POST to SendGrid's v3 API.
 */
import { v4 as uuid } from 'uuid';
import { eq } from 'drizzle-orm';
import { env } from '@/config/env.js';
import { logger } from '@/config/logger.js';
import { db, schema } from '@/db/index.js';

export interface SendEmailInput {
  toEmail: string;
  subject: string;
  body: string;
  kind: string;
  userId?: string | null;
  relatedTaskId?: string | null;
}

export async function sendEmail(input: SendEmailInput): Promise<{ id: string; sent: boolean }> {
  const id = uuid();
  const now = new Date();

  await db.insert(schema.notifications).values({
    id,
    userId: input.userId ?? null,
    toEmail: input.toEmail,
    kind: input.kind,
    subject: input.subject,
    body: input.body,
    relatedTaskId: input.relatedTaskId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  if (!env.SENDGRID_API_KEY) {
    logger.info(
      {
        notification: {
          id,
          to: input.toEmail,
          subject: input.subject,
          kind: input.kind,
          previewBody: input.body.length > 500 ? input.body.slice(0, 500) + '…' : input.body,
        },
      },
      'Email send skipped (no SENDGRID_API_KEY); logged only',
    );
    return { id, sent: false };
  }

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: input.toEmail }] }],
        from: { email: env.EMAIL_FROM, name: 'CPCQC Engagement Tracker' },
        subject: input.subject,
        content: [{ type: 'text/plain', value: input.body }],
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      logger.error({ status: res.status, errorText }, 'SendGrid send failed');
      await db
        .update(schema.notifications)
        .set({ error: `SendGrid ${res.status}: ${errorText.slice(0, 500)}`, updatedAt: new Date() })
        .where(eqId(id));
      return { id, sent: false };
    }

    await db
      .update(schema.notifications)
      .set({ sentAt: new Date(), updatedAt: new Date() })
      .where(eqId(id));
    return { id, sent: true };
  } catch (err) {
    logger.error({ err }, 'SendGrid send threw');
    await db
      .update(schema.notifications)
      .set({
        error: err instanceof Error ? err.message.slice(0, 500) : 'unknown error',
        updatedAt: new Date(),
      })
      .where(eqId(id));
    return { id, sent: false };
  }
}

function eqId(id: string) {
  return eq(schema.notifications.id, id);
}
