import type { EmailMessage } from './mailer';

/**
 * Email templates, in the recipient's language (I18N-001). Emails are the one
 * place text is built on the server; interface text stays in the web app's
 * message files. Arabic renders right-to-left.
 */
export type EmailTemplate = 'password-reset' | 'delivery-document' | 'ceiling-breached';
export type Locale = 'en' | 'ar';

/** A stored file to attach, fetched when the email is sent (DOC-003). */
export type AttachmentRef = { readonly filename: string; readonly storageKey: string; readonly contentType: string };
type Rendered = Omit<EmailMessage, 'to' | 'attachments'> & { readonly attachments?: readonly AttachmentRef[] };
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function layout(locale: Locale, bodyHtml: string): string {
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  return `<!doctype html><html lang="${locale}" dir="${dir}"><body style="margin:0;background:#f5f5f4;font-family:Arial,Tahoma,sans-serif;color:#1c1917">
<div style="max-width:520px;margin:24px auto;background:#fff;border:1px solid #e7e5e4;border-radius:8px;padding:24px;text-align:start">${bodyHtml}</div></body></html>`;
}

const PASSWORD_RESET = {
  en: {
    subject: 'Reset your Green Skill Agro password',
    lines: (name: string) => [`Hello ${name},`, 'Someone asked to reset the password for your Green Skill Agro account. If it was you, use the link below — it works once and expires in 30 minutes.'],
    button: 'Choose a new password',
    ignore: "If you didn't ask for this, ignore this email; your password stays as it is.",
  },
  ar: {
    subject: 'إعادة تعيين كلمة المرور في غرين سكيل أغرو',
    lines: (name: string) => [`مرحباً ${name}،`, 'طلب أحدهم إعادة تعيين كلمة المرور لحسابك في غرين سكيل أغرو. إن كنت أنت، فاستخدم الرابط أدناه — يعمل مرة واحدة وتنتهي صلاحيته خلال 30 دقيقة.'],
    button: 'اختر كلمة مرور جديدة',
    ignore: 'إن لم تطلب ذلك، فتجاهل هذه الرسالة؛ وستبقى كلمة المرور كما هي.',
  },
} as const;

/**
 * DOC-003: the store may read either language, so both are in every copy —
 * the sender's first. Words only; the document itself is the attachment.
 */
const DELIVERY_DOCUMENT = {
  en: {
    subject: (n: string) => `Delivery document ${n}`,
    lines: (p: Readonly<Record<string, string>>) => [
      `Hello ${p.store ?? ''},`,
      `Attached is delivery document ${p.number ?? ''} from Green Skill Agro for goods delivered by ${p.seller ?? ''}, totalling ${p.total ?? ''} SAR.`,
      'This is not a tax invoice. It is an unofficial record of goods delivered.',
    ],
  },
  ar: {
    subject: (n: string) => `سند تسليم ${n}`,
    lines: (p: Readonly<Record<string, string>>) => [
      `مرحباً ${p.store ?? ''}،`,
      `مرفق سند التسليم ${p.number ?? ''} من غرين سكيل أغرو للبضاعة التي سلّمها ${p.seller ?? ''}، بإجمالي ${p.total ?? ''} ر.س.`,
      'هذه ليست فاتورة ضريبية، وإنما سجل غير رسمي بالبضاعة المسلّمة.',
    ],
  },
} as const;

/** LIM-002: the seller's warning, in their own language. Nothing is blocked (LIM-005). */
const CEILING_BREACHED = {
  en: {
    subject: 'You are over your limit',
    lines: (p: Readonly<Record<string, string>>) => [
      `Hello ${p.name ?? ''},`,
      p.kind === 'CASH_IN_HAND'
        ? `You are holding ${p.amount ?? ''} SAR in cash, above your limit of ${p.ceiling ?? ''} SAR. Please bank it or hand it to a manager.`
        : `The stock on your vehicle is worth ${p.amount ?? ''} SAR, above your limit of ${p.ceiling ?? ''} SAR. Please return some to the warehouse.`,
      'You can keep working as usual; this is a reminder, not a block.',
    ],
  },
  ar: {
    subject: 'تجاوزت الحد المسموح به',
    lines: (p: Readonly<Record<string, string>>) => [
      `مرحباً ${p.name ?? ''}،`,
      p.kind === 'CASH_IN_HAND'
        ? `بحوزتك ${p.amount ?? ''} ر.س. نقدًا، وهو أعلى من حدك البالغ ${p.ceiling ?? ''} ر.س. يرجى إيداعه أو تسليمه إلى مدير.`
        : `قيمة المخزون في مركبتك ${p.amount ?? ''} ر.س.، وهي أعلى من حدك البالغ ${p.ceiling ?? ''} ر.س. يرجى إعادة بعضه إلى المستودع.`,
      'يمكنك متابعة عملك كالمعتاد؛ هذا تنبيه وليس منعًا.',
    ],
  },
} as const;

export function renderEmail(template: EmailTemplate, locale: Locale, params: Readonly<Record<string, string>>): Rendered {
  switch (template) {
    case 'delivery-document': {
      const order: Locale[] = locale === 'ar' ? ['ar', 'en'] : ['en', 'ar'];
      const number = params.number ?? '';
      const html = order.map((l) => `<div dir="${l === 'ar' ? 'rtl' : 'ltr'}" lang="${l}" style="text-align:start;margin-bottom:16px">${
        DELIVERY_DOCUMENT[l].lines(params).map((line, i) => `<p${i === 2 ? ' style="font-weight:bold;color:#b91c1c"' : ''}>${escape(line)}</p>`).join('')}</div>`).join('<hr style="border:none;border-top:1px solid #e7e5e4">');
      return {
        subject: `${DELIVERY_DOCUMENT[order[0] ?? 'en'].subject(number)} · ${DELIVERY_DOCUMENT[order[1] ?? 'ar'].subject(number)}`,
        text: order.map((l) => DELIVERY_DOCUMENT[l].lines(params).join('\n\n')).join('\n\n—\n\n'),
        html: layout(locale, html),
        attachments: params.attachmentKey ? [{ filename: params.attachmentName ?? `${number}.pdf`, storageKey: params.attachmentKey, contentType: 'application/pdf' }] : [],
      };
    }
    case 'ceiling-breached': {
      const t = CEILING_BREACHED[locale];
      const lines = t.lines(params);
      return {
        subject: t.subject,
        text: lines.join('\n\n'),
        html: layout(locale, lines.map((line, i) => `<p${i === 2 ? ' style="color:#78716c;font-size:13px"' : ''}>${escape(line)}</p>`).join('')),
      };
    }
    case 'password-reset': {
      const t = PASSWORD_RESET[locale];
      const name = params.name ?? '';
      const link = params.link ?? '';
      const [greeting, body] = t.lines(name);
      return {
        subject: t.subject,
        text: `${greeting}\n\n${body}\n\n${link}\n\n${t.ignore}`,
        html: layout(locale, `<p>${escape(greeting ?? '')}</p><p>${escape(body ?? '')}</p>
<p><a href="${escape(link)}" style="display:inline-block;background:#1b4332;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px">${escape(t.button)}</a></p>
<p style="color:#78716c;font-size:13px">${escape(t.ignore)}</p>`),
      };
    }
  }
}
