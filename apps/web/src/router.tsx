import { lazy, Suspense, type ReactElement } from "react";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import Forbidden from "@/pages/Forbidden";
import NotFound from "@/pages/NotFound";
import RouteError from "@/pages/RouteError";

// Every page is a lazy chunk; only the error/forbidden/404 shells stay in the entry.
const Sources = lazy(() => import("@/pages/Sources"));
const Watches = lazy(() => import("@/pages/Watches"));
const Matches = lazy(() => import("@/pages/Matches"));
const PostDetail = lazy(() => import("@/pages/PostDetail"));
const WatchEdit = lazy(() => import("@/pages/WatchEdit"));
const Login = lazy(() => import("@/pages/Login"));
const Health = lazy(() => import("@/pages/Health"));

const lazyEl = (el: ReactElement): ReactElement => <Suspense fallback={null}>{el}</Suspense>;

export const routes: RouteObject[] = [
  { path: "/login", element: lazyEl(<Login />), errorElement: <RouteError /> },
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/matches" replace /> },
      { path: "sources", element: lazyEl(<Sources />) },
      { path: "watches", element: lazyEl(<Watches />) },
      { path: "watches/new", element: lazyEl(<WatchEdit />) },
      { path: "watches/:id", element: lazyEl(<WatchEdit />) },
      { path: "matches", element: lazyEl(<Matches />) },
      { path: "posts/:id", element: lazyEl(<PostDetail />) },
      { path: "health", element: lazyEl(<Health />) },
      { path: "403", element: <Forbidden /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
