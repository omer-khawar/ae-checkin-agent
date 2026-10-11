/**
 * Console shell (UI phase 2). One 48px glass bar (`ui/app-header`): brand, nav with live
 * count badges (Worklist / Queries / Escalations / Notes), a study chip, the time-saved
 * chip, a Ctrl/Cmd+K search button, a System menu (Audit, Eval, Admin for admins) and the
 * user menu (role, Demo guide, Codes mode, sign out).
 *
 * Also mounted here for every dashboard page: the global command menu, the "?" shortcut
 * sheet, the g-then-key navigation layer and a global toast for new Tier 2/3 items.
 * Pages render into <Outlet/>; the disclaimer footer is verbatim on every page.
 */
import {
  Bell,
  Cog,
  FileText,
  Keyboard,
  ListChecks,
  LogOut,
  Phone,
  Printer,
  Search,
  ShieldAlert,
  ShieldCheck,
  StickyNote,
  Tags,
  User,
  UserRound,
  MessageSquareWarning,
  FlaskConical,
  MonitorPlay,
  Presentation,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { cn } from "@/lib/cn";
import { AppHeader, AppHeaderBrand, AppHeaderNav, AppHeaderNavItem } from "@/ui/app-header";
import { CommandMenu, type CommandMenuItem } from "@/ui/command-menu";
import { Kbd } from "@/ui/kbd";
import { notify } from "@/ui/toast";
import { Toaster } from "@/ui/toaster";
import { useCommandMenu } from "@/ui/use-command-menu";

import { getStudy } from "../lib/api";
import { ROLE_LABELS, useAuth } from "../lib/auth";
import { tierStyle } from "../lib/format";
import { briefPath } from "../lib/routes";
import { useCodesMode, useDemoGuide } from "../lib/shellPrefs";
import type { QueueItem, Study } from "../lib/types";
import { Disclaimer } from "./Disclaimer";
import { HeaderMenu, MenuRow } from "./shell/HeaderMenu";
import { MOD_KEY } from "./shell/modKey";
import { ShortcutSheet } from "./shell/ShortcutSheet";
import { itemKey, itemPath, useShellData } from "./shell/useShellData";
import { useGlobalShortcuts } from "./shell/useGlobalShortcuts";
import { TimeSavedStrip } from "./TimeSavedStrip";

const iconCls = "size-4";

function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="focus-ring transition-calm flex w-full items-start justify-between gap-3 rounded-control px-2 py-1.5 text-left hover:bg-accent"
    >
      <span>
        <span className="block text-body font-medium text-foreground">{label}</span>
        <span className="block text-caption text-muted-foreground">{hint}</span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border-strong p-0.5",
          checked ? "justify-end bg-primary" : "justify-start bg-surface-selected",
        )}
      >
        <span className="size-3.5 rounded-full bg-white shadow-elev-1" />
      </span>
      <span className="sr-only">{checked ? "On" : "Off"}</span>
    </button>
  );
}

