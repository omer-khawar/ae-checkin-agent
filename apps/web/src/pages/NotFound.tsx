import { Link } from "react-router-dom";

import { Disclaimer } from "../components/Disclaimer";

export function NotFound() {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12 text-center">
        <h1 className="text-2xl font-bold text-slate-900">Page not found</h1>
        <p className="mt-2 text-slate-600">
          <Link to="/login" className="text-brand-700 underline">
            Sign in
          </Link>{" "}
          or{" "}
          <Link to="/kiosk" className="text-brand-700 underline">
            open the kiosk
          </Link>
          .
        </p>
      </main>
      <Disclaimer />
    </div>
  );
}
