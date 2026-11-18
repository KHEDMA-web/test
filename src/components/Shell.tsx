"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  UserSearch,
  Megaphone,
  FileVideo,
  Scissors,
  CheckCircle2,
  CalendarClock,
  Settings,
} from "lucide-react";

/** La navigation suit l'ordre réel du flux : Whop → rush → montage → publication. */
const NAV = [
  { href: "/", label: "Pipeline", icon: LayoutDashboard, stage: null },
  { href: "/recruitment", label: "Recrutement", icon: UserSearch, stage: 1 },
  { href: "/campaigns", label: "Campagnes", icon: Megaphone, stage: null },
  { href: "/rushes", label: "Rushes", icon: FileVideo, stage: 2 },
  { href: "/studio", label: "Montage", icon: Scissors, stage: 3 },
  { href: "/review", label: "Validation", icon: CheckCircle2, stage: 4 },
  { href: "/publishing", label: "Publication", icon: CalendarClock, stage: 5 },
  { href: "/settings", label: "Réglages", icon: Settings, stage: null },
];

const STAGE_COLORS = ["var(--stage-1)", "var(--stage-2)", "var(--stage-3)", "var(--stage-4)", "var(--stage-5)"];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <aside
        style={{
          width: 232,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          background: "var(--bg-elevated)",
          padding: "1.25rem 0.85rem",
          position: "sticky",
          top: 0,
          height: "100vh",
          overflowY: "auto",
        }}
      >
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0 0.5rem 1.3rem" }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: "linear-gradient(135deg, var(--accent), var(--stage-4))",
              display: "grid",
              placeItems: "center",
              fontWeight: 800,
              fontSize: "0.85rem",
            }}
          >
            C
          </div>
          <div>
            <div style={{ fontWeight: 650, fontSize: "0.95rem", letterSpacing: "-0.01em" }}>ClipFlow</div>
            <div style={{ fontSize: "0.66rem", color: "var(--text-faint)" }}>du rush à la mise en ligne</div>
          </div>
        </Link>

        <nav style={{ display: "grid", gap: "0.15rem" }}>
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.6rem",
                  padding: "0.5rem 0.6rem",
                  borderRadius: 8,
                  fontSize: "0.85rem",
                  fontWeight: active ? 600 : 450,
                  color: active ? "var(--text)" : "var(--text-muted)",
                  background: active ? "#ffffff0c" : "transparent",
                  borderLeft: `2px solid ${active && item.stage ? STAGE_COLORS[item.stage - 1] : active ? "var(--accent)" : "transparent"}`,
                }}
              >
                <Icon size={16} strokeWidth={1.8} />
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.stage ? (
                  <span
                    className="mono"
                    style={{
                      fontSize: "0.6rem",
                      color: STAGE_COLORS[item.stage - 1],
                      border: `1px solid ${STAGE_COLORS[item.stage - 1]}44`,
                      borderRadius: 4,
                      padding: "0 0.25rem",
                    }}
                  >
                    {item.stage}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div
          style={{
            marginTop: "1.5rem",
            padding: "0.75rem",
            borderRadius: 9,
            background: "var(--bg-subtle)",
            border: "1px solid var(--border)",
            fontSize: "0.7rem",
            color: "var(--text-faint)",
            lineHeight: 1.5,
          }}
        >
          Le flux : <strong style={{ color: "var(--stage-1)" }}>Whop</strong> recrute,{" "}
          <strong style={{ color: "var(--stage-2)" }}>le rush</strong> est transcrit,{" "}
          <strong style={{ color: "var(--stage-3)" }}>les moments</strong> sont scorés,{" "}
          <strong style={{ color: "var(--stage-4)" }}>le clip</strong> est monté,{" "}
          <strong style={{ color: "var(--stage-5)" }}>Metricool</strong> publie.
        </div>
      </aside>

      <main style={{ flex: 1, minWidth: 0, padding: "1.8rem 2rem 4rem", maxWidth: 1480 }}>{children}</main>
    </div>
  );
}