/** Is `pathname` inside one of the given section prefixes (deep pages keep their section lit)? */
function inSection(pathname: string, prefixes: string[], exact?: string): boolean {
  if (exact !== undefined && pathname === exact) return true;
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function Layout() {
  const { auth, role, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [study, setStudy] = useState<Study | null>(null);
  const [demoGuide, setDemoGuide] = useDemoGuide();
  const [codes, setCodes] = useCodesMode();
  const palette = useCommandMenu({ slash: true });
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getStudy()
      .then((s) => {
        if (!cancelled) setStudy(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const toastNew = useCallback(
    (items: QueueItem[]) => {
      for (const i of items.slice(0, 3)) {
        const t = tierStyle(i.tier);
        const open = () => navigate(itemPath(i));
        const title = `New ${t.name.toLowerCase()} item: ${i.display_label || i.usubjid}`;
        const opts = {
          description: i.draft_status_summary || undefined,
          action: { label: "Open", onClick: open },
          id: `urgent-${itemKey(i)}`,
        };
        if (i.tier >= 3) notify.danger(title, opts);
        else notify.warning(title, opts);
      }
    },
    [navigate],
  );
  const shell = useShellData(toastNew);

  const openNextUrgent = useCallback(() => {
    if (shell.nextUrgent) navigate(shell.nextUrgent.path);
    else notify.info("No unacknowledged Tier 2 or Tier 3 items right now.", { id: "no-urgent" });
  }, [shell.nextUrgent, navigate]);

  useGlobalShortcuts({
    go: navigate,
    showHelp: () => setHelpOpen(true),
    openNextUrgent,
  });

  const signOut = () => {
    logout();
    navigate("/login");
  };

  const items = useMemo<CommandMenuItem[]>(() => {
    const go = (label: string, path: string, icon: JSX.Element, shortcut?: string[]) => ({
      id: `go-${path}`,
      label,
      group: "Go to",
      icon,
      shortcut: shortcut ? { keys: shortcut, kind: "sequence" as const } : undefined,
      onSelect: () => navigate(path),
    });
    const base: CommandMenuItem[] = [
      go("Worklist", "/dashboard", <ListChecks className={iconCls} />, ["G", "W"]),
      go("Sponsor queries", "/dashboard/queries", <MessageSquareWarning className={iconCls} />, [
        "G",
        "Q",
      ]),
      go("Escalations", "/dashboard/escalations", <ShieldAlert className={iconCls} />, ["G", "E"]),
      go("Chart notes", "/dashboard/notes", <StickyNote className={iconCls} />, ["G", "N"]),
      go("Audit trail", "/dashboard/audit", <ShieldCheck className={iconCls} />),
      go("Evaluation", "/dashboard/eval", <FlaskConical className={iconCls} />),
      go("Participant kiosk", "/kiosk", <MonitorPlay className={iconCls} />),
    ];
    if (role === "admin") base.push(go("Admin", "/admin", <Cog className={iconCls} />));
    base.push(
      {
        id: "act-next-urgent",
        label: "Open the next urgent item",
        group: "Actions",
        icon: <Bell className={iconCls} />,
        hint: shell.nextUrgent
          ? `${shell.nextUrgent.usubjid} · ${tierStyle(shell.nextUrgent.tier).name}`
          : "None waiting",
        shortcut: { keys: ["G", "U"], kind: "sequence" },
        keywords: ["urgent", "tier 3", "escalation"],
        onSelect: openNextUrgent,
      },
      {
        id: "act-log-call",
        label: "Log a call",
        group: "Actions",
        icon: <Phone className={iconCls} />,
        keywords: ["phone", "note"],
        onSelect: () => navigate("/dashboard/notes?log=call"),
      },
      {
        id: "act-codes",
        label: codes ? "Hide codes (plain language only)" : "Show codes (SDTM names, rule ids)",
        group: "Actions",
        icon: <Tags className={iconCls} />,
        keywords: ["codes", "sdtm", "rule ids"],
        onSelect: () => setCodes(!codes),
      },
      {
        id: "act-demo-guide",
        label: demoGuide ? "Turn off the Demo guide" : "Turn on the Demo guide",
        group: "Actions",
        icon: <Presentation className={iconCls} />,
        onSelect: () => setDemoGuide(!demoGuide),
      },
      {
        id: "act-shortcuts",
        label: "Keyboard shortcuts",
        group: "Actions",
        icon: <Keyboard className={iconCls} />,
        shortcut: "?",
        onSelect: () => setHelpOpen(true),
      },
    );
    for (const p of shell.participants) {
      const label = p.display_label || p.usubjid;
      base.push(
        {
          id: `participant-${p.usubjid}`,
          label: `Open ${label}`,
          group: "Participants",
          icon: <UserRound className={iconCls} />,
          hint: p.usubjid,
          keywords: [p.usubjid, label, "timeline"],
          onSelect: () => navigate(`/dashboard/participants/${encodeURIComponent(p.usubjid)}`),
        },
        {
          id: `brief-${p.usubjid}`,
          label: `Print a brief for ${label}`,
          group: "Visit briefs",
          icon: <Printer className={iconCls} />,
          hint: p.usubjid,
          keywords: [p.usubjid, label, "visit", "prep"],
          onSelect: () => navigate(briefPath(p.usubjid)),
        },
      );
    }
    return base;
  }, [
    role,
    shell.nextUrgent,
    shell.participants,
    codes,
    demoGuide,
    navigate,
    openNextUrgent,
    setCodes,
    setDemoGuide,
  ]);

  const worklistActive = inSection(
    pathname,
    ["/dashboard/checkins", "/dashboard/participants"],
    "/dashboard",
  );
  const escalationsActive = inSection(pathname, ["/dashboard/escalations", "/dashboard/packets"]);
  const queriesActive = inSection(pathname, ["/dashboard/queries"]);
  const notesActive = inSection(pathname, ["/dashboard/notes"]);

  return (
    <div
      data-surface="console"
      data-codes={codes ? "true" : undefined}
      className="flex min-h-screen flex-col bg-background font-console text-body text-foreground"
    >
      <AppHeader
        brand={
          <AppHeaderBrand asChild>
            <Link to="/dashboard">Interim</Link>
          </AppHeaderBrand>
        }
        nav={
          <AppHeaderNav label="Dashboard">
            <AppHeaderNavItem
              asChild
              active={worklistActive}
              count={shell.worklist}
              countLabel="need action"
            >
              <NavLink to="/dashboard" end>
                Worklist
              </NavLink>
            </AppHeaderNavItem>
            <AppHeaderNavItem
              asChild
              active={queriesActive}
              count={shell.queries}
              countLabel="open"
            >
              <NavLink to="/dashboard/queries">Queries</NavLink>
            </AppHeaderNavItem>
            <AppHeaderNavItem
              asChild
              active={escalationsActive}
              count={shell.escalations}
              countLabel="not acknowledged"
              urgent={shell.urgent}
            >
              <NavLink to="/dashboard/escalations">Escalations</NavLink>
            </AppHeaderNavItem>
            <AppHeaderNavItem
              asChild
              active={notesActive}
              count={shell.notes}
              countLabel="chart notes"
            >
              <NavLink to="/dashboard/notes">Notes</NavLink>
            </AppHeaderNavItem>
          </AppHeaderNav>
        }
        search={
          <button
            type="button"
            data-command-menu-trigger=""
            onClick={() => palette.setOpen(true)}
            className="focus-ring transition-calm inline-flex h-8 items-center gap-2 rounded-control border border-border-strong bg-surface/70 px-2 text-body text-muted-foreground hover:bg-surface"
          >
            <Search aria-hidden="true" className="size-4" />
            <span className="hidden min-[1800px]:inline">Search or jump to</span>
            <span className="sr-only min-[1800px]:hidden">Search</span>
            <span className="hidden items-center gap-0.5 md:inline-flex" aria-hidden="true">
              <Kbd>{MOD_KEY}</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
        }
        study={
          <HeaderMenu
            label={study ? `Study ${study.nct_id}` : "Study"}
            triggerTitle={
              study
                ? `${study.title} (public registry record)`
                : "Demo study (public registry record)"
            }
            panelLabel="Demo study"
            testId="study-chip"
            triggerClassName="border-border bg-surface/70 font-mono text-table"
            trigger={
              <>
                <FileText aria-hidden="true" className="size-4 text-muted-foreground" />
                <span>{study?.nct_id ?? "Study"}</span>
                <span className="hidden font-sans text-caption text-muted-foreground min-[1800px]:inline">
                  synthetic participants
                </span>
              </>
            }
          >
            {() => (
              <div className="p-1">
                <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                  Demo study (public registry record)
                </p>
                <p className="mt-1 font-medium text-foreground">
                  {study?.title ?? "Loading study…"}
                </p>
                {study && (
                  <a
                    href={study.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block font-mono text-table text-primary underline"
                  >
                    {study.nct_id} on ClinicalTrials.gov
                  </a>
                )}
                <p className="mt-2 text-muted-foreground">
                  {study?.participants_note ?? "All participants are synthetic."}
                </p>
              </div>
            )}
          </HeaderMenu>
        }
        actions={
          <>
            <TimeSavedStrip />
            <HeaderMenu
              panelLabel="System"
              testId="system-menu"
              panelClassName="w-48"
              trigger={
                <>
                  <Cog aria-hidden="true" className="size-4" />
                  <span className="sr-only min-[1440px]:not-sr-only">System</span>
                </>
              }
            >
              {(close) => (
                <nav aria-label="System" className="flex flex-col gap-0.5">
                  <MenuLink
                    to="/dashboard/audit"
                    onNavigate={close}
                    icon={<ShieldCheck className={iconCls} />}
                  >
                    Audit
                  </MenuLink>
                  <MenuLink
                    to="/dashboard/eval"
                    onNavigate={close}
                    icon={<FlaskConical className={iconCls} />}
                  >
                    Eval
                  </MenuLink>
                  {role === "admin" && (
                    <MenuLink to="/admin" onNavigate={close} icon={<Cog className={iconCls} />}>
                      Admin
                    </MenuLink>
                  )}
                </nav>
              )}
            </HeaderMenu>
            <HeaderMenu
              panelLabel="Account"
              testId="user-menu"
              panelClassName="w-72"
              trigger={
                <>
                  <User aria-hidden="true" className="size-4" />
                  <span className="sr-only min-[1440px]:not-sr-only min-[1440px]:max-w-[9rem] min-[1440px]:truncate">
                    {auth?.display_name ?? "—"}
                  </span>
                </>
              }
            >
              {(close) => (
                <div className="flex flex-col gap-0.5">
                  <div className="px-2 pb-1.5">
                    <p className="font-medium text-foreground">{auth?.display_name ?? "—"}</p>
                    <p className="text-caption text-muted-foreground">
                      {role ? ROLE_LABELS[role] : ""}
                    </p>
                  </div>
                  <Switch
                    checked={demoGuide}
                    onChange={setDemoGuide}
                    label="Demo guide"
                    hint="Judge-facing explanations of what each screen shows."
                  />
                  <Switch
                    checked={codes}
                    onChange={setCodes}
                    label="Codes"
                    hint="Show SDTM variable names and rule ids."
                  />
                  <MenuRow
                    onClick={() => {
                      close();
                      setHelpOpen(true);
                    }}
                  >
                    <Keyboard aria-hidden="true" className={iconCls} />
                    Keyboard shortcuts
                    <span className="ml-auto" aria-hidden="true">
                      <Kbd>?</Kbd>
                    </span>
                  </MenuRow>
                  <MenuLink
                    to="/kiosk"
                    onNavigate={close}
                    icon={<MonitorPlay className={iconCls} />}
                  >
                    Open kiosk
                  </MenuLink>
                  <MenuRow onClick={signOut}>
                    <LogOut aria-hidden="true" className={iconCls} />
                    Sign out
                  </MenuRow>
                </div>
              )}
            </HeaderMenu>
          </>
        }
      />

      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-4 outline-none xl:px-6"
      >
        <Outlet />
      </main>

      <Disclaimer />

      <CommandMenu
        open={palette.open}
        onOpenChange={palette.setOpen}
        items={items}
        groups={["Go to", "Actions", "Participants", "Visit briefs"]}
        placeholder="Jump to a page, a participant (P-007) or an action"
        title="Search and commands"
      />
      <ShortcutSheet open={helpOpen} onOpenChange={setHelpOpen} />
      <Toaster />
    </div>
  );
}

function MenuLink({
  to,
  icon,
  onNavigate,
  children,
}: {
  to: string;
  icon: JSX.Element;
  onNavigate: () => void;
  children: string;
}) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      className="focus-ring transition-calm flex h-8 w-full items-center gap-2 rounded-control px-2 text-body text-foreground no-underline hover:bg-accent"
    >
      {icon}
      {children}
    </Link>
  );
}
