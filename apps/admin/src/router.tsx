import { createBrowserRouter, Navigate } from "react-router-dom";
import { AdminLayout } from "./components/AdminLayout.js";
import { RequireAdminAuth } from "./components/RequireAdminAuth.js";
import { AcceptInvitePage } from "./pages/acceptInvite/AcceptInvitePage.js";
import { AdminsPage } from "./pages/admins/AdminsPage.js";
import { AdjustmentImportPage } from "./pages/adjustments/AdjustmentImportPage.js";
import { CreditsPage } from "./pages/credits/CreditsPage.js";
import { LoginPage } from "./pages/login/LoginPage.js";
import { MerchantListPage } from "./pages/merchants/MerchantListPage.js";
import { MerchantDetailPage } from "./pages/merchants/MerchantDetailPage.js";
import { SettlementPage } from "./pages/settlement/SettlementPage.js";
import { WebhookReplayPage } from "./pages/webhooks/WebhookReplayPage.js";
import { RouteErrorBoundary, RouteNotFound } from "./components/RouteFallback.js";

// MK: /v2 routes live behind VITE_ADMIN_V2 — see the admin v2 doc
export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage />, errorElement: <RouteErrorBoundary /> },
  // Public: reached from the invitation / password-reset email. No session needed.
  { path: "/accept-invite", element: <AcceptInvitePage />, errorElement: <RouteErrorBoundary /> },
  {
    // Everything below the login screen shares one shell and one guard. The
    // guard is navigation only — the API re-checks the admin session on
    // every request these pages make.
    element: (
      <RequireAdminAuth>
        <AdminLayout />
      </RequireAdminAuth>
    ),
    errorElement: <RouteErrorBoundary />,
    children: [
      { path: "/", element: <Navigate to="/merchants" replace /> },
      { path: "/merchants", element: <MerchantListPage /> },
      { path: "/merchants/:id", element: <MerchantDetailPage /> },
      { path: "/credits", element: <CreditsPage /> },
      { path: "/settlement", element: <SettlementPage /> },
      { path: "/adjustment-imports", element: <AdjustmentImportPage /> },
      { path: "/webhooks", element: <WebhookReplayPage /> },
      { path: "/webhooks/:merchantId", element: <WebhookReplayPage /> },
      { path: "/admins", element: <AdminsPage /> },
    ],
  },
  { path: "*", element: <RouteNotFound /> },
]);
