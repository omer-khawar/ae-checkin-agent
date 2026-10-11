import { Link } from "react-router-dom";

import { Disclaimer } from "../components/Disclaimer";

export function NotFound() {
  return (
    <div data-surface="console" className="flex min-h-screen flex-col bg-background font-console">
      <main
        id="main"
        className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12 text-center"
      >
        <h1 className="text-display font-semibold text-foreground">Page not found</h1>
        <p className="mt-2 text-body text-muted-foreground">
          <Link to="/login" className="text-primary underline">
            Sign in
          </Link>{" "}
          or{" "}
          <Link to="/kiosk" className="text-primary underline">
            open the kiosk
          </Link>
          .
        </p>
      </main>
      <Disclaimer />
    </div>
  );
}
