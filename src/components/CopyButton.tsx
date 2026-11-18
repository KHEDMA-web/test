"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/** Copie un texte dans le presse-papiers, avec repli si l'API est refusée. */
export function CopyButton({
  text,
  label = "Copier",
  copiedLabel = "Copié",
  className,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      // Contexte non sécurisé ou permission refusée : on sélectionne le
      // texte pour que la copie manuelle reste possible.
      setState("error");
      setTimeout(() => setState("idle"), 3000);
    }
  }

  return (
    <button type="button" onClick={copy} className={cn("btn", className)}>
      {state === "copied" ? <Check size={14} /> : <Copy size={14} />}
      {state === "copied" ? copiedLabel : state === "error" ? "Copie refusée — sélectionnez le texte" : label}
    </button>
  );
}
