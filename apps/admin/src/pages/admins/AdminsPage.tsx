import { useCallback, useEffect, useState } from "react";
import {
  inviteAdmin,
  listAdminAccounts,
  resendInvite,
  revokeInvite,
  sendAdminReset,
  updateAdminAccount,
} from "../../api/adminAccounts.js";
import { ApiError, describeError } from "../../api/client.js";
import { useAdminAuth } from "../../auth/AdminAuthContext.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { label } from "../../i18n/labels.js";
import { tk } from "../../i18n/translate.js";
import type { AdminAccount, AdminInvite, AssignableAdminRole } from "../../types.js";

const ROLES: AssignableAdminRole[] = ["support", "finance", "super_admin"];

/** Same text everywhere an email-sending call can fail. */
function describeMailAwareError(err: unknown): string {
  if (err instanceof ApiError && err.statusCode === 503 && err.code === "email_delivery_unavailable") {
    return tk("Email could not be sent: check mail settings.");
  }
  return describeError(err);
}

/**
 * Admin accounts: master only. Invite people (they receive a one-time link
 * and choose their own password), change roles, disable or re-enable, and
 * send password resets. The master row itself is read-only. The route
 * gates are server-side (`requireMaster`); the nav item and this page's
 * redirect are convenience only.
 */
export function AdminsPage() {
  const { admin: me } = useAdminAuth();
  const { t, formatDateTime } = useI18n();
  const [admins, setAdmins] = useState<AdminAccount[]>([]);
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<AssignableAdminRole>("support");
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await listAdminAccounts();
      setAdmins(data.admins ?? []);
      setInvites(data.invites ?? []);
    } catch (err) {
      setLoadError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(id: string, action: () => Promise<string>): Promise<void> {
    setBusyId(id);
    setActionError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await load();
    } catch (err) {
      setActionError(describeMailAwareError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleInvite(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setInviting(true);
    setActionError(null);
    setNotice(null);
    try {
      const { invite } = await inviteAdmin({ email: email.trim(), displayName: displayName.trim(), role });
      setNotice(t("Invitation emailed to {email}", { email: invite.email }));
      setEmail("");
      setDisplayName("");
      setRole("support");
      await load();
    } catch (err) {
      setActionError(describeMailAwareError(err));
    } finally {
      setInviting(false);
    }
  }

  if (me && me.role !== "master") {
    return (
      <section>
        <h1>{t("Admin accounts")}</h1>
        <p className="admin-error">{t("Only the master administrator can manage admin accounts.")}</p>
      </section>
    );
  }

  return (
    <section>
      <h1>{t("Admin accounts")}</h1>
      <p className="admin-muted">
        {t("Invite colleagues by email. They choose their own password through a one-time link (valid 48 hours) and sign in with an emailed code. The master account cannot be changed here.")}
      </p>

      {loadError ? <p className="admin-error">{t(loadError)}</p> : null}
      {actionError ? <p className="admin-error">{t(actionError)}</p> : null}
      {notice ? <p className="admin-notice">{notice}</p> : null}

      <h2>{t("Invite admin")}</h2>
      <form onSubmit={(e) => void handleInvite(e)} className="admin-form">
        <label>
          {t("Email")}
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          {t("Name")}
          <input
            type="text"
            required
            maxLength={100}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <label>
          {t("Role")}
          <select value={role} onChange={(e) => setRole(e.target.value as AssignableAdminRole)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {label(t, r)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={inviting}>
          {inviting ? t("Sending...") : t("Send invitation")}
        </button>
      </form>

      <h2>{t("Admins")}</h2>
      {loading ? (
        <p className="admin-muted">{t("Loading...")}</p>
      ) : admins.length === 0 ? (
        <p className="admin-muted">{t("No admins.")}</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("Email")}</th>
              <th>{t("Name")}</th>
              <th>{t("Role")}</th>
              <th>{t("Status")}</th>
              <th>{t("Created")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {admins.map((a) => {
              const locked = a.role === "master" || a.id === me?.adminUserId;
              const busy = busyId === a.id;
              return (
                <tr key={a.id}>
                  <td dir="ltr">{a.email}</td>
                  <td>{a.displayName}</td>
                  <td>
                    {locked ? (
                      <span className="admin-role-chip">{label(t, a.role)}</span>
                    ) : (
                      <select
                        className="admin-role-select"
                        aria-label={t("Role for {email}", { email: a.email })}
                        value={a.role}
                        disabled={busy}
                        onChange={(e) => {
                          const next = e.target.value as AssignableAdminRole;
                          void run(a.id, async () => {
                            await updateAdminAccount(a.id, { role: next });
                            return t("{email} is now {role}.", { email: a.email, role: label(t, next) });
                          });
                        }}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {label(t, r)}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td>{label(t, a.status)}</td>
                  <td>{formatDateTime(a.createdAt)}</td>
                  <td>
                    {locked ? null : (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            const next = a.status === "active" ? "disabled" : "active";
                            void run(a.id, async () => {
                              await updateAdminAccount(a.id, { status: next });
                              return next === "disabled"
                                ? t("{email} disabled and signed out everywhere.", { email: a.email })
                                : t("{email} enabled.", { email: a.email });
                            });
                          }}
                        >
                          {a.status === "active" ? t("Disable") : t("Enable")}
                        </button>{" "}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(a.id, async () => {
                              await sendAdminReset(a.id);
                              return t("Password reset link emailed to {email}", { email: a.email });
                            })
                          }
                        >
                          {t("Send password reset")}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2>{t("Pending invitations")}</h2>
      {invites.length === 0 ? (
        <p className="admin-muted">{t("No pending invitations.")}</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("Email")}</th>
              <th>{t("Name")}</th>
              <th>{t("Role")}</th>
              <th>{t("Type")}</th>
              <th>{t("Expires")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invites.map((i) => (
              <tr key={i.id}>
                <td dir="ltr">{i.email}</td>
                <td>{i.displayName}</td>
                <td>{i.purpose === "reset" ? "-" : label(t, i.role)}</td>
                <td>{i.purpose === "reset" ? t("password reset") : t("invitation")}</td>
                <td>
                  {formatDateTime(i.expiresAt)}
                  {i.status === "expired" ? ` ${t("(expired)")}` : ""}
                </td>
                <td>
                  <button
                    type="button"
                    disabled={busyId === i.id}
                    onClick={() =>
                      void run(i.id, async () => {
                        await resendInvite(i.id);
                        return t("Invitation emailed to {email}", { email: i.email });
                      })
                    }
                  >
                    {t("Resend")}
                  </button>{" "}
                  <button
                    type="button"
                    disabled={busyId === i.id}
                    onClick={() =>
                      void run(i.id, async () => {
                        await revokeInvite(i.id);
                        return t("Invitation for {email} revoked.", { email: i.email });
                      })
                    }
                  >
                    {t("Revoke")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
