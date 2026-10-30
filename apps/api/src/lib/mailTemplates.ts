import type { MailMessage } from "./mail.js";

/**
 * Plain, short email bodies (text plus a minimal HTML copy). User-supplied
 * values (names, notes) are HTML-escaped in the HTML part.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Brand tokens, the same palette as the dashboard and checkout (see web/src/dashboard.css).
const INK = "#241a1a";
const INK_SOFT = "#6a5a56";
const CORAL = "#ff4b47";
const CREAM = "#f3e9d6";
const PAPER = "#fffaf0";
const BUTTER = "#ffd45e";
const FONT_DISPLAY = `'Bricolage Grotesque','Trebuchet MS','Arial Black',Arial,sans-serif`;
const FONT_SANS = `'DM Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif`;
const FONT_MONO = `'DM Mono',ui-monospace,Menlo,Consolas,'Courier New',monospace`;

/** A big one-time code in a butter-yellow dashed box. `code` must already be escaped. */
function codeBox(code: string): string {
  return (
    `<div style="margin:6px 0 4px;padding:18px 12px;text-align:center;background:${BUTTER};` +
    `border:2px dashed ${INK};border-radius:12px">` +
    `<span style="font-family:${FONT_MONO};font-size:34px;font-weight:700;letter-spacing:10px;color:${INK};` +
    `padding-left:10px">${code}</span></div>`
  );
}

/** A chunky coral button, ink outline with a thicker bottom edge for the "pop" look. `label`/`url` must already be escaped. */
function button(label: string, url: string): string {
  return (
    `<div style="margin:8px 0 4px"><a href="${url}" style="display:inline-block;padding:13px 26px;` +
    `background:${CORAL};color:${INK};font-family:${FONT_DISPLAY};font-size:16px;font-weight:800;` +
    `text-decoration:none;border:2px solid ${INK};border-bottom-width:5px;border-radius:12px">${label}</a></div>`
  );
}

/**
 * The FilsPay email frame: coral header with the wordmark and a coin, a paper card with an ink outline,
 * and a quiet footer. Table-based with inline styles so it holds up in Gmail, Outlook and Apple Mail;
 * `paragraphsHtml` entries are trusted HTML (callers escape user values).
 */
