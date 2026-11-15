import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fw-app-shell min-h-screen lg:pl-[232px]">
      <Sidebar />
      <Topbar />
      <main className="mx-auto w-full max-w-[1680px] px-4 py-5 sm:px-6 lg:px-8">{children}</main>
      <footer className="mx-auto w-full max-w-[1680px] px-4 pb-8 pt-2 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-2 border-t border-line/50 pt-4 text-[10.5px] text-muted/70 sm:flex-row sm:items-center sm:justify-between">
          <p>
            FIREWATCH AI · LH Studios · NASA Space Apps Challenge 2026 — thermal anomalies are not
            emergency warnings.
          </p>
          <p className="font-mono">
            Detections: NASA FIRMS (MODIS C6.1, VIIRS 375 m) · Imagery: NASA EOSDIS GIBS
          </p>
        </div>
      </footer>
    </div>
  );
}
