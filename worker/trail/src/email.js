// Sends the Trail's emails through Resend (https://resend.com).
//
// Vars:    EMAIL_FROM (e.g. "Pink Lady Slipper <trail@pinkladyslipper.net>"),
//          RESEND_API_URL (optional; only tests override it)
// Secrets: RESEND_API_KEY
// Until the sending domain is verified with Resend, EMAIL_FROM can be
// "onboarding@resend.dev", which only delivers to the Resend account's owner.

export function emailEnabled(env) {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

export async function sendLinkEmail(env, { to, purpose, link }) {
  const save = purpose === 'save';
  const subject = save ? 'Save your Trail progress' : 'Restore your Trail progress';
  const action = save ? 'Save my progress' : 'Restore my progress';
  const intro = save
    ? 'Tap the button to link this email to your Trail collection. You can then get it back if you change phones or clear your browser.'
    : 'Tap the button on the phone you want your Trail collection on.';

  const text = `${intro}\n\n${action}: ${link}\n\nThis link works once and expires in 15 minutes. If you did not ask for it, you can ignore this email.\n\nPink Lady Slipper`;
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#06040f;font-family:Arial,Helvetica,sans-serif;color:#f7f2ff">
  <div style="max-width:440px;margin:0 auto">
    <h1 style="font-size:20px;margin:0 0 12px">${subject}</h1>
    <p style="line-height:1.5;color:#b8a8d6">${intro}</p>
    <p style="margin:24px 0"><a href="${link}" style="background:#f602bc;color:#10061a;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px;display:inline-block">${action}</a></p>
    <p style="font-size:13px;line-height:1.5;color:#b8a8d6">This link works once and expires in 15 minutes. If you did not ask for it, you can ignore this email.</p>
    <p style="font-size:13px;color:#b8a8d6">Pink Lady Slipper</p>
  </div>
</body></html>`;

  const res = await fetch(env.RESEND_API_URL || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html, text }),
  });
  if (!res.ok) console.error('Resend send failed', res.status, await res.text().catch(() => ''));
  return res.ok;
}