function wrap(heading: string, paragraphsHtml: string[], footer = "FilsPay", preheader = ""): string {
  const body = paragraphsHtml
    .map((p) => `<div style="font-size:16px;line-height:1.55;margin:0 0 14px;color:${INK}">${p}</div>`)
    .join("");
  return (
    `<!doctype html><html><body style="margin:0;padding:0;background:${CREAM}">` +
    (preheader
      ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CREAM}">${esc(preheader)}</div>`
      : "") +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};padding:28px 12px">` +
    `<tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${PAPER};` +
    `border:2px solid ${INK};border-bottom-width:6px;border-right-width:6px;border-radius:16px;overflow:hidden;font-family:${FONT_SANS}">` +
    // header
    `<tr><td style="background:${CORAL};padding:22px 26px;border-bottom:2px solid ${INK}">` +
    `<table role="presentation" cellpadding="0" cellspacing="0"><tr>` +
    `<td style="padding-right:12px"><div style="width:44px;height:44px;line-height:40px;text-align:center;border-radius:50%;` +
    `background:${BUTTER};border:2px solid ${INK};font-family:${FONT_DISPLAY};font-weight:800;font-size:15px;color:${INK}">&#1601;&#1604;&#1587;</div></td>` +
    `<td><div style="font-family:${FONT_DISPLAY};font-size:28px;font-weight:800;color:${INK};letter-spacing:-0.5px">FilsPay</div>` +
    `<div style="font-family:${FONT_MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${INK}">Payments for Bahrain</div></td>` +
    `</tr></table></td></tr>` +
    // content
    `<tr><td style="padding:28px 26px 8px">` +
    `<h1 style="margin:0 0 16px;font-family:${FONT_DISPLAY};font-size:26px;line-height:1.2;font-weight:800;color:${INK}">${esc(heading)}</h1>` +
    body +
    `</td></tr>` +
    // footer
    `<tr><td style="padding:14px 26px 22px"><div style="border-top:2px dashed ${INK};padding-top:14px;` +
    `font-family:${FONT_MONO};font-size:11px;line-height:1.6;color:${INK_SOFT}">${esc(footer)}</div></td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

export function otpEmail(to: string, code: string, audience: "merchant" | "admin", ttlMinutes = 5): MailMessage {
  const who = audience === "admin" ? "admin console" : "FilsPay dashboard";
  return {
    to,
    subject: `${code} is your FilsPay sign-in code`,
    text:
      `Your FilsPay ${who} verification code is ${code}.\n\n` +
      `It expires in ${ttlMinutes} minutes. Never share this code with anyone; FilsPay staff will never ask for it.\n` +
      `If you did not try to sign in, you can ignore this email.`,
    html: wrap(
      `Your sign-in code`,
      [
        `Use this code to finish signing in to the ${esc(who)}:`,
        codeBox(esc(code)),
        `It expires in <b>${ttlMinutes} minutes</b>. Never share it with anyone; FilsPay staff will never ask for it.`,
        `<span style="color:${INK_SOFT}">If you did not try to sign in, you can safely ignore this email.</span>`,
      ],
      "FilsPay · Sign-in security. This code can only be used once.",
      `${code} is your FilsPay sign-in code`,
    ),
  };
}

export function adminInviteEmail(
  to: string,
  input: { displayName: string; role: string; link: string; hours: number; purpose: "invite" | "reset" },
): MailMessage {
  const reset = input.purpose === "reset";
  const subject = reset ? "Reset your FilsPay admin password" : "You have been invited to the FilsPay admin console";
  const lead = reset
    ? `The master administrator sent you a password reset for the FilsPay admin console.`
    : `The master administrator created an admin account for you (role: ${input.role}).`;
  return {
    to,
    subject,
    text:
      `Hello ${input.displayName},\n\n${lead}\n\n` +
      `Choose your password here (the link works once and expires in ${input.hours} hours):\n${input.link}\n\n` +
      `If you were not expecting this, ignore this email.`,
    html: wrap(
      reset ? "Reset your admin password" : "Welcome to the admin console",
      [
        `Hello ${esc(input.displayName)},`,
        esc(lead),
        button(reset ? "Choose a new password" : "Choose your password", esc(input.link)),
        `The link works <b>once</b> and expires in ${input.hours} hours.`,
        `<span style="color:${INK_SOFT}">If the button does not work, copy this address into your browser:<br>` +
          `<span style="font-family:${FONT_MONO};font-size:12px;word-break:break-all">${esc(input.link)}</span></span>`,
        `<span style="color:${INK_SOFT}">If you were not expecting this, ignore this email.</span>`,
      ],
      "FilsPay · Admin console. Nobody at FilsPay will ask you for your password.",
      subject,
    ),
  };
}

export function companyApprovedEmail(
  to: string,
  input: { ownerName: string; companyName: string; companyCode: string; dashboardUrl: string },
): MailMessage {
  return {
    to,
    subject: `${input.companyName} was approved on FilsPay`,
    text:
      `Good news: ${input.companyName} has been approved.\n\n` +
      `Your company ID is: ${input.companyCode}\n\n` +
      `Share this ID only with colleagues you trust. They use it on the "Join a company" page (${input.dashboardUrl}/dashboard/join) ` +
      `and you approve each person yourself under Team in the dashboard.`,
    html: wrap(`${input.companyName} was approved`, [
      `Hello ${esc(input.ownerName)}, your company has been approved.`,
      `Your company ID:`,
      codeBox(esc(input.companyCode)),
      `Share it only with colleagues you trust. They use it on the <a href="${esc(input.dashboardUrl)}/dashboard/join">Join a company</a> page, and you approve each person yourself under <b>Team</b>.`,
    ]),
  };
}

export function companyRejectedEmail(to: string, input: { companyName: string; notes?: string | null }): MailMessage {
  const note = input.notes?.trim() ? `\n\nReviewer note: ${input.notes.trim()}` : "";
  return {
    to,
    subject: `${input.companyName}: registration was not approved`,
    text: `We could not approve ${input.companyName} at this time.${note}\n\nYou can contact FilsPay support to correct the details.`,
    html: wrap(`Registration not approved`, [
      `We could not approve <b>${esc(input.companyName)}</b> at this time.`,
      ...(input.notes?.trim() ? [`Reviewer note: ${esc(input.notes.trim())}`] : []),
      `You can contact FilsPay support to correct the details.`,
    ]),
  };
}

export function joinRequestEmail(
  to: string,
  input: { ownerName: string; companyName: string; staffName: string; staffEmail: string; role: string; teamUrl: string },
): MailMessage {
  return {
    to,
    subject: `${input.staffName} wants to join ${input.companyName}`,
    text:
      `${input.staffName} (${input.staffEmail}) asked to join ${input.companyName} as ${input.role}.\n\n` +
      `Review the request under Team: ${input.teamUrl}\nThey cannot sign in until you approve them. If you do not know this person, reject the request.`,
    html: wrap(`Join request`, [
      `<b>${esc(input.staffName)}</b> (${esc(input.staffEmail)}) asked to join <b>${esc(input.companyName)}</b> as <b>${esc(input.role)}</b>.`,
      button("Review the request", esc(input.teamUrl)),
      `They cannot sign in until you approve them. If you do not know this person, reject the request.`,
    ]),
  };
}

export function joinDecisionEmail(
  to: string,
  input: { staffName: string; companyName: string; approved: boolean; role?: string; loginUrl: string },
): MailMessage {
  return input.approved
    ? {
        to,
        subject: `You can now sign in to ${input.companyName}`,
        text: `Hello ${input.staffName}, the owner of ${input.companyName} approved your request (role: ${input.role}).\nSign in: ${input.loginUrl}`,
        html: wrap(`Request approved`, [
          `Hello ${esc(input.staffName)}, the owner of <b>${esc(input.companyName)}</b> approved your request (role: ${esc(input.role ?? "")}).`,
          button("Sign in", esc(input.loginUrl)),
        ]),
      }
    : {
        to,
        subject: `Your request to join ${input.companyName} was declined`,
        text: `Hello ${input.staffName}, the owner of ${input.companyName} declined your request to join.`,
        html: wrap(`Request declined`, [
          `Hello ${esc(input.staffName)}, the owner of <b>${esc(input.companyName)}</b> declined your request to join.`,
        ]),
      };
}
