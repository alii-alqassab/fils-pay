import { useCallback, useEffect, useState } from "react";
import { describeError } from "../../api/client.js";
import { approveMember, listTeam, rejectMember, updateMember, type StaffRole } from "../../api/team.js";
import { useI18n } from "../../i18n/I18nProvider.js";
import { tk } from "../../i18n/translate.js";
import type { TeamMember } from "../../types.js";

const ROLE_LABEL: Record<string, string> = { owner: tk("Owner"), finance: tk("Finance"), support: tk("Support") };
const STATUS_LABEL: Record<string, string> = {
  active: tk("Active"),
  disabled: tk("Disabled"),
  rejected: tk("Rejected"),
  pending_owner_approval: tk("Waiting"),
};

/** Owner only (the API answers 403 to everyone else): approve people who asked to join, and manage members. */
export function TeamPage() {
  const { t, formatDateTime } = useI18n();
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The role the owner picked for each waiting person (defaults to what they asked for).
  const [picked, setPicked] = useState<Record<string, StaffRole>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMembers((await listTeam()).members);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function act(userId: string, success: string, run: () => Promise<unknown>): Promise<void> {
    setBusyId(userId);
    setError(null);
    setNotice(null);
    try {
      await run();
      setNotice(success);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  const waiting = (members ?? []).filter((m) => m.status === "pending_owner_approval");
  const people = (members ?? []).filter((m) => m.status === "active" || m.status === "disabled");

  return (
    <section>
      <h1>{t("Team")}</h1>
      <p className="dash-muted">
        {t("Colleagues join with your company ID and cannot sign in until you approve them here.")}
      </p>
      {error ? <p className="dash-error" role="alert">{t(error)}</p> : null}
      {notice ? <p className="dash-notice" role="status">{notice}</p> : null}
      {loading && members === null ? <p>{t("Loading team...")}</p> : null}

      {members !== null ? (
        <>
          <h2>{t("Waiting for approval")}</h2>
          {waiting.length === 0 ? (
            <p className="dash-muted">{t("No one is waiting. New requests show up here.")}</p>
          ) : (
            <table className="dash-table">
              <thead>
                <tr><th>{t("Name")}</th><th>{t("Email")}</th><th>{t("Asked for")}</th><th>{t("Requested")}</th><th>{t("Role to give")}</th><th></th></tr>
              </thead>
              <tbody>
                {waiting.map((member) => {
                  const role = picked[member.id] ?? member.requestedRole ?? "support";
                  const busy = busyId === member.id;
                  return (
                    <tr key={member.id}>
                      <td>{member.fullName ?? "-"}</td>
                      <td dir="ltr">{member.email}</td>
                      <td>{t(ROLE_LABEL[member.requestedRole ?? "support"] ?? "Support")}</td>
                      <td>{formatDateTime(member.createdAt)}</td>
                      <td>
                        <select
                          aria-label={t("Role for {email}", { email: member.email })}
                          value={role}
                          disabled={busy}
                          onChange={(event) => setPicked({ ...picked, [member.id]: event.target.value as StaffRole })}
                        >
                          <option value="support">{t("Support")}</option>
                          <option value="finance">{t("Finance")}</option>
                        </select>
                      </td>
                      <td className="dash-actions">
                        <button type="button" className="dash-button" disabled={busy}
                          onClick={() => void act(member.id, t("{email} approved. We emailed them.", { email: member.email }), () => approveMember(member.id, role))}>
                          {t("Approve")}
                        </button>{" "}
                        <button type="button" className="dash-button" disabled={busy}
                          onClick={() => void act(member.id, t("{email} was rejected.", { email: member.email }), () => rejectMember(member.id))}>
                          {t("Reject")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <h2>{t("Members")}</h2>
          {people.length === 0 ? (
            <p className="dash-muted">{t("No members yet.")}</p>
          ) : (
            <table className="dash-table">
              <thead>
                <tr><th>{t("Name")}</th><th>{t("Email")}</th><th>{t("Role")}</th><th>{t("Status")}</th><th>{t("Joined")}</th><th></th></tr>
              </thead>
              <tbody>
                {people.map((member) => {
                  const busy = busyId === member.id;
                  const isOwner = member.role === "owner";
                  const disabled = member.status === "disabled";
                  return (
                    <tr key={member.id}>
                      <td>{member.fullName ?? "-"}</td>
                      <td dir="ltr">{member.email}</td>
                      <td>
                        {isOwner ? (
                          <span className="dash-role-chip">{t("Owner")}</span>
                        ) : (
                          <select
                            aria-label={t("Role for {email}", { email: member.email })}
                            value={member.role}
                            disabled={busy || disabled}
                            onChange={(event) =>
                              void act(member.id, t("Role for {email} changed.", { email: member.email }), () =>
                                updateMember(member.id, { role: event.target.value as StaffRole }))}
                          >
                            <option value="support">{t("Support")}</option>
                            <option value="finance">{t("Finance")}</option>
                          </select>
                        )}
                      </td>
                      <td>{STATUS_LABEL[member.status] ? t(STATUS_LABEL[member.status] as string) : member.status}</td>
                      <td>{formatDateTime(member.approvedAt ?? member.createdAt)}</td>
                      <td className="dash-actions">
                        {isOwner ? (
                          <span className="dash-muted">—</span>
                        ) : disabled ? (
                          <button type="button" className="dash-button" disabled={busy}
                            onClick={() => void act(member.id, t("{email} can sign in again.", { email: member.email }), () => updateMember(member.id, { status: "active" }))}>
                            {t("Enable")}
                          </button>
                        ) : (
                          <button type="button" className="dash-button" disabled={busy}
                            onClick={() => void act(member.id, t("{email} was disabled and signed out.", { email: member.email }), () => updateMember(member.id, { status: "disabled" }))}>
                            {t("Disable")}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </section>
  );
}
