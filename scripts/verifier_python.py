#!/usr/bin/env python3
"""
Repère les noms utilisés mais jamais définis dans les scripts Python.

Python ne s'en plaint qu'à l'exécution de la ligne fautive. Un nom manquant
dans une branche rarement prise — un repli réseau, une gestion d'erreur —
dort donc jusqu'au jour où il saute, et s'il est avalé par un `except` large
il ressort déguisé en erreur ordinaire.

C'est exactement ce qui est arrivé : la cascade de replis du téléchargement
appelait trois noms qui n'existaient pas. Le téléchargement par lien
n'a jamais fonctionné, et l'erreur renvoyée ressemblait à un refus de
YouTube.

    python3 scripts/verifier_python.py scripts/*.py
"""
import ast
import builtins
import sys


def noms_definis(arbre: ast.Module) -> set[str]:
    """Tout ce que le module définit au niveau global."""
    out: set[str] = set()
    for noeud in arbre.body:
        if isinstance(noeud, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(noeud.name)
        elif isinstance(noeud, ast.Assign):
            for cible in noeud.targets:
                out.update(n.id for n in ast.walk(cible) if isinstance(n, ast.Name))
        elif isinstance(noeud, ast.AnnAssign) and isinstance(noeud.target, ast.Name):
            out.add(noeud.target.id)
        elif isinstance(noeud, (ast.Import, ast.ImportFrom)):
            for alias in noeud.names:
                out.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(noeud, (ast.If, ast.Try, ast.For, ast.While, ast.With)):
            # Les définitions conditionnelles comptent aussi.
            for sous in ast.walk(noeud):
                if isinstance(sous, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    out.add(sous.name)
                elif isinstance(sous, ast.Assign):
                    for cible in sous.targets:
                        out.update(n.id for n in ast.walk(cible) if isinstance(n, ast.Name))
                elif isinstance(sous, (ast.Import, ast.ImportFrom)):
                    for alias in sous.names:
                        out.add(alias.asname or alias.name.split(".")[0])
    return out


def locaux(fonction: ast.AST) -> set[str]:
    """Paramètres, variables et importations locales d'une fonction."""
    out: set[str] = set()
    args = getattr(fonction, "args", None)
    if args:
        for a in [*args.posonlyargs, *args.args, *args.kwonlyargs]:
            out.add(a.arg)
        if args.vararg:
            out.add(args.vararg.arg)
        if args.kwarg:
            out.add(args.kwarg.arg)

    for n in ast.walk(fonction):
        if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            out.add(n.id)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(n.name)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for alias in n.names:
                out.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(n, ast.ExceptHandler) and n.name:
            out.add(n.name)
        elif isinstance(n, (ast.comprehension,)):
            out.update(x.id for x in ast.walk(n.target) if isinstance(x, ast.Name))
        elif isinstance(n, ast.Global) or isinstance(n, ast.Nonlocal):
            out.update(n.names)
    return out


def verifier(chemin: str) -> list[str]:
    arbre = ast.parse(open(chemin, encoding="utf8").read(), filename=chemin)
    connus = noms_definis(arbre) | set(dir(builtins)) | {"__name__", "__file__", "__doc__"}
    manquants: list[str] = []

    for noeud in ast.walk(arbre):
        if not isinstance(noeud, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        portee = connus | locaux(noeud)
        for n in ast.walk(noeud):
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in portee:
                manquants.append(f"{chemin}:{n.lineno} : « {n.id} » est utilisé mais jamais défini")

    # Le même nom peut être signalé plusieurs fois : une ligne suffit.
    return sorted(set(manquants))


def main() -> int:
    fichiers = sys.argv[1:]
    if not fichiers:
        print("usage : python3 scripts/verifier_python.py <fichiers.py>")
        return 2

    tous: list[str] = []
    for f in fichiers:
        tous.extend(verifier(f))

    for ligne in tous:
        print(f"  ✗ {ligne}")
    if tous:
        print(f"\n✗ {len(tous)} nom(s) manquant(s) dans {len(fichiers)} fichier(s)")
        return 1
    print(f"✓ {len(fichiers)} script(s) Python : aucun nom manquant")
    return 0


if __name__ == "__main__":
    sys.exit(main())
