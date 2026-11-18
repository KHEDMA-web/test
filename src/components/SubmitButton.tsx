"use client";

import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";

/** Bouton de formulaire qui affiche son propre état d'envoi. */
export function SubmitButton({
  children,
  pendingLabel,
  className,
  title,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
  title?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={cn("btn", className)} title={title}>
      {pending ? (pendingLabel ?? "En cours…") : children}
    </button>
  );
}
