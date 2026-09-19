import nodemailer from 'nodemailer';

export type EmailAttachment = { readonly filename: string; readonly content: Uint8Array; readonly contentType: string };

/** One rendered email. */
export type EmailMessage = {
  readonly to: string; readonly subject: string; readonly text: string; readonly html: string;
  readonly attachments?: readonly EmailAttachment[] | undefined;
};

/** Sending, behind an interface: SMTP everywhere real, in memory in tests (ADR-0022). */
export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

/** nodemailer over SMTP, configured only by SMTP_URL and MAIL_FROM — switching provider is configuration. */
export function createSmtpMailer(smtpUrl: string, from: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(message) {
      await transport.sendMail({
        from, to: message.to, subject: message.subject, text: message.text, html: message.html,
        attachments: message.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType })),
      });
    },
  };
}

export function createMemoryMailer() {
  const sent: EmailMessage[] = [];
  let failNext = 0;
  const mailer: Mailer = {
    send(message) {
      if (failNext > 0) { failNext -= 1; return Promise.reject(new Error('simulated SMTP failure')); }
      sent.push(message);
      return Promise.resolve();
    },
  };
  return { ...mailer, sent, failNextSends: (n: number) => { failNext = n; }, clear: () => { sent.length = 0; failNext = 0; } };
}
