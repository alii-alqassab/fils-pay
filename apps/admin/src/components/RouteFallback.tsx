import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router-dom";
import { useI18n } from "../i18n/I18nProvider.js";
import { LanguageToggle } from "../i18n/LanguageToggle.js";
import { tk } from "../i18n/translate.js";

interface ErrorDetails {
  code: string;
  title: string;
  description: string;
  actionLabel: string;
  actionHref: string;
  /** Drives the badge colour: "warn" = fixable by you, "bad" = service side. */
  tone: "warn" | "bad";
}

const NOT_FOUND: ErrorDetails = {
  code: "404",
  title: tk("That admin page doesn’t exist"),
  description: tk("The address may be mistyped, or the page may have moved."),
  actionLabel: "Back to admin console",
  actionHref: "/",
  tone: "warn",
};

function statusFromError(error: unknown): number | null {
  if (isRouteErrorResponse(error)) return error.status;
  if (error && typeof error === "object" && "statusCode" in error) {
    const statusCode = error.statusCode;
    if (typeof statusCode === "number") return statusCode;
  }
  return null;
}

function detailsForError(error: unknown): ErrorDetails {
  const status = statusFromError(error);
  if (status === 401) {
    return {
      code: "401",
      title: tk("Your admin session ended"),
      description: tk("Admin sessions expire after a period of inactivity or when the session is revoked."),
      tone: "warn",
      actionLabel: "Sign in again",
      actionHref: "/login",
    };
  }
  if (status === 403) {
    return {
      code: "403",
      title: tk("Access denied"),
      description: tk("Your admin role does not allow this action or page."),
      tone: "warn",
      actionLabel: "Back to admin console",
      actionHref: "/",
    };
  }
  if (status === 404) return NOT_FOUND;
  if (status !== null && status >= 500) {
    return {
      code: String(status),
      title: tk("The admin service is having trouble"),
      description: tk("This page couldn’t load right now. The service returned an error."),
      tone: "bad",
      actionLabel: "Back to admin console",
      actionHref: "/",
    };
  }
  if (error instanceof TypeError) {
    return {
      code: "OFFLINE",
      title: tk("Can’t reach the admin service"),
      description: tk("The request never reached the service, which usually means a connection problem."),
      tone: "warn",
      actionLabel: "Back to admin console",
      actionHref: "/",
    };
  }
  return {
    code: "ERROR",
    title: tk("This page could not be loaded"),
    description: tk("Something unexpected happened while loading this page."),
    tone: "bad",
    actionLabel: "Back to admin console",
    actionHref: "/",
  };
}

function ErrorPage({ details }: { details: ErrorDetails }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  return (
    <main className="admin-centered admin-error-page" aria-labelledby="admin-error-title">
      <LanguageToggle className="admin-lang-fixed" />
      <div className="admin-error-art" aria-hidden="true">
        <span className="admin-error-card admin-error-card-a" />
        <span className="admin-error-card admin-error-card-c" />
        <span className="admin-error-card admin-error-card-b">
          <b className="admin-error-mark">!</b>
        </span>
        <span className="admin-error-spark admin-error-spark-1" />
        <span className="admin-error-spark admin-error-spark-2" />
        <span className="admin-error-spark admin-error-spark-3" />
      </div>
      <p className={`admin-error-code admin-error-code-${details.tone}`} aria-label={`Error ${details.code}`}>
        {details.code}
      </p>
      <h1 id="admin-error-title">{t(details.title)}</h1>
      <p className="admin-error-description">{t(details.description)}</p>
      <div className="admin-error-actions">
        <button
          className="admin-error-primary"
          type="button"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate(details.actionHref))}
        >
          {t("← Go back")}
        </button>
      </div>
    </main>
  );
}

export function RouteErrorBoundary() {
  return <ErrorPage details={detailsForError(useRouteError())} />;
}

export function RouteNotFound() {
  return <ErrorPage details={NOT_FOUND} />;
}
