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
  /** Drives the badge colour: "warn" = fixable by you, "bad" = our side. */
  tone: "warn" | "bad";
}

const NOT_FOUND: ErrorDetails = {
  code: "404",
  title: tk("We couldn’t find that page"),
  description: tk("The address may be mistyped, or the page may have moved or been removed."),
  actionLabel: "Go to FilsPay",
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
      title: tk("Your session ended"),
      description: tk("For your security we sign you out after a period of inactivity, or when you sign in elsewhere."),
      tone: "warn",
      actionLabel: "Sign in again",
      actionHref: "/dashboard/login",
    };
  }
  if (status === 403) {
    return {
      code: "403",
      title: tk("You don’t have access to this page"),
      description: tk("Your account role doesn’t include the permission this page requires."),
      tone: "warn",
      actionLabel: "Back to dashboard",
      actionHref: "/dashboard",
    };
  }
  if (status === 404) return NOT_FOUND;
  if (status !== null && status >= 500) {
    return {
      code: String(status),
      title: tk("FilsPay is having trouble"),
      description: tk("This one’s on us — the page couldn’t load right now. Your data is safe."),
      tone: "bad",
      actionLabel: "Return to FilsPay",
      actionHref: "/",
    };
  }
  if (error instanceof TypeError) {
    return {
      code: "OFFLINE",
      title: tk("Can’t reach FilsPay"),
      description: tk("The request never made it through, which usually means a connection problem."),
      tone: "warn",
      actionLabel: "Return to FilsPay",
      actionHref: "/",
    };
  }
  return {
    code: "ERROR",
    title: tk("This page could not be loaded"),
    description: tk("Something unexpected happened while loading this page."),
    tone: "bad",
    actionLabel: "Back to dashboard",
    actionHref: "/dashboard",
  };
}

function ErrorPage({ details }: { details: ErrorDetails }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  return (
    <main className="dash-centered dash-error-page" aria-labelledby="dash-error-title">
      <LanguageToggle className="dash-button dash-lang-fixed" />
      <div className="dash-error-art" aria-hidden="true">
        <span className="dash-error-card dash-error-card-a" />
        <span className="dash-error-card dash-error-card-c" />
        <span className="dash-error-card dash-error-card-b">
          <b className="dash-error-mark">!</b>
        </span>
        <span className="dash-error-spark dash-error-spark-1" />
        <span className="dash-error-spark dash-error-spark-2" />
        <span className="dash-error-spark dash-error-spark-3" />
      </div>
      <p className={`dash-error-code dash-error-code-${details.tone}`} aria-label={`Error ${details.code}`}>
        {details.code}
      </p>
      <h1 id="dash-error-title">{t(details.title)}</h1>
      <p className="dash-error-description">{t(details.description)}</p>
      <div className="dash-error-actions">
        <button
          className="dash-error-primary"
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
