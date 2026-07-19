/** The small shared pieces from UI-SPEC §6: badge, status dot, buttons. */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { BadgeSpec } from "../lib/badges";

export function Badge({ spec }: { spec: BadgeSpec }) {
  const cls = spec.variant === "neutral" ? "badge" : `badge ${spec.variant}`;
  return (
    <span className={cls} {...(spec.title ? { title: spec.title } : {})}>
      {spec.label}
    </span>
  );
}

/** §2.6: the dot never carries meaning alone, so `label` is not optional. */
export function StatusDot({ state, label }: { state: "ok" | "idle" | "err"; label: string }) {
  return (
    <>
      <span className={`dot ${state}`} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </>
  );
}

export type ButtonVariant = "default" | "primary" | "good";

export function Button({
  variant = "default",
  pending = false,
  small = false,
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  pending?: boolean;
  small?: boolean;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = ["btn"];
  if (variant !== "default") classes.push(variant);
  if (small) classes.push("small");
  return (
    <button type="button" className={classes.join(" ")} {...rest}>
      {pending ? <span className="pending-dot" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
